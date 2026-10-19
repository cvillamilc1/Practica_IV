'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL en .env'); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  try {
    await c.connect();
    await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    console.log('Esquema aplicado correctamente.');
  } catch (e) {
    console.error('No se pudo aplicar el esquema:', e.message); process.exitCode = 1;
  } finally { await c.end().catch(() => {}); }
})();
