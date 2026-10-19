'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const dx = require('./lib/diagnostico');

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */
const PROD = process.env.NODE_ENV === 'production';
const PORT = parseInt(process.env.PORT || '3000', 10);
const SESION_HORAS = parseInt(process.env.SESSION_HOURS || '12', 10);
const PASSWORD_MIN = parseInt(process.env.PASSWORD_MIN_LENGTH || '4', 10); // 4 = regla original de la plataforma
const ZONA_HORARIA = process.env.APP_TIMEZONE || 'America/Bogota';
const COOKIE = 'sid';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copia .env.example a .env y complétalo.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10
});
pool.on('error', e => console.error('Error en el pool de PostgreSQL:', e.message));

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'upgrade-insecure-requests': PROD ? [] : null
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const ahoraTexto = d => new Date(d).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: ZONA_HORARIA });
const HASH_FALSO = bcrypt.hashSync('contraseña-señuelo', 10); // iguala tiempos cuando el usuario no existe
const esTexto = v => typeof v === 'string';

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fallo = (res, status, mensaje) => res.status(status).json({ ok: false, error: mensaje });

async function verificarContrasena(fila, contrasena) {
  if (fila.password_hash) return bcrypt.compare(contrasena, fila.password_hash);
  if (fila.legacy_sha256) {
    // Migración desde la versión local: se acepta el hash SHA-256 antiguo una sola vez y se reemplaza por bcrypt.
    if (sha256(contrasena) !== fila.legacy_sha256) return false;
    const nuevo = await bcrypt.hash(contrasena, 12);
    await pool.query('UPDATE usuarios SET password_hash=$1, legacy_sha256=NULL WHERE id=$2', [nuevo, fila.id]);
    return true;
  }
  await bcrypt.compare(contrasena, HASH_FALSO);
  return false;
}

/* ------------------------------------------------------------------ */
/* Sesiones y control de acceso                                        */
/* ------------------------------------------------------------------ */
async function crearSesion(res, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES ($1,$2, now() + ($3 || ' hours')::interval)`,
    [sha256(token), usuarioId, String(SESION_HORAS)]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: PROD, path: '/', maxAge: SESION_HORAS * 3600 * 1000
  });
}

async function cargarSesion(req, _res, next) {
  req.usuario = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token && esTexto(token)) {
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre, u.usuario, u.rol, u.protegido
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token_hash=$1 AND s.expira_en > now() AND u.estado='activo'`,
      [sha256(token)]
    );
    if (rows[0]) req.usuario = rows[0];
  }
  next();
}

// Defensa CSRF adicional a SameSite: toda petición que modifica datos debe traer esta cabecera
// (un formulario de otro sitio no puede añadirla).
function exigirCabeceraAjax(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'plataforma-sl') return fallo(res, 403, 'Petición no autorizada.');
  next();
}
const exigirSesion = (req, res, next) => req.usuario ? next() : fallo(res, 401, 'Debes iniciar sesión.');
const exigirAdmin = (req, res, next) => {
  if (!req.usuario) return fallo(res, 401, 'Debes iniciar sesión.');
  if (req.usuario.rol !== 'Administrador') return fallo(res, 403, 'Acceso denegado: se requiere rol de administrador.');
  next();
};

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000, limit: parseInt(process.env.LOGIN_RATE_LIMIT || '20', 10),
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }
});

/* ------------------------------------------------------------------ */
/* Serialización: misma forma de objetos que usaba el HTML original    */
/* ------------------------------------------------------------------ */
function resultadoDesdeFila(f, respuestas) {
  return {
    completado: f.completado,
    nota: Number(f.nota), porcentaje: f.porcentaje,
    correctas: f.correctas, incorrectas: f.incorrectas, sinResponder: f.sin_responder,
    totalConocimiento: f.total_conocimiento,
    respuestas: respuestas || undefined,
    perfil: f.perfil, recomendacion: f.recomendacion,
    nivel: f.nivel, retroalimentacion: f.retroalimentacion,
    intentos: f.intento_numero,
    timestamp: new Date(f.creado_en).getTime(),
    fecha: ahoraTexto(f.creado_en)
  };
}

