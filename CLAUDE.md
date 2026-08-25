# Consultorio Odontológico Franco Vinzón — sitio web

Handoff / contexto general del proyecto para retomar trabajo sin historial de chat previo.
Ver también: `architecture.md` (qué hace cada archivo), `decisions.md` (decisiones a no revertir sin pedido explícito), `tasks.md` (pendientes), `changelog.md` (historial).

## Qué es esto

Sitio del consultorio: home pública (`/`), reserva de turnos para pacientes (`/turnos`), panel de gestión para la secretaria, Ayelen (`/gestion`), panel de fichas de pacientes (`/pacientes`) y panel administrativo solo para Fausto (`/admin`, 2026-08-13 — ver "Panel /admin" en `architecture.md`). 100% gratuito, pensado para durar sin mantenimiento ni costos.

- **Dominio en producción:** `od-francovinzon.vercel.app`
- **Repo:** GitHub `faustovinzon9-art/od-francovinzon`, rama `main` → deploy automático a Vercel (Hobby, plan gratuito) en cada push.
- **Dueño del proyecto en esta conversación:** Fausto (hijo del odontólogo), no programador.

## Arquitectura

Sitio **estático** (HTML/CSS/JS plano, sin build, sin framework) + **Vercel Serverless Functions** (Node.js, `googleapis`) para todo lo que necesita hablar con Google Calendar. **No usa Next.js** — cuidado con asumir convenciones de Next (App Router, `app/api/.../route.js`, etc.); las funciones son simplemente archivos `.js` bajo `api/` con `export default function handler(req, res)`, convención zero-config de Vercel.

No hay `middleware.js` ni Next.js. **Sí hay `vercel.json`** (actualizado 2026-08-24 — los docs viejos decían que no): define el cron de salud diario (`0 7 * * *` → `/api/gestion/pacientes?modo=healthcheck`), el rewrite del link corto (`/t/:codigo` → `/api/reservar?codigo=:codigo`), `maxDuration: 300` para `admin.js` y `pacientes.js`, e `includeFiles` del worker de `pdfjs-dist`.

### Por qué no hay Apps Script ni iframes

El sistema original vivía en Google Apps Script (`script.google.com`), embebido en un iframe. Se migró por completo a esta arquitectura propia porque Safari (iOS) y los navegadores embebidos de Instagram/Facebook bloqueaban cookies de terceros y rompían el iframe. Ya no depende de Apps Script para nada — la migración fue completa (agenda, turnos, sobreturnos, bloqueos, todo vive en `/api`).

### Google Calendar: cuenta de servicio, sin invitados

Se usa una **cuenta de servicio de Google** (JWT, `googleapis`) con el calendario compartido con permiso de edición — no hay OAuth de usuario ni login de paciente.

**Importante:** los eventos se crean **sin `attendees`**. Una cuenta de servicio sin *domain-wide delegation* (que requiere Google Workspace pago; esta cuenta es Gmail normal) no puede invitar asistentes por Calendar API — intentarlo tira `GaxiosError`. Por eso el email/teléfono del paciente va como texto en la `description` del evento, no como invitado, y no se manda ningún mail de confirmación.

### Zona horaria: siempre Argentina, nunca la del dispositivo

Argentina no tiene horario de verano (UTC-3 fijo todo el año). Regla que se aplica **en todo el proyecto, cliente y servidor**:

- Para escribir una fecha/hora Argentina desde un string `"yyyy-MM-dd"` + `"HH:mm"`: construir el ISO con offset explícito `-03:00` (`toArgDate()` en `lib/googleCalendar.js`).
- Para leer/mostrar "qué día es hoy" o "qué hora es ahora" **en el navegador**: nunca usar getters locales de `Date` (`.getFullYear()`, `.getMonth()`, `.getDate()`, etc.) — dependen de la zona horaria del dispositivo del visitante. Usar siempre `Intl.DateTimeFormat(..., { timeZone: 'America/Argentina/Buenos_Aires' })`.
- Ya hubo un bug real de esto (getters locales calculando "hoy" mal para visitantes en otro huso horario) corregido en `/turnos` y `/gestion` — ver `changelog.md` 2026-08-05.

## Calendarios usados (Google Calendar)

| Constante | ID | Uso |
|---|---|---|
| `CALENDAR_ID` | `odontologofrancovinzon@gmail.com` | Turnos normales (30 min) y bloqueos (día completo u horario) |
| `SOBRETURNOS_CALENDAR_ID` | `v5cmrbcmh56qfdnvqvd7b7oa9s@group.calendar.google.com` | Sobreturnos (15 min) — se permite superponer con el calendario principal a propósito |

Ambos definidos en `lib/googleCalendar.js`.

## Variables de entorno (Vercel → Settings → Environment Variables)

Solo nombres, nunca valores en el código ni en estos docs:

