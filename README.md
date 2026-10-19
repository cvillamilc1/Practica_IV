# Plataforma educativa de Software Libre — con base de datos PostgreSQL

Tu `Codigo_practicaV6.html` conserva su diseño, módulos, diagnóstico, paneles y estadísticas.
Lo que cambió es **dónde viven los datos**: ahora están en PostgreSQL y se acceden a través de un
backend con autenticación real, en lugar de `localStorage`.

```
Navegador (public/index.html)  ──HTTPS + cookie httpOnly──▶  Backend Express (server.js)  ──SQL──▶  PostgreSQL
```

## 1. Decisión de arquitectura

Evalué Supabase primero, como pedías, y elegí **Node.js + Express + PostgreSQL** porque tu plataforma:

- inicia sesión con **nombre de usuario** (sin correo), y Supabase Auth exige un correo;
- no tiene auto‑registro: **sólo Cristian o Javier crean cuentas** (regla original que se conserva);
- necesita **calificar el diagnóstico en el servidor** para que la nota no sea manipulable.

Puedes seguir usando Supabase **como proveedor de PostgreSQL** (pega su cadena de conexión en `DATABASE_URL`). El esquema activa RLS sin políticas, así que su API REST pública no puede leer nada.

## 2. Estructura

| Archivo | Para qué sirve |
|---|---|
| `public/index.html` | Tu plataforma (frontend). Cambió sólo la capa de datos. |
| `server.js` | API: login, sesiones, roles, usuarios, diagnóstico, progreso, cartilla |
| `lib/diagnostico.js` | Calificación y niveles (mismos criterios del original), ejecutada en el servidor |
| `db/schema.sql` | Tablas, claves, restricciones, índices y RLS (idempotente) |
| `scripts/aplicar-esquema.js` | `npm run db:schema` |
| `scripts/crear-admins.js` | `npm run seed:admins` — crea Cristian y Javier |
| `scripts/importar-localstorage.js` | `npm run import:local` — migra datos de la versión anterior |
| `tests/` | 20 pruebas automáticas (API + frontend real en jsdom) y el HTML original como referencia |
| `.env.example` | Variables de entorno (sin secretos) |

## 3. Puesta en marcha local

Requisitos: Node.js 18+ y un PostgreSQL 13+ (local o en la nube).

```bash
npm install
cp .env.example .env          # edita DATABASE_URL y las contraseñas de los administradores
npm run db:schema             # crea las tablas
npm run seed:admins           # crea Cristian y Javier (usa las contraseñas de tu .env)
npm start                     # http://localhost:3000
```

PostgreSQL local rápido (Linux/macOS):

```bash
createdb plataforma_sl
# DATABASE_URL=postgresql://TU_USUARIO:TU_CLAVE@localhost:5432/plataforma_sl
```

## 4. Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | **Obligatoria.** Cadena de conexión de tu base |
| `DATABASE_SSL` | `true` en casi todos los servicios en la nube |
| `NODE_ENV` | `production` activa cookies `Secure` (exige HTTPS) |
| `TRUST_PROXY` | `true` detrás de Render/Railway/Nginx (para que el límite de intentos use la IP real) |
| `SESSION_HOURS` | Duración de la sesión (12 por defecto) |
| `PASSWORD_MIN_LENGTH` | 4 = regla original. **Recomiendo subirlo a 8** |
| `ADMIN_CRISTIAN_PASSWORD`, `ADMIN_JAVIER_PASSWORD` | Sólo las lee `seed:admins` (mín. 8 caracteres) |

No necesitas ninguna clave de API: el frontend no habla con la base de datos, sólo con tu backend.

## 5. Cuentas administrativas iniciales

Las contraseñas `12345` que estaban escritas en el JavaScript **ya no existen en el código**.
Define contraseñas propias en `.env` y ejecuta `npm run seed:admins`. Se guardan con bcrypt.
Si ya existen no se tocan; para restablecer una: `npm run seed:admins -- --reset`.
Después de crearlas puedes borrar esas variables del entorno.

## 6. Despliegue en producción (ejemplo: Render/Railway + Neon/Supabase)

1. Crea una base PostgreSQL y copia su cadena de conexión.
2. Desde tu equipo, con `DATABASE_URL` de producción en `.env`: `npm run db:schema` y `npm run seed:admins`.
3. Crea un servicio web Node: *build* `npm install`, *start* `npm start`.
4. Variables del servicio: `DATABASE_URL`, `DATABASE_SSL=true`, `NODE_ENV=production`, `TRUST_PROXY=true`, `PASSWORD_MIN_LENGTH=8`.
5. Abre la URL pública (debe ser **HTTPS**) e inicia sesión como Cristian.

Con Supabase usa la cadena de *Settings → Database* (la del *pooler* si tu servidor no tiene IPv6).

## 7. Migrar los datos de la versión anterior

La versión anterior siempre guardaba una copia en `localStorage` del navegador. Debes exportar desde **el mismo navegador y la misma dirección** donde se usaba.

1. Abre la plataforma antigua, pulsa F12 → *Consola* y ejecuta:
   ```js
   copy(JSON.stringify({usuarios: JSON.parse(localStorage.getItem("usuarios_db")||"[]"), cartilla_nombre: localStorage.getItem("cartilla_nombre")}, null, 2))
   ```
   Pega el resultado en un archivo `export-local.json` (junto a `package.json`).
2. **Simulación** (no escribe nada): `npm run import:local -- export-local.json`
3. Revisa el resumen. **Aplicar**: `npm run import:local -- export-local.json --aplicar`
4. Verifica: cada usuario importado debe iniciar sesión con su contraseña de siempre (se convierte a bcrypt en el primer ingreso) y ver su diagnóstico y progreso.
5. **Sólo entonces**, y si quieres, borra los datos locales. El script nunca los borra.

