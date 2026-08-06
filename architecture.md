# Arquitectura y estructura de archivos

Ver `CLAUDE.md` para el contexto general primero.

## Estructura de archivos

```
/index.html              Home pública del consultorio
/styles.css              Estilos de la home (turnos y gestión tienen CSS inline propio)
/assets/                 Logos, isologo, foto del consultorio

/turnos/index.html        Página de reserva de turnos para pacientes (/turnos)
/gestion/index.html       Panel de gestión para la secretaria (/gestion)

/lib/googleCalendar.js    Helpers compartidos: cliente de Calendar API, constantes,
                          zona horaria, parseo de teléfono/motivo/paciente nuevo,
                          normalización de teléfono para WhatsApp

/api/*.js                 Rutas públicas (sin key) que usan los pacientes desde /turnos
/api/gestion/*.js         Rutas protegidas con GESTION_KEY que usa /gestion

package.json              Dependencia: googleapis. Sin build step (Vercel instala solo).
```

No hay `middleware.js`, no hay `vercel.json`, no hay Next.js.

### Dependencia externa por CDN: intl-tel-input

`/turnos/index.html` y `/gestion/index.html` cargan `intl-tel-input` (versión fija
`29.1.3`, sin bundler, vía `<link>`/`<script>` a `cdn.jsdelivr.net`, igual que Google
Fonts) para el selector de país + bandera en todos los campos de teléfono nuevos. No es
una dependencia de `package.json` porque no hay build step del lado del cliente. Ver
`decisions.md` para el porqué y el comportamiento comprobado empíricamente.

## `lib/googleCalendar.js` — qué expone

- `CALENDAR_ID`, `SOBRETURNOS_CALENDAR_ID` — IDs de los dos calendarios (ver `CLAUDE.md`).
- `TIME_ZONE` — `'America/Argentina/Buenos_Aires'`.
- `SLOT_MINUTES` (30), `SOBRETURNO_MINUTES` (15) — duración de cada tipo de turno.
- `CLINIC_ADDRESS`, `BLOCK_MARKER` (texto que marca un evento como bloqueo en la `description`).
- `WEEKLY_SCHEDULE` — horario de atención por día de semana (0=domingo…6=sábado), rangos `["08:00","15:00"]` etc. Los martes tienen dos rangos (mañana y tarde).
- `isValidGestionKey(key)` — valida contra `process.env.GESTION_KEY`.
- `toArgDate(dateStr, timeStr)` — arma un `Date` real en hora Argentina desde strings.
- `pad2(n)`, `formatArgTime(date)`, `formatArgDay(date)` — helpers de formato, siempre vía `Intl.DateTimeFormat` con `timeZone` explícito.
- `eventBounds(ev)` — devuelve `{start, end}` como `Date` reales para cualquier evento de Calendar API (con hora o de todo el día).
- `extraerTelefono(description)` — busca `Teléfono: X` en cualquier parte del texto (case/acento-insensible en el label, tolera HTML viejo de Apps Script). Devuelve `''` si no hay o si es `-`.
- `extraerEsNuevoPaciente(description)` — busca `Paciente nuevo: Sí/No`. Default `false` si no está la línea (eventos viejos).
- `extraerTelefonoVerificado(description)` — busca `Teléfono verificado: Sí`. La marcan `reservar.js`, `crear-turno.js` y `agregar-telefono.js` cuando el teléfono vino del selector de país (intl-tel-input). Default `false` para eventos viejos — así `/gestion` sabe qué teléfonos son "pendiente de revisión manual". Ver `decisions.md`.
- `normalizarTexto(str)` — minúsculas + sin acentos, para comparar nombres.
- `telefonoParaWhatsApp(e164)` — **la que se usa para guardar teléfonos nuevos.** Toma el E.164 que devuelve intl-tel-input (`+543442403984`, `+59899123456`, ...) ya validado del lado del cliente, saca el `+`, y para Argentina agrega el `9` que WhatsApp necesita y que intl-tel-input/libphonenumber no incluye por default (comprobado empíricamente, ver `decisions.md`). No adivina nada — el país lo eligió la persona en el selector.
- `normalizarTelefonoWhatsApp(raw)` — **legado, solo para teléfonos cargados antes del selector de país.** Limpia símbolos, reconoce código de país ya presente (54/598 con largo plausible) o asume Argentina (saca 0 y 15, antepone 549) — la lógica de "adivinar" que se abandonó para carga nueva (ver `decisions.md`). Se sigue usando en `gestion/index.html` solo para armar un WhatsApp de mejor esfuerzo en turnos viejos sin `Teléfono verificado: Sí`. **Hay una copia casi idéntica en JS plano dentro de `gestion/index.html`** (no hay bundler para compartir código entre server y cliente) — no tocar salvo para ese propósito puntual.
- `getCalendarClient()` — cliente autenticado (`google.auth.JWT`) listo para usar.

