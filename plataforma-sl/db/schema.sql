-- =====================================================================
-- Esquema PostgreSQL · Plataforma educativa de Software Libre
-- Idempotente: se puede ejecutar varias veces sin perder datos.
-- Uso:  psql "$DATABASE_URL" -f db/schema.sql
-- =====================================================================

BEGIN;

-- ---------- USUARIOS ----------
CREATE TABLE IF NOT EXISTS usuarios (
  id             SERIAL PRIMARY KEY,
  nombre         TEXT        NOT NULL CHECK (char_length(btrim(nombre))  BETWEEN 1 AND 120),
  usuario        TEXT        NOT NULL CHECK (char_length(btrim(usuario)) BETWEEN 1 AND 60),
  password_hash  TEXT,                       -- bcrypt. NULL sólo si viene de migración local (ver legacy_sha256)
  legacy_sha256  TEXT,                       -- hash SHA-256 de la versión anterior; se borra en el 1.er login
  rol            TEXT        NOT NULL DEFAULT 'Usuario' CHECK (rol IN ('Usuario','Administrador')),
  protegido      BOOLEAN     NOT NULL DEFAULT FALSE,   -- administradores principales: no se eliminan
  estado         TEXT        NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','inactivo')),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_acceso  TIMESTAMPTZ,
  CONSTRAINT usuarios_tiene_credencial CHECK (password_hash IS NOT NULL OR legacy_sha256 IS NOT NULL)
);
-- Unicidad sin distinguir mayúsculas (igual que la validación original)
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_usuario_lower_uq ON usuarios (lower(usuario));

-- ---------- SESIONES (token aleatorio en cookie httpOnly; aquí sólo su hash) ----------
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  INTEGER     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sesiones_usuario_idx ON sesiones (usuario_id);
CREATE INDEX IF NOT EXISTS sesiones_expira_idx  ON sesiones (expira_en);

-- ---------- DIAGNÓSTICO: un registro por intento (nunca se sobrescribe) ----------
CREATE TABLE IF NOT EXISTS diagnostico_intentos (
  id                  SERIAL PRIMARY KEY,
  usuario_id          INTEGER      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  intento_numero      INTEGER      NOT NULL CHECK (intento_numero >= 1),
  completado          BOOLEAN      NOT NULL DEFAULT TRUE,
  nota                NUMERIC(2,1) NOT NULL CHECK (nota BETWEEN 0 AND 5),
  porcentaje          INTEGER      NOT NULL CHECK (porcentaje BETWEEN 0 AND 100),
  correctas           INTEGER      NOT NULL CHECK (correctas   >= 0),
  incorrectas         INTEGER      NOT NULL CHECK (incorrectas >= 0),
  sin_responder       INTEGER      NOT NULL CHECK (sin_responder >= 0),
  total_conocimiento  INTEGER      NOT NULL CHECK (total_conocimiento >= 0),
  nivel               TEXT         NOT NULL CHECK (nivel IN ('Inicial','Básico','Intermedio','Avanzado')),
  retroalimentacion   TEXT         NOT NULL,
  recomendacion       TEXT,
  perfil              JSONB        NOT NULL DEFAULT '[]'::jsonb,   -- respuestas de perfil (no calificables)
  creado_en           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, intento_numero)
);
CREATE INDEX IF NOT EXISTS diag_intentos_usuario_fecha_idx ON diagnostico_intentos (usuario_id, creado_en DESC);

-- ---------- DIAGNÓSTICO: respuesta individual de cada pregunta ----------
CREATE TABLE IF NOT EXISTS diagnostico_respuestas (
  intento_id   INTEGER NOT NULL REFERENCES diagnostico_intentos(id) ON DELETE CASCADE,
  pregunta_idx INTEGER NOT NULL CHECK (pregunta_idx >= 0),
  tipo         TEXT    NOT NULL CHECK (tipo IN ('conocimiento','perfil')),
  opcion_idx   INTEGER CHECK (opcion_idx >= 0),      -- NULL = sin responder
  es_correcta  BOOLEAN,                              -- NULL en preguntas de perfil o sin responder
  PRIMARY KEY (intento_id, pregunta_idx)
);

-- ---------- PROGRESO POR MÓDULO ----------
CREATE TABLE IF NOT EXISTS progreso_modulos (
  usuario_id      INTEGER     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo_id       TEXT        NOT NULL CHECK (modulo_id ~ '^mod[0-9]+$'),
  estado          TEXT        NOT NULL DEFAULT 'visto' CHECK (estado IN ('visto','completado')),
  primera_visita  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, modulo_id)
);

-- ---------- CONFIGURACIÓN DE LA PLATAFORMA (p. ej. nombre de la cartilla) ----------
CREATE TABLE IF NOT EXISTS configuracion (
  clave           TEXT PRIMARY KEY,
  valor           TEXT,
  actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- SEGURIDAD A NIVEL DE BASE DE DATOS ----------
-- Toda la información se accede ÚNICAMENTE a través del backend (Express), que verifica identidad y rol.
-- Se activa RLS sin políticas: cualquier acceso directo con roles públicos (p. ej. la API REST/anon key de
-- Supabase u otro rol sin privilegios) queda DENEGADO. El rol propietario que usa el backend no se ve afectado.
ALTER TABLE usuarios               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones               ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostico_intentos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostico_respuestas ENABLE ROW LEVEL SECURITY;
ALTER TABLE progreso_modulos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracion          ENABLE ROW LEVEL SECURITY;

COMMIT;
