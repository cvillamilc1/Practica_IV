'use strict';
/*
 * Pruebas de integración contra una base PostgreSQL REAL (usa DATABASE_URL del .env).
 * Requisitos previos:  npm run db:schema  y  npm run seed:admins
 * Ejecutar:            npm test
 * Las pruebas crean usuarios con el prefijo "t_" y los eliminan al terminar.
 */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { app, pool } = require('../server');
const dx = require('../lib/diagnostico');

const ADMIN_PASS = process.env.ADMIN_CRISTIAN_PASSWORD;
const SUF = Date.now().toString(36);
let base, servidor;

/* Cliente HTTP con su propio "navegador" (jar de cookies) */
class Navegador {
  constructor() { this.cookie = ''; }
  async pedir(metodo, ruta, cuerpo, cabeceras = { 'X-Requested-With': 'plataforma-sl' }) {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...cabeceras },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    sc.forEach(c => {
      const [par] = c.split(';');
      if (/^sid=;/.test(c) || /Expires=Thu, 01 Jan 1970/.test(c)) this.cookie = '';
      else this.cookie = par;
    });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, json, headers: r.headers };
  }
  get(r) { return this.pedir('GET', r); }
  post(r, b) { return this.pedir('POST', r, b); }
  patch(r, b) { return this.pedir('PATCH', r, b); }
  put(r, b) { return this.pedir('PUT', r, b); }
  del(r) { return this.pedir('DELETE', r); }
}

const todasCorrectas = () => Object.fromEntries(dx.PREGUNTAS.map((p, i) => [i, p.tipo === 'conocimiento' ? p.c : 0]));
const todasMal = () => Object.fromEntries(dx.PREGUNTAS.map((p, i) => [i, p.tipo === 'conocimiento' ? (p.c + 1) % p.o.length : 0]));

async function crearUsuario(nav, nombre, usuario, contrasena, rol = 'Usuario') {
  return nav.post('/api/usuarios', { adminUsuario: 'Cristian', adminPass: ADMIN_PASS, nombre, usuario, contrasena, rol });
}

