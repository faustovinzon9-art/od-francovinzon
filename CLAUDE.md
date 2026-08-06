# Consultorio Odontológico Franco Vinzón — sitio web

Handoff / contexto general del proyecto para retomar trabajo sin historial de chat previo.
Ver también: `architecture.md` (qué hace cada archivo), `decisions.md` (decisiones a no revertir sin pedido explícito), `tasks.md` (pendientes), `changelog.md` (historial).

## Qué es esto

Sitio del consultorio: home pública (`/`), reserva de turnos para pacientes (`/turnos`) y panel de gestión para la secretaria, Ayelen (`/gestion`). 100% gratuito, pensado para durar sin mantenimiento ni costos.

- **Dominio en producción:** `od-francovinzon.vercel.app`
- **Repo:** GitHub `faustovinzon9-art/od-francovinzon`, rama `main` → deploy automático a Vercel (Hobby, plan gratuito) en cada push.
- **Dueño del proyecto en esta conversación:** Fausto (hijo del odontólogo), no programador.

## Arquitectura

Sitio **estático** (HTML/CSS/JS plano, sin build, sin framework) + **Vercel Serverless Functions** (Node.js, `googleapis`) para todo lo que necesita hablar con Google Calendar. **No usa Next.js** — cuidado con asumir convenciones de Next (App Router, `app/api/.../route.js`, etc.); las funciones son simplemente archivos `.js` bajo `api/` con `export default function handler(req, res)`, convención zero-config de Vercel.

No hay `middleware.js` ni `vercel.json` en el proyecto (se probaron y se sacaron en su momento — ver `decisions.md`).

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

## Límite de 12 Serverless Functions (plan Hobby de Vercel)

**Esto ya rompió un deploy entero una vez** (ver `changelog.md` 2026-08-05, "Fusionar rutas..."). El plan gratuito de Vercel permite **como máximo 12 Serverless Functions por deployment** — si se supera, **el build entero falla** (no solo la función de más) y producción se queda pegada en el último deploy bueno, sin ningún aviso claro salvo mirar el dashboard.

**Antes de agregar un archivo nuevo bajo `api/`**, contar cuántos hay y cuántos quedan libres. Si hace falta una ruta nueva y no hay margen, **fusionar en un archivo existente usando un campo `accion`/`modo` en el body o query** en vez de crear un archivo — patrón ya usado en `bloqueo-dia.js`, `evento.js` y `buscar.js` (ver `architecture.md`).

Archivos actuales bajo `api/` (11 de 12 — **queda 1 libre**):

```
api/disponibilidad-mes.js
api/horarios-dia.js
api/reservar.js
api/gestion/turnos-dia.js
api/gestion/crear-turno.js
api/gestion/bloqueo-dia.js
api/gestion/bloquear-horario.js
api/gestion/evento.js
api/gestion/buscar.js
api/gestion/proximo-bloqueo.js
api/gestion/agregar-telefono.js
```

Para utilidades de un solo uso (migraciones, scripts de limpieza): agregar el archivo, correrlo, **sacarlo del proyecto y hacer commit de la baja** ni bien confirma el resultado (patrón ya usado dos veces — limpieza de títulos viejos y rescate de teléfonos sueltos).

## Deploy: cosas a tener en cuenta

- Push a `main` dispara deploy automático en Vercel. **A veces tarda varios minutos** en propagar (no es un bug, es normal para este proyecto — no asumir que falló solo por tardanza).
- **Una vez el webhook de GitHub→Vercel no disparó** un deploy con un push válido; se resolvió con un commit vacío/trivial para forzar un nuevo push. Si un deploy no aparece en absoluto en el dashboard de Vercel después de varios minutos (no "Building", directamente no existe), sospechar esto antes que un error de código.
- **No hacer polling agresivo (loops cortos de curl) contra el dominio de producción** — en algún momento disparó el modo de protección anti-bot de Vercel (`x-vercel-mitigated: challenge`) y bloqueó el sitio real para visitantes reales, no solo para mí. Espaciar los chequeos (≥20-30s entre intentos) y avisar al usuario para que confirme desde su propio navegador en vez de insistir con requests automáticos.
- Al tocar rutas que llaman a Google Calendar API en un loop (migraciones, procesar muchos eventos): la cuota de Google es ~600 requests/min/usuario, **compartida con el tráfico real del sitio**. Usar lotes chicos (~40) secuenciales con una pausa (~150ms) entre llamadas, nunca `Promise.all` sobre muchos `events.patch`/`insert` a la vez.