- `GOOGLE_CLIENT_EMAIL` — email de la cuenta de servicio.
- `GOOGLE_PRIVATE_KEY` — clave privada de la cuenta de servicio (con `\n` escapados; se des-escapan en `getCalendarClient()`).
- `GESTION_KEY` — clave de acceso al panel `/gestion` (la usa Ayelen). Se manda como `key` en cada request a `/api/gestion/*`, nunca queda logueada en el cliente salvo `sessionStorage`.
- `GEMINI_API_KEY` — clave de la API de Gemini. **En desuso desde 2026-08-13**: los únicos consumidores (`api/chat.js` chatbot público y `api/gestion/asistente.js` asistente de `/gestion`) fueron **eliminados** en el commit "Mega batch" — hoy ningún código usa Gemini. Se puede conservar por si se retoma el chatbot, pero no la lee nadie.
- `RESEND_API_KEY` — opcional. Clave de la API de Resend, usada solo por `lib/alertas.js` (`avisarFallo()`) para mandar un email a Fausto cuando algo falla de verdad después de agotar los reintentos automáticos (`lib/retry.js`). Sin esta variable, `avisarFallo()` no hace más que un `console.error` — nunca tira, nunca rompe el endpoint que la llama.
- `CRON_SECRET` — necesaria para que el chequeo de salud diario (`vercel.json`, `modo=healthcheck` en `api/gestion/pacientes.js`, 4:00 AM hora Argentina) funcione. Vercel manda automáticamente `Authorization: Bearer <valor>` en cada invocación de cron cuando esta variable está seteada — sin ella, el endpoint devuelve 401 y el cron nunca hace nada útil (no rompe nada, solo queda inactivo). Se genera un valor random cualquiera, no depende de ningún servicio externo.
- `ADMIN_KEY` — nueva (2026-08-13). Clave de acceso al panel `/admin`, separada de `GESTION_KEY` — solo Fausto la tiene, Ayelen no ve `/admin`. Ver `lib/adminAuth.js`. Sin esta variable seteada, `/admin` rechaza cualquier clave (fail-closed, no hay acceso "por accidente").
- `VERCEL_API_TOKEN` — opcional, nueva (2026-08-13). Solo hace falta para la sección "Accesos" de `/admin` (cambiar `GESTION_KEY` desde el panel sin tocar Vercel a mano — ver `api/gestion/admin.js`, `postAccesos()`). Se genera en Vercel → Account Settings → Tokens. Sin esta variable, esa acción puntual devuelve un mensaje explicando cómo configurarla; el resto de `/admin` funciona igual. `VERCEL_PROJECT_ID` NO hace falta configurarlo a mano — Vercel lo inyecta solo en todo deployment.

## Límite de 12 Serverless Functions (plan Hobby de Vercel)

**Esto ya rompió un deploy entero una vez** (ver `changelog.md` 2026-08-05, "Fusionar rutas..."). El plan gratuito de Vercel permite **como máximo 12 Serverless Functions por deployment** — si se supera, **el build entero falla** (no solo la función de más) y producción se queda pegada en el último deploy bueno, sin ningún aviso claro salvo mirar el dashboard.

**Antes de agregar un archivo nuevo bajo `api/`**, contar cuántos hay y cuántos quedan libres. Si hace falta una ruta nueva y no hay margen, **fusionar en un archivo existente usando un campo `accion`/`modo`/`recurso` en el body o query** en vez de crear un archivo — patrón ya usado en `disponibilidad.js`, `bloqueos.js`, `evento.js`, `buscar.js`, `pacientes.js` y `admin.js` (ver `architecture.md`).

Archivos actuales bajo `api/` (**11 de 12 — queda 1 de margen**; lista verificada contra el filesystem el 2026-08-24 — confiar siempre en el filesystem antes que en este bloque):

```
api/disponibilidad.js
api/reservar.js
api/gestion/turnos-dia.js
api/gestion/crear-turno.js
api/gestion/bloqueos.js
api/gestion/evento.js
api/gestion/buscar.js
api/gestion/agregar-telefono.js
api/gestion/agregar-dni.js
api/gestion/pacientes.js
api/gestion/admin.js
```

`api/disponibilidad.js` fusiona lo que antes eran `disponibilidad-mes.js` + `horarios-dia.js` (sin `modo` = mes, `?modo=dia` = horarios de un día, `?modo=estado` = interruptor de reserva online). `api/gestion/bloqueos.js` fusiona lo que antes eran `bloqueo-dia.js` + `bloquear-horario.js` (2026-08-13). `api/gestion/buscar.js` incluye además `?modo=proximo-bloqueo` (lo que antes era un archivo propio). `api/gestion/agregar-dni.js` es nuevo (2026-08-14, no figuraba en versiones viejas de este doc).

**Ojo (2026-08-24): los docs viejos mencionan `api/chat.js` y `api/gestion/asistente.js` — fueron BORRADOS el 2026-08-13.** El chatbot público y el asistente IA de `/gestion` ya no existen; `architecture.md` todavía tiene secciones que los describen — no guiarse por esas secciones.

Para utilidades de un solo uso (migraciones, scripts de limpieza): agregar el archivo, correrlo, **sacarlo del proyecto y hacer commit de la baja** ni bien confirma el resultado (patrón ya usado dos veces — limpieza de títulos viejos y rescate de teléfonos sueltos).