test.before(async () => {
  assert.ok(ADMIN_PASS, 'Define ADMIN_CRISTIAN_PASSWORD (la usa el seed) para ejecutar las pruebas');
  await new Promise(r => { servidor = app.listen(0, r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(async () => {
  await pool.query(`DELETE FROM usuarios WHERE usuario LIKE 't\\_%'`);
  await new Promise(r => servidor.close(r));
  await pool.end();
});

test('0. Las preguntas/claves del servidor coinciden con las del HTML', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/const DIAGNOSTICO = (\[[\s\S]*?\n\]);/);
  assert.ok(m, 'No se encontró DIAGNOSTICO en el HTML');
  const delHtml = JSON.parse(JSON.stringify(vm.runInNewContext(m[1])));
  assert.equal(delHtml.length, dx.PREGUNTAS.length);
  delHtml.forEach((q, i) => {
    assert.equal(q.q, dx.PREGUNTAS[i].q, `pregunta ${i + 1}`);
    assert.equal(q.tipo, dx.PREGUNTAS[i].tipo);
    assert.deepEqual(q.o, dx.PREGUNTAS[i].o);
    if (q.tipo === 'conocimiento') assert.equal(q.c, dx.PREGUNTAS[i].c);
  });
  const mods = [...html.matchAll(/\{ id: "(mod\d+)"/g)].map(x => x[1]);
  assert.deepEqual(mods, dx.MODULOS);
});

test('0b. Criterios de nivel idénticos al original', () => {
  const casos = [[0, 'Inicial'], [49, 'Inicial'], [50, 'Básico'], [69, 'Básico'], [70, 'Intermedio'], [89, 'Intermedio'], [90, 'Avanzado'], [100, 'Avanzado']];
  casos.forEach(([p, n]) => assert.equal(dx.nivelPorPorcentaje(p), n));
  const r = dx.calificar(todasCorrectas());
  assert.equal(r.porcentaje, 100); assert.equal(r.nota, 5); assert.equal(r.nivel, 'Avanzado');
  const m = dx.calificar(todasMal());
  assert.equal(m.porcentaje, 0); assert.equal(m.nota, 0); assert.equal(m.nivel, 'Inicial');
});

test('1. Crear usuario y comprobar que aparece en la base de datos (contraseña con bcrypt)', async () => {
  const adm = new Navegador();
  const r = await crearUsuario(adm, 'Ana Prueba', `t_ana_${SUF}`, 'clave123');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE usuario=$1', [`t_ana_${SUF}`]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rol, 'Usuario');
  assert.equal(rows[0].protegido, false);
  assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/, 'debe ser bcrypt');
  assert.notEqual(rows[0].password_hash, 'clave123');
});

test('2-3. Cerrar navegador / otro dispositivo: mismo perfil con otra sesión', async () => {
  const a = new Navegador();
  const l1 = await a.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' });
  assert.equal(l1.status, 200);
  assert.equal(l1.json.sesion.nombre, 'Ana Prueba');
  // "Otro dispositivo": jar de cookies distinto
  const b = new Navegador();
  const l2 = await b.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' });
  assert.equal(l2.status, 200);
  assert.equal(l2.json.sesion.id, l1.json.sesion.id);
  // "Reabrir el navegador" conservando la cookie: sesión recuperada
  const c = new Navegador(); c.cookie = a.cookie;
  const e = await c.get('/api/estado');
  assert.equal(e.status, 200);
  assert.equal(e.json.sesion.usuario, `t_ana_${SUF}`);
  // La cookie es httpOnly
  const raw = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'plataforma-sl' }, body: JSON.stringify({ usuario: `t_ana_${SUF}`, contrasena: 'clave123' }) });
  assert.match(raw.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(raw.headers.get('set-cookie'), /SameSite=Lax/i);
});

test('4. Usuario duplicado (también variando mayúsculas) → rechazado', async () => {
  const adm = new Navegador();
  const r1 = await crearUsuario(adm, 'Otra Ana', `t_ana_${SUF}`, 'otra1234');
  assert.equal(r1.status, 409);
  const r2 = await crearUsuario(adm, 'Otra Ana', `T_ANA_${SUF}`.toUpperCase(), 'otra1234');
  assert.equal(r2.status, 409);
  const { rows } = await pool.query(`SELECT count(*)::int n FROM usuarios WHERE lower(usuario)=lower($1)`, [`t_ana_${SUF}`]);
  assert.equal(rows[0].n, 1);
  // La restricción también existe en la BD (no sólo en el código)
  await assert.rejects(pool.query(`INSERT INTO usuarios (nombre, usuario, password_hash) VALUES ('x',$1,'h')`, [`T_Ana_${SUF}`]), /usuarios_usuario_lower_uq/);
});

test('5. Credenciales incorrectas e intento de inyección SQL → 401', async () => {
  const n = new Navegador();
  assert.equal((await n.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'mala' })).status, 401);
  assert.equal((await n.post('/api/login', { usuario: 'noexiste', contrasena: 'x' })).status, 401);
  assert.equal((await n.post('/api/login', { usuario: "' OR '1'='1' --", contrasena: "' OR '1'='1" })).status, 401);
  assert.equal((await n.post('/api/login', { usuario: { $ne: 1 }, contrasena: { $ne: 1 } })).status, 400);
  const e = await n.get('/api/estado');
  assert.equal(e.status, 401);
});