## `/api/*.js` — rutas públicas (paciente, sin auth)

- **`disponibilidad-mes.js`** — `GET ?year&month`. Devuelve `{ "1": bool, "2": bool, ... }` por día del mes: `true` si queda algún slot libre según `WEEKLY_SCHEDULE` y lo ya ocupado en `CALENDAR_ID`.
- **`horarios-dia.js`** — `GET ?date`. Devuelve array de horarios libres (`"HH:mm"`) para ese día puntual.
- **`reservar.js`** — `POST { date, time, nombre, apellido, telefono, motivo, esNuevo }`. `telefono` llega en E.164 (`+549...`) desde el selector de país del cliente. Valida obligatorio + `telefonoParaWhatsApp`, chequea que el slot siga libre, crea el evento en `CALENDAR_ID` (sin `attendees`). Título: `"Nombre Apellido"`. Descripción: `Teléfono: / Teléfono verificado: Sí / Motivo: / Paciente nuevo: Sí|No / ...`.

## `/api/gestion/*.js` — rutas protegidas (`key` = GESTION_KEY)

Todas devuelven `401` sin ejecutar nada si `key` no matchea.

- **`turnos-dia.js`** — `GET ?date&key`. Agenda fusionada de AMBOS calendarios ese día, ordenada por hora. Cada item: `{ id, calendarId, start, end, title, description, tipo: "turno"|"sobreturno"|"bloqueo", allDay, telefono, esNuevoPaciente, telefonoVerificado }`.
- **`crear-turno.js`** — `POST { key, date, time, nombre, apellido, telefono, motivo, sobreturno }`. `telefono` en E.164 desde el selector de país. Obligatorio + normalizado con `telefonoParaWhatsApp`. `sobreturno: true` → calendario/duración de sobreturno; si no, turno normal. Chequea solapamiento en el calendario correspondiente.
- **`bloqueo-dia.js`** — `POST { key, date, motivo, accion: "bloquear"|"desbloquear" }`. Bloquear = evento de todo el día `"No atiende"` con `BLOCK_MARKER` en la descripción. Desbloquear = busca y borra ese evento all-day para esa fecha. (Fusiona lo que antes eran `bloquear-dia.js` + `desbloquear-dia.js`.)
- **`bloquear-horario.js`** — `POST { key, date, horaInicio, horaFin, motivo }`. Bloqueo puntual (no todo el día) con el mismo `BLOCK_MARKER`.
- **`evento.js`** — `POST { key, eventId, calendarId, accion: "mover"|"cancelar", nuevaFecha, nuevaHora, motivo }`. Mover: conserva duración original, chequea solapamiento contra el resto de eventos de ese calendario, si viene `motivo` reemplaza la línea `Motivo:` en la descripción. Cancelar: `events.delete`. (Fusiona lo que antes eran `mover.js` + `cancelar.js`.)
- **`buscar.js`** — cuatro modos en un mismo archivo, según query:
  - Sin `modo` (o `?q=texto`) — búsqueda del buscador del sidebar: full-text en ambos calendarios, ±6 meses, devuelve eventos completos.
  - `?modo=telefono&nombre=X` — usado por el autocompletado on-blur de los formularios de nuevo turno/sobreturno: devuelve `{ telefono }` del evento más reciente (±1 año / +3 meses) cuyo título matchee y tenga teléfono.
  - `?modo=pacientes&q=X` — dropdown en vivo mientras se escribe el nombre: hasta 8 `{ nombre, telefono }` únicos, agrupados por nombre normalizado (±2 años / +3 meses), con el teléfono del evento más reciente que tenga uno.
  - `?modo=tareas-telefono` — alimenta la lista de tareas del sidebar (ver más abajo): turnos/sobreturnos de hoy en adelante (14 días, sin bloqueos) sin teléfono o con teléfono sin `Teléfono verificado: Sí`. Devuelve `{ sinTelefono: [...], aRevisar: [...] }`, cada item `{ id, calendarId, title, start, telefono? }`.
  (Fusiona lo que antes era `buscar.js` + `buscar-telefono.js`, para no sumar un archivo.)
- **`proximo-bloqueo.js`** — `GET ?key`. Busca (`q=BLOCK_MARKER`) el próximo evento de todo el día bloqueado a partir de hoy (120 días de ventana). Usado por el resumen del sidebar.
- **`agregar-telefono.js`** — `POST { key, eventId, calendarId, telefono }`. Agrega o **reemplaza** (no duplica) la línea `Teléfono:` de la descripción. `telefono` vacío = borra el número (escribe `Teléfono: -` y saca la línea `Teléfono verificado:`) — es el único lugar donde el teléfono NO es obligatorio. `telefono` no vacío llega en E.164 desde el selector de país y pasa por `telefonoParaWhatsApp`; si no valida, rechaza con mensaje. También agrega/reemplaza `Teléfono verificado: Sí`.

