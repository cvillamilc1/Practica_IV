'use strict';
/*
 * Pruebas end-to-end: ejecuta public/index.html (con sus scripts reales) dentro de jsdom,
 * conectado al servidor Express y a PostgreSQL reales. No simula la base de datos.
 * Ejecutar:  npm run test:frontend      (requiere db:schema + seed:admins)
 */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { app, pool } = require('../server');
const dx = require('../lib/diagnostico');

const ADMIN_PASS = process.env.ADMIN_CRISTIAN_PASSWORD;
const SUF = Date.now().toString(36);
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ORIGINAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'Codigo_practicaV6.original.html'), 'utf8');
let base, servidor;

const dormir = ms => new Promise(r => setTimeout(r, ms));
async function esperar(fn, msg, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Tiempo agotado esperando: ' + msg);
    await dormir(25);
  }
}

/* Un "navegador": jsdom + jar de cookies compartido entre cargas de página */
class Pagina {
  constructor(jar = { cookie: '' }, html = HTML) { this.jar = jar; this.html = html; this.errores = []; this.fallaRed = false; }
  async abrir() {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => this.errores.push(String(e.detail || e.message || e)));
    const self = this;
    this.dom = new JSDOM(this.html, {
      url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        w.fetch = async (url, o = {}) => {
          if (self.fallaRed) throw new TypeError('Failed to fetch');
          const r = await fetch(new URL(url, base), { ...o, headers: { ...(o.headers || {}), ...(self.jar.cookie ? { Cookie: self.jar.cookie } : {}) } });
          (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => {
            if (/^sid=;/.test(c) || /Expires=Thu, 01 Jan 1970/.test(c)) self.jar.cookie = '';
            else self.jar.cookie = c.split(';')[0];
          });
          return r;
        };
        w.TextEncoder = TextEncoder;                       // el HTML original (hash SHA-256 en el navegador) lo necesita
        Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true });
        w.Element.prototype.scrollIntoView = () => {};
        w.scrollTo = () => {};
        w.addEventListener('error', e => self.errores.push(String(e.message)));
      }
    });
    this.w = this.dom.window; this.d = this.w.document;
    return this;
  }
  $(s) { return this.d.querySelector(s); }
  $$(s) { return [...this.d.querySelectorAll(s)]; }
  click(s) { const e = this.$(s); assert.ok(e, 'no existe ' + s); e.click(); }
  escribir(s, v) { const e = this.$(s); assert.ok(e, 'no existe ' + s); e.value = v; }
  eval(c) { return this.w.eval(c); }
  toasts() { return this.$$('.toast').map(t => t.textContent); }
  limpiarToasts() { this.$$('.toast').forEach(t => t.remove()); }
  async toast(texto) { return esperar(() => this.toasts().find(t => t.includes(texto)), `toast "${texto}" (hay: ${JSON.stringify(this.toasts())})`); }
  async cerrar() {
    // Espera a que termine cualquier guardado de progreso en vuelo antes de destruir la ventana
    try { await esperar(() => this.w.eval('typeof marcandoModulos === "undefined" || marcandoModulos.size === 0'), 'guardados pendientes', 3000); } catch (_) {}
    await dormir(50);
    this.w.close();
  }
}

async function login(p, usuario, pass) {
  await esperar(() => p.$('#loginUsuario'), 'pantalla de login');
  p.escribir('#loginUsuario', usuario); p.escribir('#loginPass', pass);
  p.click('#btnIniciarSesion');
}
const respuestasHtml = (p, resp) => Object.entries(resp).forEach(([i, v]) => { p.$(`input[name="diag${i}"][value="${v}"]`).checked = true; });