test('6. Un estudiante no puede crear administradores ni cambiar su rol', async () => {
  const est = new Navegador();
  await est.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' });
  // a) Usar sus propias credenciales como "administrador autorizado"
  const r = await est.post('/api/usuarios', { adminUsuario: `t_ana_${SUF}`, adminPass: 'clave123', nombre: 'Falso', usuario: `t_falso_${SUF}`, contrasena: 'xxxx1234', rol: 'Administrador' });
  assert.equal(r.status, 403);
  // b) Sin credenciales válidas
  const r2 = await est.post('/api/usuarios', { adminUsuario: 'Cristian', adminPass: 'incorrecta', nombre: 'Falso', usuario: `t_falso_${SUF}`, contrasena: 'xxxx1234', rol: 'Administrador' });
  assert.equal(r2.status, 403);
  // c) Intentar modificar el rol desde /perfil
  const p = await est.patch('/api/perfil', { nombre: 'Ana Prueba', usuario: `t_ana_${SUF}`, passActual: 'clave123', rol: 'Administrador', protegido: true });
  assert.equal(p.status, 200);
  const { rows } = await pool.query('SELECT rol, protegido FROM usuarios WHERE usuario=$1', [`t_ana_${SUF}`]);
  assert.equal(rows[0].rol, 'Usuario'); assert.equal(rows[0].protegido, false);
  const nada = await pool.query('SELECT 1 FROM usuarios WHERE usuario=$1', [`t_falso_${SUF}`]);
  assert.equal(nada.rowCount, 0);
  // d) Endpoints de administración
  assert.equal((await est.del('/api/usuarios/1')).status, 403);
  assert.equal((await est.put('/api/cartilla', { nombre: 'x.pdf' })).status, 403);
  // e) Un administrador NO principal tampoco puede crear usuarios (regla original: sólo Cristian/Javier)
  const adm = new Navegador();
  await crearUsuario(adm, 'Admin Secundario', `t_adm2_${SUF}`, 'admin1234', 'Administrador');
  const r3 = await adm.post('/api/usuarios', { adminUsuario: `t_adm2_${SUF}`, adminPass: 'admin1234', nombre: 'X', usuario: `t_x_${SUF}`, contrasena: 'xxxx1234', rol: 'Usuario' });
  assert.equal(r3.status, 403);
});

test('7. Un usuario no puede consultar datos de otro estudiante', async () => {
  const adm = new Navegador();
  await crearUsuario(adm, 'Beto Prueba', `t_beto_${SUF}`, 'beto1234');
  const ana = new Navegador(), beto = new Navegador();
  await ana.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' });
  await beto.post('/api/login', { usuario: `t_beto_${SUF}`, contrasena: 'beto1234' });
  assert.equal((await beto.post('/api/diagnostico', { respuestas: todasCorrectas() })).status, 201);
  const e = await ana.get('/api/estado');
  assert.equal(e.json.usuarios.length, 1, 'el estudiante sólo debe recibir su propio registro');
  assert.equal(e.json.usuarios[0].usuario, `t_ana_${SUF}`);
  assert.ok(!JSON.stringify(e.json).includes(`t_beto_${SUF}`), 'no debe filtrarse ningún dato de otro usuario');
  assert.ok(!JSON.stringify(e.json).includes('password'), 'nunca se envían hashes');
  // Aunque envíe un usuario_id ajeno, el servidor usa el de la sesión
  const r = await ana.post('/api/progreso', { modulo: 'mod0', usuario_id: 999999 });
  assert.equal(r.status, 200);
});