**Utilitarios temporales: NINGUNO en el código (2026-08-24).** Los tres que existieron se usaron y se dieron de baja con su commit de baja (regla del proyecto: los utilitarios de un solo uso se agregan, se corren y se sacan):
- `backfill-consolidado-q7m3` (2026-08-14) — dado de baja el 2026-08-24 (la planilla "Pacientes consolidados" está poblada por los upserts normales).
- `migrar-fecha-nacimiento-una-vez` — EJECUTADO el 2026-08-24 (217/246 fichas con fecha canónica `DD/MM/AAAA`; 0 pendientes) y sacado del código.
- `limpiar-filas-fantasma-una-vez` — EJECUTADO el 2026-08-24 (~40.000 filas fantasma `'FALSE'` limpiadas en las 246 fichas; verificado 0 restantes) y sacado del código.
Si alguna vez hacen falta de nuevo, están en el historial de git. Ver `changelog.md`.

## Deploy: cosas a tener en cuenta

### Regla permanente (2026-08-12): nunca trabajar directo en `main` — rama + preview primero

El consultorio tiene que poder seguir funcionando **en todo momento** — `/turnos`, `/gestion` y `/pacientes` los usan Ayelen, Franco y los pacientes en tiempo real, no hay ventana de mantenimiento. Ningún cambio puede arriesgar interrumpirlos mientras se está trabajando. Motivo: un push directo a `main` (2026-08-12) rompió Calendar/Sheets/Drive en producción entera — agenda de `/gestion` y reserva de `/turnos` caídas al mismo tiempo — por código nunca probado contra la API real (ver `decisions.md`, "Incidentes en producción").

De acá en adelante, **todo cambio de código sigue este flujo, sin excepción**:

1. Crear una rama nueva (`git checkout -b <nombre>`) — nunca commitear directo en `main`.
2. Pushear la rama a GitHub. Vercel genera automáticamente un deploy de **preview** en una URL propia de esa rama (Hobby plan lo hace solo, sin configuración extra) — nada de esto toca `od-francovinzon.vercel.app` (producción).
3. Probar el cambio contra ese preview (no contra producción, no solo con datos mockeados localmente si el cambio toca algo sensible como los clientes de Google — ver el incidente de arriba, un mock local no lo hubiera detectado).
4. Recién con el preview confirmado andando bien, mergear/pushear a `main`.

Esto aplica en particular a cualquier cosa que toque `lib/googleCalendar.js`, `lib/googleOAuthPacientes.js`, o cualquier endpoint bajo `api/` — son compartidos por las tres superficies (`/turnos`, `/gestion`, `/pacientes`), así que un error ahí las tira a las tres juntas.

**Limitación conocida (2026-08-12): los previews tienen protección SSO de Vercel activada.** Cualquier request sin sesión de Vercel logueada (páginas y `/api/*` por igual) redirige a `vercel.com/sso-api` — así que Claude no puede inspeccionar el preview visualmente por su cuenta (ni con `curl`, ni con el navegador automatizado). En la práctica: conseguir la URL real del preview vía la API de GitHub (`GET /repos/.../deployments/{id}/statuses`, campo `environment_url` — el `target_url` del status "Vercel" en `GET /commits/{sha}/status` solo linkea al dashboard, que también pide login), confirmar que el deploy terminó bien ("Deployment has completed"), probar el cambio a fondo con datos simulados localmente contra el código exacto de ese commit, y explicarle esto al usuario antes de mergear — para cambios que no tocan `api/`/clientes de Google (frontend puro), esa combinación alcanza; para cambios que sí los tocan, pedirle al usuario que entre él mismo al preview con su sesión antes de dar el OK.

- Push a `main` dispara deploy automático en Vercel. **A veces tarda varios minutos** en propagar (no es un bug, es normal para este proyecto — no asumir que falló solo por tardanza).
- **Una vez el webhook de GitHub→Vercel no disparó** un deploy con un push válido; se resolvió con un commit vacío/trivial para forzar un nuevo push. Si un deploy no aparece en absoluto en el dashboard de Vercel después de varios minutos (no "Building", directamente no existe), sospechar esto antes que un error de código.
- **No hacer polling agresivo (loops cortos de curl) contra el dominio de producción** — en algún momento disparó el modo de protección anti-bot de Vercel (`x-vercel-mitigated: challenge`) y bloqueó el sitio real para visitantes reales, no solo para mí. Espaciar los chequeos (≥20-30s entre intentos) y avisar al usuario para que confirme desde su propio navegador en vez de insistir con requests automáticos.
- Al tocar rutas que llaman a Google Calendar API en un loop (migraciones, procesar muchos eventos): la cuota de Google es ~600 requests/min/usuario, **compartida con el tráfico real del sitio**. Usar lotes chicos (~40) secuenciales con una pausa (~150ms) entre llamadas, nunca `Promise.all` sobre muchos `events.patch`/`insert` a la vez.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