test.before(async () => {
  assert.ok(ADMIN_PASS, 'Define ADMIN_CRISTIAN_PASSWORD');
  await new Promise(r => { servidor = app.listen(0, r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(async () => {
  await pool.query(`DELETE FROM usuarios WHERE usuario LIKE 'f\\_%'`);
  await new Promise(r => servidor.close(r));
  await pool.end();
});

test('F0. Regresión: los 9 módulos se renderizan IDÉNTICOS al original', async () => {
  const stub = `sesion = { id: 1, nombre: "Prueba", usuario: "Prueba", rol: "Administrador" };
                usuarios = [{ id: 1, nombre: "Prueba", usuario: "Prueba", rol: "Administrador", protegido: true, progreso: [] }];
                cartillaNombre = null;`;
  const orig = await new Pagina({ cookie: '' }, ORIGINAL).abrir();
  const nuevo = await new Pagina().abrir();
  await esperar(() => orig.$('#loginUsuario') && nuevo.$('#loginUsuario'), 'carga inicial de ambas');
  // Sustituye el servidor por un doble que se comporta igual (acumula módulos vistos) para comparar sólo el renderizado
  nuevo.eval('Api.post = async (u, c) => { const me = usuarios.find(x => x.id === 1); return { ok: true, progreso: [...new Set([...me.progreso, c.modulo])] }; };');
  orig.eval(stub); nuevo.eval(stub);
  for (const m of dx.MODULOS) {
    orig.eval(`irAModulo("${m}")`); nuevo.eval(`irAModulo("${m}")`);
    await dormir(15);   // la versión nueva registra el progreso al confirmarlo el servidor (asíncrono)
    nuevo.eval('render()'); orig.eval('render()');
    const a = orig.$('#contenidoModulo').innerHTML, b = nuevo.$('#contenidoModulo').innerHTML;
    assert.ok(a.length > 500, `${m} vacío en el original`);
    assert.equal(b, a, `El contenido de ${m} difiere del original`);
  }
  // Panel de estadísticas, dashboard y sidebar también idénticos
  for (const v of ['dashboard', 'estadisticas']) {
    orig.eval(`vista="${v}"; render()`); nuevo.eval(`vista="${v}"; render()`);
    assert.equal(nuevo.$('#app').innerHTML, orig.$('#app').innerHTML, `La vista ${v} difiere`);
  }
  // Pantallas de login y registro
  for (const v of ['login', 'registro']) {
    orig.eval(`sesion=null; vista="${v}"; render()`); nuevo.eval(`sesion=null; vista="${v}"; render()`);
    assert.equal(nuevo.$('#app').innerHTML, orig.$('#app').innerHTML, `La pantalla ${v} difiere`);
  }
  // Las hojas de estilo son idénticas
  const css = h => h.match(/<style>[\s\S]*?<\/style>/)[0];
  assert.equal(css(HTML), css(ORIGINAL));
  assert.deepEqual(nuevo.errores, []); await orig.cerrar(); await nuevo.cerrar();
});

test('F1-F3. Registro desde la interfaz (credenciales de admin verificadas en el servidor) y login fallido', async () => {
  const p = await new Pagina().abrir();
  await esperar(() => p.$('#loginUsuario'), 'login');
  // Login incorrecto
  await login(p, 'nadie', 'mala'); await p.toast('Usuario o contraseña incorrectos');
  assert.ok(p.$('#loginUsuario'), 'sigue en el login');
  // Ir al registro
  p.click('#btnIrRegistro'); await esperar(() => p.$('#regNombre'), 'registro');
  // Con clave de admin errónea
  p.escribir('#adminUsuario', 'Cristian'); p.escribir('#adminPass', 'incorrecta');
  p.escribir('#regNombre', 'Fabi Estudiante'); p.escribir('#regUsuario', `f_fabi_${SUF}`); p.escribir('#regPass', 'fabi1234');
  p.limpiarToasts(); p.click('#btnRegistrar'); await p.toast('Acceso denegado');
  assert.equal((await pool.query('SELECT 1 FROM usuarios WHERE usuario=$1', [`f_fabi_${SUF}`])).rowCount, 0);
  // Con clave correcta
  p.escribir('#adminPass', ADMIN_PASS); p.limpiarToasts(); p.click('#btnRegistrar');
  await p.toast('Éxito');
  const { rows } = await pool.query('SELECT nombre, rol, password_hash FROM usuarios WHERE usuario=$1', [`f_fabi_${SUF}`]);
  assert.equal(rows.length, 1); assert.equal(rows[0].rol, 'Usuario'); assert.match(rows[0].password_hash, /^\$2/);
  await esperar(() => p.$('#loginUsuario'), 'vuelve al login');
  // Duplicado
  p.click('#btnIrRegistro'); await esperar(() => p.$('#regNombre'), 'registro');
  p.escribir('#adminUsuario', 'Cristian'); p.escribir('#adminPass', ADMIN_PASS);
  p.escribir('#regNombre', 'Otra'); p.escribir('#regUsuario', `F_FABI_${SUF}`.toLowerCase()); p.escribir('#regPass', 'xxxx1234');
  p.limpiarToasts(); p.click('#btnRegistrar'); await p.toast('El usuario ya existe');
  assert.deepEqual(p.errores, []); await p.cerrar();
});

test('F4-F10. Flujo completo del estudiante: bloqueo, diagnóstico, progreso, cierre de sesión y persistencia', async () => {
  const jar = { cookie: '' };
  const p = await new Pagina(jar).abrir();
  await login(p, `f_fabi_${SUF}`, 'fabi1234');
  await p.toast('Diagnóstico pendiente');
  await esperar(() => p.$('#btnComenzarDiagnostico'), 'dashboard del estudiante con puerta de diagnóstico');
  const uid = (await pool.query('SELECT id FROM usuarios WHERE usuario=$1', [`f_fabi_${SUF}`])).rows[0].id;

  // Módulos bloqueados
  p.limpiarToasts(); p.eval('irAModulo("mod3")'); await p.toast('Módulo bloqueado');
  assert.equal((await pool.query('SELECT count(*)::int n FROM progreso_modulos WHERE usuario_id=$1 AND modulo_id=\'mod3\'', [uid])).rows[0].n, 0);

  // Intentar finalizar con preguntas sin responder
  p.eval('irAlDiagnostico()');
  await esperar(() => p.$('#btnCalificarDiag'), 'formulario del diagnóstico');
  assert.equal(p.$$('.quiz-item').length, 14);
  p.limpiarToasts(); p.click('#btnCalificarDiag'); await p.toast('Diagnóstico incompleto');
  assert.equal((await pool.query('SELECT count(*)::int n FROM diagnostico_intentos WHERE usuario_id=$1', [uid])).rows[0].n, 0);

  // Error de conexión al finalizar: no debe haber éxito falso ni registro
  const mixtas = Object.fromEntries(dx.PREGUNTAS.map((q, i) => [i, q.tipo === 'conocimiento' ? ((i % 2) ? q.c : (q.c + 1) % 3) : 1]));
  respuestasHtml(p, mixtas);
  p.fallaRed = true; p.limpiarToasts(); p.click('#btnCalificarDiag');
  await p.toast('Error de conexión');
  assert.ok(!p.toasts().some(t => t.includes('Diagnóstico completado')), 'no debe mostrarse éxito sin confirmación');
  assert.equal(p.$('#panelNota').innerHTML.trim(), '', 'no se muestra resultado');
  assert.equal((await pool.query('SELECT count(*)::int n FROM diagnostico_intentos WHERE usuario_id=$1', [uid])).rows[0].n, 0);
  p.fallaRed = false;

  // Ahora sí: se guarda
  p.limpiarToasts(); p.click('#btnCalificarDiag');
  await p.toast('Diagnóstico completado correctamente');
  await esperar(() => p.$('.nota-panel'), 'panel de nota');
  const bd = (await pool.query('SELECT * FROM diagnostico_intentos WHERE usuario_id=$1', [uid])).rows;
  assert.equal(bd.length, 1);
  assert.equal(p.$('.nota-valor').textContent, Number(bd[0].nota).toFixed(1));
  assert.ok(p.$('.nota-resumen').textContent.includes(bd[0].nivel));
  assert.equal((await pool.query('SELECT count(*)::int n FROM diagnostico_respuestas WHERE intento_id=$1', [bd[0].id])).rows[0].n, 14);
  assert.ok(p.$$('.q-ok').length + p.$$('.q-bad').length >= 9, 'retroalimentación por pregunta');

  // Tras desbloquear: abrir módulos desde la interfaz y verificar el progreso en la BD
  await esperar(() => p.eval('tieneDiagnostico(usuarioActualObj())'), 'estado local actualizado');
  for (const m of ['mod1', 'mod2', 'mod3', 'mod4', 'mod5', 'mod6', 'mod7', 'mod8']) {
    p.eval(`irAModulo("${m}")`);
    await esperar(async () => (await pool.query('SELECT 1 FROM progreso_modulos WHERE usuario_id=$1 AND modulo_id=$2', [uid, m])).rowCount, `progreso de ${m} guardado`);
    assert.ok(p.$(`#${m}`), `se muestra el módulo ${m}`);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM progreso_modulos WHERE usuario_id=$1', [uid])).rows[0].n, 9);

  // Interacción masiva con los componentes de los módulos (tarjetas, asociaciones, acordeones, comparador...)
  let clics = 0;
  for (const m of ['mod1', 'mod2', 'mod3', 'mod4', 'mod5', 'mod6', 'mod7', 'mod8']) {
    p.eval(`irAModulo("${m}")`);
    for (const sel of ['[data-concepto]', '[data-descubre]', '[data-asoc-izq]', '[data-asoc-der]', 'details > summary', '[data-vf]', '[data-galeria]', '[data-paso]', '[data-lic]', '[data-cmd]']) {
      p.$$('#contenidoModulo ' + sel).slice(0, 3).forEach(e => { e.click(); clics++; });
    }
    const cerrar = p.$('#btnCerrarConcepto'); if (cerrar) cerrar.click();
    const cg = p.$('#btnCerrarGaleria'); if (cg) cg.click();
  }
  assert.ok(clics > 10, `se ejercitaron componentes interactivos (${clics} clics)`);

  // Cerrar sesión
  p.limpiarToasts(); p.click('#navSalir'); await p.toast('Sesión cerrada');
  await esperar(() => p.$('#loginUsuario'), 'vuelve al login');
  assert.equal(jar.cookie, '');
  await p.cerrar();

  // "Abrir de nuevo el navegador / otro dispositivo": sesión nueva, todo recuperado
  const q = await new Pagina().abrir();
  await login(q, `f_fabi_${SUF}`, 'fabi1234');
  await q.toast('Diagnóstico completado');
  await esperar(() => q.$('.dash-grid'), 'dashboard');
  assert.ok(q.$('.dash-grid').textContent.includes('Completado'));
  assert.ok(q.$('.progreso-text').textContent.includes('9 / 9'), q.$('.progreso-text').textContent);
  // Y al recargar la página con la misma cookie se retoma la sesión sin pedir login
  const r = await new Pagina({ cookie: q.jar.cookie }).abrir();
  await esperar(() => r.$('.dash-grid'), 'sesión recuperada al recargar');
  assert.equal(r.eval('sesion.usuario'), `f_fabi_${SUF}`);
  // Diagnóstico visible con sus respuestas marcadas
  r.eval('irAlDiagnostico()');
  await esperar(() => r.$('#btnCalificarDiag'), 'diagnóstico');
  assert.equal(r.$$('.quiz-item input:checked').length, 14, 'las respuestas guardadas se recuperan');
  assert.ok(r.$('.nota-panel'));
  assert.deepEqual([p.errores, q.errores, r.errores], [[], [], []]);
  await q.cerrar(); await r.cerrar();
});

test('F11-F12. Administrador: estadísticas desde la BD, búsqueda/filtros, configuración y eliminación', async () => {
  const jar = { cookie: '' };
  const p = await new Pagina(jar).abrir();
  await login(p, 'Cristian', ADMIN_PASS);
  await p.toast('Sesión iniciada');
  await esperar(() => p.$('.admin-kpis'), 'dashboard admin');
  const totalEst = (await pool.query(`SELECT count(*)::int n FROM usuarios WHERE rol='Usuario'`)).rows[0].n;
  const totalUsr = (await pool.query(`SELECT count(*)::int n FROM usuarios`)).rows[0].n;
  assert.ok(p.$('.admin-kpis').textContent.includes(String(totalUsr)));

  p.click('#btnIrEstadisticas');
  await esperar(() => p.$('#tablaWrap table'), 'tabla de estadísticas');
  const filas = p.$$('#tablaWrap tbody tr');
  assert.equal(filas.length, totalEst, 'la tabla refleja los estudiantes de la BD');
  const fila = filas.find(f => f.textContent.includes(`f_fabi_${SUF}`));
  assert.ok(fila, 'aparece el estudiante recién creado');
  const dBD = (await pool.query(`SELECT nota, porcentaje, nivel FROM diagnostico_intentos d JOIN usuarios u ON u.id=d.usuario_id WHERE u.usuario=$1`, [`f_fabi_${SUF}`])).rows[0];
  assert.ok(fila.textContent.includes(dBD.nivel) && fila.textContent.includes(dBD.porcentaje + '%'));
  const nCompletados = (await pool.query(`SELECT count(DISTINCT d.usuario_id)::int n FROM diagnostico_intentos d JOIN usuarios u ON u.id=d.usuario_id WHERE u.rol='Usuario'`)).rows[0].n;
  assert.equal(p.eval('calcularEstadisticas().completados'), nCompletados);

  // Búsqueda y filtros
  const bus = p.$('#buscadorEst'); bus.value = `f_fabi_${SUF}`; bus.dispatchEvent(new p.w.Event('input'));
  assert.equal(p.$$('#tablaWrap tbody tr').length, 1);
  bus.value = 'zzz_no_existe'; bus.dispatchEvent(new p.w.Event('input'));
  assert.ok(p.$('.tabla-vacia'));
  bus.value = ''; bus.dispatchEvent(new p.w.Event('input'));
  p.click('[data-filtro="pendiente"]');
  assert.ok(p.$$('#tablaWrap tbody tr').every(f => f.textContent.includes('Pendiente')));
  p.click('[data-filtro="completado"]');
  assert.equal(p.$$('#tablaWrap tbody tr').length, nCompletados);
  p.click('[data-filtro="todos"]');

  // Usuarios (modal) y eliminación con confirmación
  p.click('#navUsuarios');
  await esperar(() => p.$('#overlayUsuarios'), 'modal de usuarios');
  assert.ok(p.$('#overlayUsuarios').textContent.includes(`f_fabi_${SUF}`));
  assert.ok(p.$('#overlayUsuarios').textContent.includes('Administrador principal'));
  const btnDel = p.$(`[data-eliminar][data-nombre="f_fabi_${SUF}"]`);
  assert.ok(btnDel); btnDel.click();
  await esperar(() => p.$('#btnConfirmarEliminar'), 'confirmación');
  const uid = (await pool.query('SELECT id FROM usuarios WHERE usuario=$1', [`f_fabi_${SUF}`])).rows[0].id;
  p.limpiarToasts(); p.click('#btnConfirmarEliminar'); await p.toast('Usuario eliminado');
  assert.equal((await pool.query('SELECT 1 FROM usuarios WHERE id=$1', [uid])).rowCount, 0);
  for (const t of ['diagnostico_intentos', 'progreso_modulos', 'sesiones']) {
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${t} WHERE usuario_id=$1`, [uid])).rows[0].n, 0, t);
  }

  // Configuración de la cuenta propia (contraseña actual incorrecta y luego correcta)
  p.click('#navConfiguracion'); await esperar(() => p.$('#cfgNombre'), 'configuración');
  p.escribir('#cfgPassActual', 'mala'); p.limpiarToasts(); p.click('#btnGuardarConfiguracion'); await p.toast('Acceso denegado');
  p.escribir('#cfgNombre', 'Cristian Editado'); p.escribir('#cfgPassActual', ADMIN_PASS);
  p.limpiarToasts(); p.click('#btnGuardarConfiguracion'); await p.toast('Éxito');
  assert.equal((await pool.query(`SELECT nombre FROM usuarios WHERE usuario='Cristian'`)).rows[0].nombre, 'Cristian Editado');
  await pool.query(`UPDATE usuarios SET nombre='Cristian' WHERE usuario='Cristian'`);

  // Cartilla
  p.click('#navFundamentos'); await esperar(() => p.$('#contenidoModulo'), 'módulos');
  p.eval('irAModulo("mod1")');
  if (p.$('#inputCartilla')) {
    p.eval(`(async()=>{ const r = await Api.put("/api/cartilla",{nombre:"taller_${SUF}.pdf"}); cartillaNombre = r.cartillaNombre; render(); })()`);
    await esperar(async () => (await pool.query(`SELECT valor FROM configuracion WHERE clave='cartilla_nombre'`)).rows[0]?.valor === `taller_${SUF}.pdf`, 'cartilla guardada');
  }
  assert.deepEqual(p.errores, []); await p.cerrar();
});

test('F13. Sesión caducada en el servidor: la interfaz vuelve al login con aviso', async () => {
  const adm = new Pagina(); await adm.abrir();
  await login(adm, 'Cristian', ADMIN_PASS); await esperar(() => adm.$('.admin-kpis'), 'dashboard');
  await pool.query(`DELETE FROM sesiones WHERE usuario_id=(SELECT id FROM usuarios WHERE usuario='Cristian')`);
  adm.limpiarToasts(); adm.click('#navUsuarios');
  await adm.toast('Sesión finalizada');
  await esperar(() => adm.$('#loginUsuario'), 'regresa al login');
  await adm.cerrar();
});