test('8-9. Diagnóstico: el servidor califica, guarda respuestas y persiste tras cerrar sesión', async () => {
  const n = new Navegador();
  await n.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' });
  // Respuestas inválidas / incompletas
  assert.equal((await n.post('/api/diagnostico', { respuestas: { 0: 1 } })).status, 400);
  assert.equal((await n.post('/api/diagnostico', { respuestas: { ...todasCorrectas(), 0: 9 } })).status, 400);
  assert.equal((await n.post('/api/diagnostico', {})).status, 400);

  // Un cliente tramposo envía su propia nota: se ignora
  const mixtas = todasMal(); mixtas[0] = 1; mixtas[2] = 1; mixtas[8] = 1; mixtas[9] = 0;  // 4 correctas de 9 evaluables
  const r = await n.post('/api/diagnostico', { respuestas: mixtas, nota: 5, porcentaje: 100, nivel: 'Avanzado' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const res = r.json.resultado;
  assert.equal(res.correctas, 4); assert.equal(res.incorrectas, dx.TOTAL_CONOCIMIENTO - 4);
  assert.equal(res.porcentaje, Math.round(4 / dx.TOTAL_CONOCIMIENTO * 100));
  assert.equal(res.nivel, dx.nivelPorPorcentaje(res.porcentaje));
  assert.notEqual(res.nota, 5);
  assert.equal(res.intentos, 1);

  const { rows: it } = await pool.query(`SELECT d.* FROM diagnostico_intentos d JOIN usuarios u ON u.id=d.usuario_id WHERE u.usuario=$1`, [`t_ana_${SUF}`]);
  assert.equal(it.length, 1);
  const { rows: rp } = await pool.query('SELECT * FROM diagnostico_respuestas WHERE intento_id=$1 ORDER BY pregunta_idx', [it[0].id]);
  assert.equal(rp.length, dx.PREGUNTAS.length);
  assert.equal(rp.filter(x => x.es_correcta === true).length, 4);
  assert.equal(rp.filter(x => x.tipo === 'perfil').length, 5);
  assert.equal(it[0].perfil.length, 5);

  // Cerrar sesión e ingresar de nuevo
  await n.post('/api/logout');
  assert.equal((await n.get('/api/estado')).status, 401);
  const otra = new Navegador();
  const l = await otra.post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' });
  const yo = l.json.usuarios[0];
  assert.equal(yo.diagnostico.completado, true);
  assert.equal(yo.diagnostico.porcentaje, res.porcentaje);
  assert.equal(yo.diagnostico.respuestas[0], 1, 'respuestas recuperables para marcar los radios');
  assert.ok(yo.progreso.includes('mod0'));

  // Segundo intento: el historial no se sobrescribe
  const r2 = await otra.post('/api/diagnostico', { respuestas: todasCorrectas() });
  assert.equal(r2.json.resultado.intentos, 2);
  assert.equal(r2.json.resultado.nivel, 'Avanzado');
  const { rows: n2 } = await pool.query('SELECT count(*)::int n FROM diagnostico_intentos WHERE usuario_id=$1', [yo.id]);
  assert.equal(n2[0].n, 2);
  assert.equal(r2.json.historial.length, 2);
});

test('8b. Intentos simultáneos no duplican el número de intento', async () => {
  const n = new Navegador();
  await n.post('/api/login', { usuario: `t_beto_${SUF}`, contrasena: 'beto1234' });
  const rs = await Promise.all([1, 2, 3, 4].map(() => n.post('/api/diagnostico', { respuestas: todasCorrectas() })));
  assert.ok(rs.every(r => r.status === 201));
  const nums = rs.map(r => r.json.resultado.intentos).sort();
  assert.deepEqual(nums, [2, 3, 4, 5]);
});

test('10. Progreso de módulos persiste y respeta el bloqueo por diagnóstico', async () => {
  const adm = new Navegador();
  await crearUsuario(adm, 'Carla Prueba', `t_carla_${SUF}`, 'carla1234');
  const n = new Navegador();
  await n.post('/api/login', { usuario: `t_carla_${SUF}`, contrasena: 'carla1234' });
  assert.equal((await n.post('/api/progreso', { modulo: 'mod3' })).status, 403, 'bloqueado sin diagnóstico');
  assert.equal((await n.post('/api/progreso', { modulo: 'mod99' })).status, 400);
  assert.equal((await n.post('/api/progreso', { modulo: "mod1'; DROP TABLE usuarios;--" })).status, 400);
  await n.post('/api/diagnostico', { respuestas: todasCorrectas() });
  await n.post('/api/progreso', { modulo: 'mod1' });
  const r = await n.post('/api/progreso', { modulo: 'mod2' });
  await n.post('/api/progreso', { modulo: 'mod2' }); // repetido: no duplica
  assert.deepEqual(r.json.progreso.sort(), ['mod0', 'mod1', 'mod2']);
  // otro dispositivo
  const otro = new Navegador();
  const l = await otro.post('/api/login', { usuario: `t_carla_${SUF}`, contrasena: 'carla1234' });
  assert.deepEqual(l.json.usuarios[0].progreso.sort(), ['mod0', 'mod1', 'mod2']);
});

test('11-12. Administrador: ve a todos, estadísticas desde la BD, cartilla y eliminación', async () => {
  const adm = new Navegador();
  const l = await adm.post('/api/login', { usuario: 'Cristian', contrasena: ADMIN_PASS });
  assert.equal(l.status, 200);
  assert.equal(l.json.sesion.rol, 'Administrador');
  const mios = l.json.usuarios.filter(u => u.usuario.startsWith('t_'));
  assert.ok(mios.length >= 4);
  const ana = mios.find(u => u.usuario === `t_ana_${SUF}`);
  assert.equal(ana.diagnostico.intentos, 2);
  assert.equal(ana.historialDiagnostico.length, 2);
  const carla = mios.find(u => u.usuario === `t_carla_${SUF}`);
  assert.equal(carla.progreso.length, 3);

  // Cartilla
  assert.equal((await adm.put('/api/cartilla', { nombre: 'cartilla_taller.pdf' })).status, 200);
  const e = await adm.get('/api/estado');
  assert.equal(e.json.cartillaNombre, 'cartilla_taller.pdf');

  // Eliminación: protegidos no, resto sí, con sus datos asociados
  const principal = l.json.usuarios.find(u => u.usuario === 'Cristian');
  assert.equal((await adm.del(`/api/usuarios/${principal.id}`)).status, 403);
  assert.equal((await adm.del('/api/usuarios/abc')).status, 400);
  assert.equal((await adm.del('/api/usuarios/99999999')).status, 404);
  const antes = await pool.query('SELECT count(*)::int n FROM diagnostico_intentos WHERE usuario_id=$1', [ana.id]);
  assert.equal(antes.rows[0].n, 2);
  const d = await adm.del(`/api/usuarios/${ana.id}`);
  assert.equal(d.status, 200);
  const despues = await Promise.all([
    pool.query('SELECT count(*)::int n FROM diagnostico_intentos WHERE usuario_id=$1', [ana.id]),
    pool.query('SELECT count(*)::int n FROM progreso_modulos WHERE usuario_id=$1', [ana.id]),
    pool.query('SELECT count(*)::int n FROM sesiones WHERE usuario_id=$1', [ana.id]),
    pool.query(`SELECT count(*)::int n FROM diagnostico_respuestas r WHERE NOT EXISTS (SELECT 1 FROM diagnostico_intentos d WHERE d.id=r.intento_id)`)
  ]);
  despues.forEach(r => assert.equal(r.rows[0].n, 0, 'no deben quedar datos huérfanos'));
  assert.equal((await new Navegador().post('/api/login', { usuario: `t_ana_${SUF}`, contrasena: 'clave123' })).status, 401);
});

test('Seguridad: CSRF, sesión caducada y usuario inactivo', async () => {
  const n = new Navegador();
  // POST sin la cabecera exigida
  const sin = await n.pedir('POST', '/api/login', { usuario: 'Cristian', contrasena: ADMIN_PASS }, {});
  assert.equal(sin.status, 403);
  await n.post('/api/login', { usuario: `t_beto_${SUF}`, contrasena: 'beto1234' });
  assert.equal((await n.get('/api/estado')).status, 200);
  await pool.query(`UPDATE sesiones SET expira_en = now() - interval '1 minute' WHERE usuario_id=(SELECT id FROM usuarios WHERE usuario=$1)`, [`t_beto_${SUF}`]);
  assert.equal((await n.get('/api/estado')).status, 401, 'sesión caducada');
  await pool.query(`UPDATE usuarios SET estado='inactivo' WHERE usuario=$1`, [`t_beto_${SUF}`]);
  assert.equal((await new Navegador().post('/api/login', { usuario: `t_beto_${SUF}`, contrasena: 'beto1234' })).status, 401);
  const h = await new Navegador().get('/api/salud');
  assert.equal(h.status, 200);
  assert.ok(h.headers.get('content-security-policy'));
});

test('Cambio de contraseña desde Configuración (bcrypt, cierra otras sesiones)', async () => {
  const a = new Navegador(), b = new Navegador();
  await a.post('/api/login', { usuario: `t_carla_${SUF}`, contrasena: 'carla1234' });
  await b.post('/api/login', { usuario: `t_carla_${SUF}`, contrasena: 'carla1234' });
  assert.equal((await a.patch('/api/perfil', { nombre: 'Carla', usuario: `t_carla_${SUF}`, passActual: 'incorrecta', passNueva: 'nueva1234' })).status, 403);
  assert.equal((await a.patch('/api/perfil', { nombre: 'Carla', usuario: `t_carla_${SUF}`, passActual: 'carla1234', passNueva: 'nueva1234' })).status, 200);
  assert.equal((await a.get('/api/estado')).status, 200, 'la sesión actual se conserva');
  assert.equal((await b.get('/api/estado')).status, 401, 'las demás sesiones se cierran');
  assert.equal((await new Navegador().post('/api/login', { usuario: `t_carla_${SUF}`, contrasena: 'carla1234' })).status, 401);
  assert.equal((await new Navegador().post('/api/login', { usuario: `t_carla_${SUF}`, contrasena: 'nueva1234' })).status, 200);
  // Usuario duplicado al renombrar
  assert.equal((await a.patch('/api/perfil', { nombre: 'Carla', usuario: 'Cristian', passActual: 'nueva1234' })).status, 409);
});

test('Migración: usuario con hash SHA-256 antiguo inicia sesión y se convierte a bcrypt', async () => {
  const crypto = require('crypto');
  const legacy = crypto.createHash('sha256').update('antigua123').digest('hex');
  const exp = path.join(__dirname, `export_${SUF}.json`);
  const lista = [
    { id: 7, nombre: 'Legacy Uno', usuario: `t_leg_${SUF}`, contrasena: legacy, rol: 'Usuario', protegido: false,
      progreso: ['mod0', 'mod1', 'modX'], diagnostico: { completado: true, respuestas: todasCorrectas(), intentos: 3, timestamp: 1700000000000 } },
    { id: 8, nombre: 'Sin hash', usuario: `t_rota_${SUF}`, rol: 'Usuario' },
    { id: 1, nombre: 'Cristian', usuario: 'Cristian', contrasena: legacy, rol: 'Administrador', protegido: true }
  ];
  fs.writeFileSync(exp, JSON.stringify({ usuarios: lista, cartilla_nombre: 'vieja.pdf' }));
  const correr = (...extra) => JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'scripts', 'importar-localstorage.js'), exp, ...extra], { env: process.env }).toString().split('\n').slice(1).join('\n'));
  try {
    const sim = correr();
    assert.equal(sim.importados, 1);
    assert.equal((await pool.query('SELECT 1 FROM usuarios WHERE usuario=$1', [`t_leg_${SUF}`])).rowCount, 0, 'la simulación no escribe');
    const real = correr('--aplicar');
    assert.equal(real.importados, 1); assert.equal(real.omitidos_maestros, 1); assert.equal(real.incompletos.length, 1);
    const otra = correr('--aplicar');                          // idempotente
    assert.equal(otra.importados, 0); assert.equal(otra.omitidos_existentes, 1);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM usuarios WHERE usuario=$1`, [`t_leg_${SUF}`])).rows[0].n, 1);
    const n = new Navegador();
    const l = await n.post('/api/login', { usuario: `t_leg_${SUF}`, contrasena: 'antigua123' });
    assert.equal(l.status, 200);
    assert.equal(l.json.usuarios[0].diagnostico.intentos, 3);
    assert.deepEqual(l.json.usuarios[0].progreso.sort(), ['mod0', 'mod1']);
    const { rows } = await pool.query('SELECT password_hash, legacy_sha256 FROM usuarios WHERE usuario=$1', [`t_leg_${SUF}`]);
    assert.match(rows[0].password_hash, /^\$2/); assert.equal(rows[0].legacy_sha256, null);
    assert.equal((await new Navegador().post('/api/login', { usuario: `t_leg_${SUF}`, contrasena: 'antigua123' })).status, 200);
    assert.equal((await new Navegador().post('/api/login', { usuario: `t_leg_${SUF}`, contrasena: 'x' })).status, 401);
  } finally { fs.unlinkSync(exp); }
});
