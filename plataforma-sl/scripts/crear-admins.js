'use strict';
/*
 * Crea (si no existen) los administradores principales Cristian y Javier.
 * Las contraseñas se leen de variables de entorno y se guardan con bcrypt.
 * Si el usuario ya existe NO se modifica, salvo que uses:  npm run seed:admins -- --reset
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const ADMINS = [
  { nombre: 'Cristian', usuario: 'Cristian', env: 'ADMIN_CRISTIAN_PASSWORD' },
  { nombre: 'Javier',   usuario: 'Javier',   env: 'ADMIN_JAVIER_PASSWORD' }
];
const reset = process.argv.includes('--reset');

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL en .env'); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  try {
    await c.connect();
    for (const a of ADMINS) {
      const pass = process.env[a.env];
      const ex = await c.query('SELECT id FROM usuarios WHERE lower(usuario)=lower($1)', [a.usuario]);
      if (ex.rowCount && !reset) { console.log(`= ${a.usuario}: ya existe (sin cambios).`); continue; }
      if (!pass || pass.length < 8) { console.error(`! ${a.usuario}: define ${a.env} en .env con al menos 8 caracteres.`); process.exitCode = 1; continue; }
      const hash = await bcrypt.hash(pass, 12);
      if (ex.rowCount) {
        await c.query(`UPDATE usuarios SET password_hash=$1, legacy_sha256=NULL, rol='Administrador', protegido=TRUE, estado='activo' WHERE id=$2`, [hash, ex.rows[0].id]);
        await c.query('DELETE FROM sesiones WHERE usuario_id=$1', [ex.rows[0].id]);
        console.log(`~ ${a.usuario}: contraseña restablecida y sesiones cerradas.`);
      } else {
        await c.query(`INSERT INTO usuarios (nombre, usuario, password_hash, rol, protegido) VALUES ($1,$2,$3,'Administrador',TRUE)`, [a.nombre, a.usuario, hash]);
        console.log(`+ ${a.usuario}: administrador principal creado.`);
      }
    }
  } catch (e) { console.error('Error:', e.message); process.exitCode = 1; }
  finally { await c.end().catch(() => {}); }
})();
