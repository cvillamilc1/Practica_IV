'use strict';
/*
 * Importa a PostgreSQL los datos que la versión anterior guardaba en el navegador (localStorage).
 *   1) En el navegador donde estaban los datos, ejecuta el fragmento de la consola indicado en el README
 *      y guarda el resultado como export-local.json.
 *   2) npm run import:local -- export-local.json            (simulación: no escribe nada)
 *      npm run import:local -- export-local.json --aplicar  (escribe en la base de datos)
 *
 * - Es idempotente: un usuario que ya existe se omite, así que puedes ejecutarlo varias veces.
 * - Las contraseñas antiguas eran SHA-256: se guardan en legacy_sha256 y se convierten a bcrypt
 *   automáticamente en el primer inicio de sesión de cada usuario.
 * - Cristian y Javier NO se importan: se crean con "npm run seed:admins".
 * - NO borra nada del navegador. Conserva tu export hasta verificar el resultado.
 */
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');
const dx = require('../lib/diagnostico');

const archivo = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
if (!archivo || !fs.existsSync(archivo)) { console.error('Uso: npm run import:local -- export-local.json [--aplicar]'); process.exit(1); }

const HEX64 = /^[0-9a-f]{64}$/i;
const resumen = { importados: 0, omitidos_existentes: 0, omitidos_maestros: 0, incompletos: [], diagnosticos: 0, diag_sin_detalle: 0 };

(async () => {
  let datos;
  try { datos = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { console.error('El archivo no es JSON válido:', e.message); process.exit(1); }
  const lista = Array.isArray(datos) ? datos : datos.usuarios;
  if (!Array.isArray(lista)) { console.error('No se encontró la lista "usuarios" en el archivo.'); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try {
    for (const u of lista) {
      const etiqueta = (u && (u.usuario || u.nombre)) || '(sin nombre)';
      if (!u || typeof u.usuario !== 'string' || !u.usuario.trim() || typeof u.nombre !== 'string' || !u.nombre.trim()
          || typeof u.contrasena !== 'string' || !HEX64.test(u.contrasena)) {
        resumen.incompletos.push(`${etiqueta}: faltan nombre, usuario o un hash SHA-256 válido`); continue;
      }
      if (['cristian', 'javier'].includes(u.usuario.trim().toLowerCase())) { resumen.omitidos_maestros++; continue; }
      const ex = await c.query('SELECT id FROM usuarios WHERE lower(usuario)=lower($1)', [u.usuario.trim()]);
      if (ex.rowCount) { resumen.omitidos_existentes++; continue; }
      const rol = u.rol === 'Administrador' ? 'Administrador' : 'Usuario';

      if (aplicar) await c.query('BEGIN');
      try {
        let id = 0;
        if (aplicar) {
          const r = await c.query(
            `INSERT INTO usuarios (nombre, usuario, legacy_sha256, rol, protegido) VALUES ($1,$2,$3,$4,FALSE) RETURNING id`,
            [u.nombre.trim(), u.usuario.trim(), u.contrasena.toLowerCase(), rol]);
          id = r.rows[0].id;
        }
        // Progreso
        for (const m of (Array.isArray(u.progreso) ? u.progreso : [])) {
          if (dx.MODULOS.includes(m) && aplicar) {
            await c.query('INSERT INTO progreso_modulos (usuario_id, modulo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, m]);
          }
        }
        // Diagnóstico (sólo se conserva el último intento con detalle; el historial local sólo guardaba resúmenes)
        const d = u.diagnostico;
        if (d && d.completado !== false) {
          let r = null;
          const resp = d.respuestas && typeof d.respuestas === 'object' ? d.respuestas : null;
          const parseadas = resp ? Object.fromEntries(Object.entries(resp).map(([k, v]) => [Number(k), v])) : null;
          const cal = parseadas ? dx.calificar(parseadas) : { error: 'sin respuestas' };
          if (!cal.error) r = cal;                       // se recalcula con los criterios oficiales
          if (r) {
            resumen.diagnosticos++;
            if (aplicar) {
              const intento = Number.isInteger(d.intentos) && d.intentos >= 1 ? d.intentos : 1;
              const creado = Number.isFinite(d.timestamp) ? new Date(d.timestamp) : new Date();
              const ins = await c.query(
                `INSERT INTO diagnostico_intentos (usuario_id, intento_numero, nota, porcentaje, correctas, incorrectas, sin_responder,
                   total_conocimiento, nivel, retroalimentacion, recomendacion, perfil, creado_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
                [id, intento, r.nota, r.porcentaje, r.correctas, r.incorrectas, r.sinResponder, r.totalConocimiento, r.nivel,
                 r.retroalimentacion, r.recomendacion, JSON.stringify(r.perfil), creado]);
              for (const f of r.filas) {
                await c.query('INSERT INTO diagnostico_respuestas (intento_id, pregunta_idx, tipo, opcion_idx, es_correcta) VALUES ($1,$2,$3,$4,$5)',
                  [ins.rows[0].id, f.idx, f.tipo, f.opcion, f.correcta]);
              }
              await c.query(`INSERT INTO progreso_modulos (usuario_id, modulo_id) VALUES ($1,'mod0') ON CONFLICT DO NOTHING`, [id]);
            }
          } else {
            resumen.diag_sin_detalle++;
            resumen.incompletos.push(`${etiqueta}: diagnóstico sin respuestas completas; la cuenta se importa sin diagnóstico (deberá repetirlo)`);
          }
        }
        if (aplicar) await c.query('COMMIT');
        resumen.importados++;
      } catch (e) {
        if (aplicar) await c.query('ROLLBACK');
        resumen.incompletos.push(`${etiqueta}: error al importar (${e.message})`);
      }
    }
    if (aplicar && datos.cartilla_nombre && typeof datos.cartilla_nombre === 'string') {
      await c.query(`INSERT INTO configuracion (clave, valor) VALUES ('cartilla_nombre',$1) ON CONFLICT (clave) DO NOTHING`, [datos.cartilla_nombre.slice(0, 255)]);
    }
  } finally { await c.end(); }

  console.log(aplicar ? '=== IMPORTACIÓN APLICADA ===' : '=== SIMULACIÓN (no se escribió nada; usa --aplicar) ===');
  console.log(JSON.stringify(resumen, null, 2));
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