Detalles: es **idempotente** (un usuario existente se omite); Cristian y Javier no se importan (se crean con el seed);
el diagnóstico se recalcula con los criterios oficiales a partir de las respuestas guardadas; los registros sin nombre, usuario
o hash válido, o con diagnóstico sin respuestas completas, aparecen en `incompletos` y la cuenta se importa sin diagnóstico (deberá repetirlo).
El historial local sólo guardaba resúmenes de los últimos intentos, por lo que sólo se importa el último intento con detalle.

## 8. Seguridad implementada

- Contraseñas con **bcrypt (costo 12)**; el hash SHA‑256 del navegador desapareció.
- Sesión por token aleatorio en cookie **httpOnly + SameSite=Lax (+ Secure en producción)**; en la base se guarda sólo su hash. Caduca y se revoca al cerrar sesión o cambiar la contraseña.
- **Toda autorización se verifica en el servidor**: el `user_id` nunca viene del navegador; se toma de la sesión.
- Un estudiante **sólo recibe su propio registro**; un administrador recibe a todos. Nunca se envían hashes.
- Crear usuarios exige credenciales de un **administrador principal** (verificadas en el servidor); roles validados con lista blanca y con `CHECK` en la base.
- Consultas parametrizadas (sin inyección SQL), límite de intentos de login, cabeceras de seguridad (Helmet/CSP), protección CSRF (cabecera personalizada + SameSite).
- **La nota la calcula el servidor**; el navegador sólo envía las opciones elegidas.
- RLS activado sin políticas: el acceso directo con roles públicos queda denegado.

## 9. Eliminación de usuarios

Al eliminar un usuario se borran **en cascada** sus sesiones, intentos de diagnóstico, respuestas y progreso (no quedan datos huérfanos). Es la misma consecuencia que tenía la plataforma original, que borraba el registro completo. Cristian y Javier (`protegido = true`) no se pueden eliminar. Si prefieres conservar historiales de estudiantes retirados, el campo `estado` (`activo`/`inactivo`) ya existe: un usuario inactivo no puede iniciar sesión; basta cambiarlo con SQL.

## 10. Pruebas

```bash
npm test      # 20 pruebas contra PostgreSQL real (requiere db:schema y seed:admins)
```

Cobertura de los 14 escenarios de tu lista:

| # | Escenario | Cómo se verifica |
|---|---|---|
| 1 | Crear usuario y verlo en la BD | Automática (API y desde la interfaz) |
| 2–3 | Reabrir navegador / otro dispositivo | Automática (cookies independientes). **Manual**: confirma desde un segundo dispositivo real |
| 4 | Usuario duplicado | Automática (incluye mayúsculas y restricción en la BD) |
| 5 | Credenciales incorrectas | Automática (incluye intentos de inyección) |
| 6 | Estudiante no crea administradores | Automática |
| 7 | No ver datos de otro estudiante | Automática |
| 8–9 | Diagnóstico guardado y persistente | Automática (respuestas, nota, nivel, historial) |
| 10 | Progreso de módulos | Automática (los 9 módulos desde la interfaz) |
| 11 | Estadísticas desde la BD | Automática (tabla y KPIs coinciden con consultas SQL) |
| 12 | Búsqueda, filtros y eliminación | Automática (incluye cascada) |
| 13 | Error de conexión | Automática (sin resultado ni mensaje de éxito falso; también con la BD apagada: HTTP 503 con mensaje claro) |
| 14 | Componentes originales | La prueba F0 compara el HTML renderizado de los 9 módulos, el panel, las estadísticas, el login y el registro **contra el original (idéntico)**, y el CSS es idéntico. **Manual**: revisa el aspecto visual en tu navegador |

## 11. Cambios de comportamiento (todos intencionales)

- Inicio de sesión **sin distinguir mayúsculas** en el usuario (antes exigía coincidencia exacta, pero la unicidad ya ignoraba mayúsculas).
- Los administradores principales **ya no se restablecen en cada carga** de la página: su contraseña es la que tú definas.
- El diagnóstico **guarda todos los intentos**; la interfaz sigue mostrando el último y los 5 más recientes, como antes.
- Cambiar la contraseña desde Configuración **cierra las demás sesiones** de esa cuenta.
- La cartilla sigue registrando sólo el **nombre del archivo** (igual que el original, que no la almacenaba).
- Los administradores no principales conservan todos sus permisos salvo crear usuarios (regla original).

## 12. Limitaciones que debes conocer

- **No ejecuté la plataforma en un navegador real ni contra tu proveedor en la nube.** Las pruebas corrieron en jsdom (ejecuta tu JavaScript real contra el servidor y PostgreSQL reales, pero no renderiza CSS ni gráficos). Prueba en tu navegador antes de usarla con estudiantes.
- Chart.js sigue cargándose desde `cdn.jsdelivr.net` y las fuentes desde Google Fonts (como en el original); el CSP del servidor lo permite. Sin internet, las barras usan su respaldo en CSS.
- Las respuestas correctas del diagnóstico siguen estando en el JavaScript del navegador, porque la retroalimentación pregunta por pregunta las muestra (igual que el original). Lo que no puede manipularse es la **nota guardada**. Si cambias preguntas, edita también `lib/diagnostico.js`; `npm test` avisa si no coinciden.
- El límite de intentos de login es en memoria, por proceso. Con varias instancias del servidor, conviene un límite en el balanceador.