## `gestion/index.html` — estructura del panel

Una sola página, vanilla JS (sin framework), con estado en memoria (variables JS, no hay store). Piezas principales:

- **Login**: pide `GESTION_KEY`, la guarda en `sessionStorage` (se borra si el server devuelve 401 en cualquier momento).
- **Sidebar (desktop, ≥1000px)**: logo, saludo, resumen del día (turnos hoy, huecos libres hoy vía `/api/horarios-dia`, próximo día bloqueado vía `/api/gestion/proximo-bloqueo`), **lista de tareas inteligente** (ver abajo), buscador de pacientes. En mobile el buscador se duplica en una fila propia fuera del sidebar (que se oculta bajo 1000px) — la lista de tareas es exclusiva del sidebar desktop, igual que el resto del resumen.
- **Lista de tareas inteligente**: debajo del resumen del día, vía `buscar.js?modo=tareas-telefono` (se pide en el mismo `Promise.all` de `cargarResumenSidebar()`). Dos tipos de tarea, generadas de datos reales (no hardcodeadas): "Confirmar teléfono" (turnos con `telefonoVerificado: false` y teléfono cargado — mismo criterio que el badge `⚠ Tel. a revisar`) y "Agregar teléfono" (turnos sin ninguna línea de teléfono). Rango: hoy en adelante, 14 días, sin bloqueos. Se muestran como máximo 6, con un contador "+N pendientes más" si hay más. Cada tarea tiene un botón que navega al día del turno y abre ahí mismo el mismo flujo inline de "Editar/Agregar teléfono" de la fila de la agenda (`irYEditarTelefono()` → `cambiarVista('dia')` → busca el índice del evento en `agendaItems` → `abrirAgregarTelefonoInline()`), sin que la secretaria tenga que buscar al paciente a mano. Si no hay tareas, la sección entera queda oculta (no se muestra un cartel de "sin pendientes").
- **Vistas**: Día (agenda normal), Semana (7 tarjetas resumen, sin acciones, click lleva a Día), Búsqueda (resultados de `buscar.js` en modo default, con Mover/Cancelar reutilizando las mismas funciones que la agenda).
- **Acciones por fila**: WhatsApp (ícono real, mensaje dinámico según hoy/mañana/fecha) si hay teléfono válido; si no, "+ Agregar teléfono" inline; si hay teléfono, además "Editar tel." inline (con selector de país, se inicializa al vuelo sobre el input recién creado — ver `abrirAgregarTelefonoInline`). Mover (ícono 🔄, abre selector de calendario para turnos o campos simples para sobreturnos, permite editar motivo también). Cancelar.
- **Badge "⚠ Tel. a revisar"**: aparece en filas con teléfono cargado antes del selector de país (`telefonoVerificado: false` pero con teléfono). El WhatsApp de mejor esfuerzo se sigue mostrando, pero la secretaria sabe que conviene confirmarlo con "Editar tel.". Ver `decisions.md`.
- **Paciente nuevo**: badge dorado + teléfono destacado en la fila cuando `esNuevoPaciente` es `true`.
- **Autocompletado de pacientes**: dropdown en vivo (debounce 300ms, ≥3 caracteres) en los campos Nombre de "Nuevo turno" y "Nuevo sobreturno", vía `buscar.js?modo=pacientes`.

## `turnos/index.html` — flujo del paciente

Calendario mensual (`disponibilidad-mes`) → horarios del día (`horarios-dia`) → formulario (nombre, teléfono obligatorio con selector de país, checkbox "Soy paciente nuevo", motivo) → `POST /api/reservar`. El teléfono usa `intl-tel-input` (default Argentina, cualquier país elegible con buscador); se valida con `isValidNumber()` y se manda `getNumber()` (E.164) al backend. Si tildó "paciente nuevo", pantalla de éxito especial con logo, saludo cálido y botón de WhatsApp al número general (mensaje precargado). Si no, cartel de éxito genérico.

**No** detecta navegadores embebidos (Instagram/Facebook/TikTok) — hubo una versión que sí lo hacía (vía `middleware.js`, ya borrado), pero se resolvió de raíz al sacar el iframe de Apps Script: como `/turnos` ahora es una página propia sin sesión de Google de por medio, el problema que afectaba a esos navegadores desapareció solo. Ver `decisions.md`.