async function cargarEstado(sesionUsuario) {
  const esAdmin = sesionUsuario.rol === 'Administrador';
  // Un estudiante SOLO recibe su propio registro; un administrador recibe a todos.
  const filtro = esAdmin ? '' : 'WHERE u.id = $1';
  const params = esAdmin ? [] : [sesionUsuario.id];

  const [us, prog, ultimos, hist] = await Promise.all([
    pool.query(`SELECT u.id, u.nombre, u.usuario, u.rol, u.protegido, u.estado, u.creado_en, u.ultimo_acceso
                  FROM usuarios u ${filtro} ORDER BY u.id`, params),
    pool.query(`SELECT p.usuario_id, array_agg(p.modulo_id ORDER BY p.primera_visita, p.modulo_id) AS mods
                  FROM progreso_modulos p JOIN usuarios u ON u.id = p.usuario_id ${filtro}
                 GROUP BY p.usuario_id`, params),
    pool.query(`SELECT DISTINCT ON (d.usuario_id) d.*
                  FROM diagnostico_intentos d JOIN usuarios u ON u.id = d.usuario_id
                 WHERE d.completado ${esAdmin ? '' : 'AND u.id = $1'}
                 ORDER BY d.usuario_id, d.intento_numero DESC`, params),
    pool.query(`SELECT * FROM (
                  SELECT d.usuario_id, d.intento_numero, d.nota, d.porcentaje, d.nivel, d.creado_en,
                         row_number() OVER (PARTITION BY d.usuario_id ORDER BY d.intento_numero DESC) AS rn
                    FROM diagnostico_intentos d JOIN usuarios u ON u.id = d.usuario_id ${filtro}
                ) t WHERE rn <= 5 ORDER BY usuario_id, intento_numero`, params)
  ]);

  // Respuestas individuales del último intento: sólo del propio usuario (las usa la pantalla del diagnóstico)
  const miUltimo = ultimos.rows.find(r => r.usuario_id === sesionUsuario.id);
  let misRespuestas;
  if (miUltimo) {
    const r = await pool.query('SELECT pregunta_idx, opcion_idx FROM diagnostico_respuestas WHERE intento_id=$1', [miUltimo.id]);
    misRespuestas = {};
    r.rows.forEach(x => { misRespuestas[x.pregunta_idx] = x.opcion_idx; });
  }

  const mapProg = new Map(prog.rows.map(r => [r.usuario_id, r.mods]));
  const mapUlt = new Map(ultimos.rows.map(r => [r.usuario_id, r]));
  const mapHist = new Map();
  hist.rows.forEach(r => {
    if (!mapHist.has(r.usuario_id)) mapHist.set(r.usuario_id, []);
    mapHist.get(r.usuario_id).push({
      fecha: ahoraTexto(r.creado_en), porcentaje: r.porcentaje, nota: Number(r.nota), nivel: r.nivel, intento: r.intento_numero
    });
  });

  const usuarios = us.rows.map(u => {
    const ult = mapUlt.get(u.id);
    const o = {
      id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, protegido: u.protegido,
      estado: u.estado, creadoEn: u.creado_en, ultimoAcceso: u.ultimo_acceso,
      progreso: mapProg.get(u.id) || [],
      historialDiagnostico: mapHist.get(u.id) || []
    };
    if (ult) o.diagnostico = resultadoDesdeFila(ult, u.id === sesionUsuario.id ? misRespuestas : undefined);
    return o;
  });

  const cfg = await pool.query(`SELECT valor FROM configuracion WHERE clave='cartilla_nombre'`);
  return {
    sesion: { id: sesionUsuario.id, nombre: sesionUsuario.nombre, usuario: sesionUsuario.usuario, rol: sesionUsuario.rol },
    usuarios,
    cartillaNombre: cfg.rows[0] ? cfg.rows[0].valor : null
  };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
const api = express.Router();
api.use(exigirCabeceraAjax, wrap(cargarSesion));

api.get('/salud', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

api.get('/estado', exigirSesion, wrap(async (req, res) => {
  res.json({ ok: true, ...(await cargarEstado(req.usuario)) });
}));

api.post('/login', limiteLogin, wrap(async (req, res) => {
  const { usuario, contrasena } = req.body || {};
  if (!esTexto(usuario) || !esTexto(contrasena) || !usuario.trim() || !contrasena) {
    return fallo(res, 400, 'Ingresa tu usuario y tu contraseña.');
  }
  const { rows } = await pool.query(
    `SELECT id, password_hash, legacy_sha256, estado FROM usuarios WHERE lower(usuario)=lower($1)`, [usuario.trim()]
  );
  const fila = rows[0];
  const ok = fila ? await verificarContrasena(fila, contrasena) : (await bcrypt.compare(contrasena, HASH_FALSO), false);
  if (!ok || fila.estado !== 'activo') return fallo(res, 401, 'Usuario o contraseña incorrectos.');

  await pool.query('UPDATE usuarios SET ultimo_acceso=now() WHERE id=$1', [fila.id]);
  await pool.query('DELETE FROM sesiones WHERE expira_en < now()'); // limpieza oportunista
  await crearSesion(res, fila.id);
  const { rows: u } = await pool.query('SELECT id, nombre, usuario, rol, protegido FROM usuarios WHERE id=$1', [fila.id]);
  res.json({ ok: true, ...(await cargarEstado(u[0])) });
}));

api.post('/logout', wrap(async (req, res) => {
  const token = req.cookies && req.cookies[COOKIE];
  if (token && esTexto(token)) await pool.query('DELETE FROM sesiones WHERE token_hash=$1', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

/* ---- Crear usuario: sólo los administradores principales (regla original: Cristian o Javier) ---- */
api.post('/usuarios', limiteLogin, wrap(async (req, res) => {
  const { adminUsuario, adminPass, nombre, usuario, contrasena, rol } = req.body || {};
  if (![adminUsuario, adminPass, nombre, usuario, contrasena].every(esTexto)) return fallo(res, 400, 'Todos los campos del nuevo usuario son obligatorios.');

  const { rows } = await pool.query(
    `SELECT id, password_hash, legacy_sha256, rol, protegido, estado FROM usuarios WHERE lower(usuario)=lower($1)`, [adminUsuario.trim()]
  );
  const adm = rows[0];
  const credencialesOk = adm ? await verificarContrasena(adm, adminPass) : (await bcrypt.compare(adminPass, HASH_FALSO), false);
  if (!credencialesOk || adm.estado !== 'activo' || adm.rol !== 'Administrador' || !adm.protegido) {
    return fallo(res, 403, 'Solo Cristian o Javier, con su clave correspondiente, pueden crear usuarios.');
  }

  const n = nombre.trim(), u = usuario.trim();
  if (!n || !u || !contrasena) return fallo(res, 400, 'Todos los campos del nuevo usuario son obligatorios.');
  if (n.length > 120 || u.length > 60) return fallo(res, 400, 'El nombre o el usuario superan la longitud permitida.');
  if (contrasena.length < PASSWORD_MIN) return fallo(res, 400, `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`);
  if (!['Usuario', 'Administrador'].includes(rol)) return fallo(res, 400, 'Rol no válido.');

  const hash = await bcrypt.hash(contrasena, 12);
  try {
    const r = await pool.query(
      `INSERT INTO usuarios (nombre, usuario, password_hash, rol, protegido) VALUES ($1,$2,$3,$4,FALSE) RETURNING id`,
      [n, u, hash, rol]
    );
    res.status(201).json({ ok: true, id: r.rows[0].id, usuario: u, rol });
  } catch (e) {
    if (e.code === '23505') return fallo(res, 409, 'El usuario ya existe.');
    throw e;
  }
}));

/* ---- Eliminar usuario (sólo administradores; los principales están protegidos) ---- */
api.delete('/usuarios/:id', exigirAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return fallo(res, 400, 'Identificador inválido.');
  const { rows } = await pool.query('SELECT id, usuario, protegido FROM usuarios WHERE id=$1', [id]);
  if (!rows[0]) return fallo(res, 404, 'El usuario no existe.');
  if (rows[0].protegido) return fallo(res, 403, 'Cristian y Javier son administradores principales y no pueden ser eliminados.');
  // ON DELETE CASCADE elimina también sus sesiones, intentos de diagnóstico, respuestas y progreso.
  await pool.query('DELETE FROM usuarios WHERE id=$1', [id]);
  if (id === req.usuario.id) res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true, eliminado: rows[0].usuario, propio: id === req.usuario.id });
}));

/* ---- Configuración de la propia cuenta ---- */
api.patch('/perfil', exigirSesion, limiteLogin, wrap(async (req, res) => {
  const { nombre, usuario, passActual, passNueva } = req.body || {};
  if (!esTexto(nombre) || !esTexto(usuario) || !nombre.trim() || !usuario.trim()) return fallo(res, 400, 'El nombre y el nombre de usuario son obligatorios.');
  if (!esTexto(passActual) || !passActual) return fallo(res, 400, 'Debes ingresar tu contraseña actual para guardar los cambios.');
  if (nombre.trim().length > 120 || usuario.trim().length > 60) return fallo(res, 400, 'El nombre o el usuario superan la longitud permitida.');

  const { rows } = await pool.query('SELECT id, password_hash, legacy_sha256 FROM usuarios WHERE id=$1', [req.usuario.id]);
  if (!(await verificarContrasena(rows[0], passActual))) return fallo(res, 403, 'La contraseña actual es incorrecta.');

  let hash = null;
  if (passNueva) {
    if (!esTexto(passNueva) || passNueva.length < PASSWORD_MIN) return fallo(res, 400, `La nueva contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`);
    hash = await bcrypt.hash(passNueva, 12);
  }
  try {
    await pool.query(
      `UPDATE usuarios SET nombre=$1, usuario=$2, password_hash=COALESCE($3, password_hash),
              legacy_sha256 = CASE WHEN $3::text IS NULL THEN legacy_sha256 ELSE NULL END
        WHERE id=$4`,
      [nombre.trim(), usuario.trim(), hash, req.usuario.id]
    );
  } catch (e) {
    if (e.code === '23505') return fallo(res, 409, 'Ese nombre de usuario ya está en uso por otra cuenta.');
    throw e;
  }
  // Si cambió la contraseña se cierran las demás sesiones de la cuenta (la actual se conserva)
  if (hash) {
    const token = req.cookies[COOKIE];
    await pool.query('DELETE FROM sesiones WHERE usuario_id=$1 AND token_hash <> $2', [req.usuario.id, sha256(token)]);
  }
  res.json({ ok: true, nombre: nombre.trim(), usuario: usuario.trim() });
}));

/* ---- Diagnóstico: el servidor califica; el navegador sólo envía las opciones elegidas ---- */
api.post('/diagnostico', exigirSesion, wrap(async (req, res) => {
  const r = dx.calificar((req.body || {}).respuestas);
  if (r.error) return fallo(res, 400, r.error);

  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    await cx.query('SELECT id FROM usuarios WHERE id=$1 FOR UPDATE', [req.usuario.id]); // serializa intentos simultáneos
    const n = await cx.query('SELECT COALESCE(MAX(intento_numero),0)+1 AS n FROM diagnostico_intentos WHERE usuario_id=$1', [req.usuario.id]);
    const intento = n.rows[0].n;
    const ins = await cx.query(
      `INSERT INTO diagnostico_intentos
         (usuario_id, intento_numero, completado, nota, porcentaje, correctas, incorrectas, sin_responder,
          total_conocimiento, nivel, retroalimentacion, recomendacion, perfil)
       VALUES ($1,$2,TRUE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.usuario.id, intento, r.nota, r.porcentaje, r.correctas, r.incorrectas, r.sinResponder,
       r.totalConocimiento, r.nivel, r.retroalimentacion, r.recomendacion, JSON.stringify(r.perfil)]
    );
    for (const f of r.filas) {
      await cx.query(
        `INSERT INTO diagnostico_respuestas (intento_id, pregunta_idx, tipo, opcion_idx, es_correcta) VALUES ($1,$2,$3,$4,$5)`,
        [ins.rows[0].id, f.idx, f.tipo, f.opcion, f.correcta]
      );
    }
    await cx.query(
      `INSERT INTO progreso_modulos (usuario_id, modulo_id) VALUES ($1,'mod0')
       ON CONFLICT (usuario_id, modulo_id) DO UPDATE SET actualizado_en=now()`, [req.usuario.id]
    );
    await cx.query('COMMIT');

    const respuestas = {};
    r.filas.forEach(f => { respuestas[f.idx] = f.opcion; });
    const hist = await pool.query(
      `SELECT intento_numero, nota, porcentaje, nivel, creado_en FROM diagnostico_intentos
        WHERE usuario_id=$1 ORDER BY intento_numero DESC LIMIT 5`, [req.usuario.id]);
    res.status(201).json({
      ok: true,
      resultado: resultadoDesdeFila(ins.rows[0], respuestas),
      historial: hist.rows.reverse().map(h => ({ fecha: ahoraTexto(h.creado_en), porcentaje: h.porcentaje, nota: Number(h.nota), nivel: h.nivel, intento: h.intento_numero }))
    });
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}));

/* ---- Progreso por módulo ---- */
api.post('/progreso', exigirSesion, wrap(async (req, res) => {
  const { modulo } = req.body || {};
  if (!esTexto(modulo) || !dx.MODULOS.includes(modulo)) return fallo(res, 400, 'Módulo no válido.');

  // Regla original: ningún módulo (salvo el diagnóstico) se registra sin diagnóstico completado, excepto administradores.
  if (modulo !== 'mod0' && req.usuario.rol !== 'Administrador') {
    const d = await pool.query('SELECT 1 FROM diagnostico_intentos WHERE usuario_id=$1 AND completado LIMIT 1', [req.usuario.id]);
    if (!d.rowCount) return fallo(res, 403, 'Debes completar primero el diagnóstico inicial.');
  }
  await pool.query(
    `INSERT INTO progreso_modulos (usuario_id, modulo_id) VALUES ($1,$2)
     ON CONFLICT (usuario_id, modulo_id) DO UPDATE SET actualizado_en=now()`, [req.usuario.id, modulo]
  );
  const { rows } = await pool.query(
    'SELECT modulo_id FROM progreso_modulos WHERE usuario_id=$1 ORDER BY primera_visita, modulo_id', [req.usuario.id]);
  res.json({ ok: true, progreso: rows.map(r => r.modulo_id) });
}));

/* ---- Cartilla (la versión original sólo registra el nombre del archivo) ---- */
api.put('/cartilla', exigirAdmin, wrap(async (req, res) => {
  const { nombre } = req.body || {};
  if (!esTexto(nombre) || !nombre.trim() || nombre.length > 255) return fallo(res, 400, 'Nombre de archivo inválido.');
  await pool.query(
    `INSERT INTO configuracion (clave, valor, actualizado_por) VALUES ('cartilla_nombre',$1,$2)
     ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, actualizado_por=EXCLUDED.actualizado_por, actualizado_en=now()`,
    [nombre.trim(), req.usuario.id]
  );
  res.json({ ok: true, cartillaNombre: nombre.trim() });
}));

api.use((_req, res) => fallo(res, 404, 'Ruta no encontrada.'));
app.use('/api', api);

/* ------------------------------------------------------------------ */
/* Frontend estático                                                   */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

/* Manejo de errores: nunca se filtran detalles internos al navegador */
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return fallo(res, 400, 'JSON inválido.');
  console.error(err);
  const bd = err.code && /^(ECONN|ETIMEDOUT|57P|08|53)/.test(String(err.code));
  fallo(res, bd ? 503 : 500, bd ? 'No se pudo conectar con la base de datos. Inténtalo de nuevo.' : 'Error interno del servidor.');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Plataforma disponible en http://localhost:${PORT}`));
}
module.exports = { app, pool };
