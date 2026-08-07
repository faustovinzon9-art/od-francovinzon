# Decisiones ya tomadas

Estas decisiones ya se discutieron y se implementaron a pedido explícito del usuario. **No revertirlas ni "corregirlas" por iniciativa propia** — si algo de esto parece raro, es a propósito; preguntar antes de cambiarlo.

## Arquitectura

- **Sin Apps Script, sin iframe.** El sistema viejo vivía en Google Apps Script embebido en un iframe; se migró 100% a Vercel Serverless + Calendar API propia porque Safari/iOS y los navegadores embebidos de Instagram/Facebook rompían el iframe por bloqueo de cookies de terceros. No volver a esa arquitectura.
- **Sin Next.js.** El proyecto es estático + Serverless Functions zero-config de Vercel. No asumir convenciones de Next.js (App Router, etc.) ni migrar a Next "para ordenar" sin que se pida.
- **Sin `attendees` en los eventos de Calendar.** Una cuenta de servicio sin domain-wide delegation no puede invitar asistentes — probado, tira error. El teléfono/email del paciente va como texto en la `description`, nunca como invitado. No se manda mail de confirmación (no hay para eso).
- **Fusionar rutas de API en vez de sumar archivos**, cuando el límite de 12 funciones del plan Hobby está ajustado. Ya se hizo con `bloqueo-dia.js`, `evento.js` y `buscar.js` (ver `architecture.md`). Preferir esto a crear un archivo nuevo si hay margen ajustado.
- **Scripts de migración/limpieza de un solo uso se sacan del proyecto después de correrlos**, ni bien se confirma el resultado (no quedan como funciones activas ocupando cupo).

## Teléfono

- **Teléfono obligatorio para todos los pacientes**, en `/turnos` y al crear turno/sobreturno desde `/gestion` (front y back). No hay checkbox que lo vuelva opcional — el checkbox "Soy paciente nuevo" en `/turnos` solo marca el dato, no afecta esta validación.
- **Excepción: "Editar teléfono" en `/gestion` permite guardar vacío**, específicamente para poder borrar un número mal cargado y dejarlo pendiente. Esta es la única función donde el teléfono no es obligatorio.
- **Formato guardado en la descripción: siempre normalizado, sin `+` ni espacios** — listo para `wa.me/<número>`. Ejemplo: `5493442403984`.

### Selector de país en vez de adivinar el código de área (2026-08-06)

**Se abandonó la idea de "adivinar" el código de área de un número corto.** El enfoque
viejo asumía que cualquier número sin código de país reconocible era de Argentina y,
en la práctica, terminaba tratando números cortos como si fueran siempre de la zona del
consultorio (Concepción del Uruguay, código 3442) — un problema real porque los
pacientes pueden ser de cualquier ciudad de Argentina o de cualquier país. Adivinar el
código de área a partir de un número corto no es algo que se pueda hacer bien de forma
genérica: la única fuente de verdad correcta es que la persona diga de qué país es.

- **Todos los campos de teléfono donde se carga un número nuevo** (`/turnos`, y en
  `/gestion`: nuevo turno, nuevo sobreturno, agregar/editar teléfono) usan
  `intl-tel-input` (CDN, versión fija `29.1.3`): bandera + código de país, buscador de
  país, default Argentina, cualquier país elegible. La persona escribe solo su número
  local; el país lo elige del selector, nunca se adivina.
- **Se manda al backend el E.164 que devuelve la librería** (`iti.getNumber()`, ej.
  `+543442403984`, `+59899123456`), validado antes con `iti.isValidNumber()`. El
  backend nunca reconstruye el número a mano con regex sobre texto libre — esa
  responsabilidad quedó 100% del lado de la librería, que tiene los datos reales de
  formato de cada país.
- **Comprobado empíricamente (no asumido): el E.164 que arma intl-tel-input/libphonenumber
  para un celular argentino NO incluye el "9" que WhatsApp necesita.** Ej.: para
  `3442 403984` con Argentina seleccionado, `getNumber()` devuelve `+543442403984`, sin
  el `9`. Se probó también con Buenos Aires (11) y Córdoba (351): mismo resultado, nunca
  aparece el `9`. Para Uruguay no hace falta ningún ajuste (`+59899123456` ya es lo que
  necesita `wa.me`). Por eso `telefonoParaWhatsApp()` en `lib/googleCalendar.js` agrega
  el `9` a mano en el paso de guardado, solo para números que empiezan con `54` y todavía
  no lo tienen (chequeo idempotente, no duplica el `9` si ya está). No hace falta volver
  a investigar esto — si algún día cambia el comportamiento de la librería, la función
  sigue siendo correcta igual porque el chequeo es defensivo.
- **El número final ya limpio (sin `+`, sin espacios) es lo que se guarda** en la
  descripción del evento, listo para `wa.me/<número>` — igual que antes, pero ahora la
  fuente es un E.164 real y validado, no una reconstrucción a mano.
- **`normalizarTelefonoWhatsApp()` (la lógica vieja que "adivinaba") se mantiene, pero
  solo como fallback de mejor esfuerzo para teléfonos cargados antes de este cambio**
  (turnos históricos, incluidos los ~242 rescatados por el script de un solo uso — ver
  changelog 2026-08-05). Esos números no tienen selector de país porque ya fueron
  tipeados en su momento; se les sigue mostrando un botón de WhatsApp con el mejor
  esfuerzo de siempre.
- **Un teléfono guardado que no pasa la validación se trata como "sin teléfono"** en
  `/gestion`: no se muestra un botón de WhatsApp roto, se muestra "+ Agregar teléfono"
  para que se pueda corregir ahí mismo.
- **El botón de WhatsApp de cada fila usa el ícono real del logo** (SVG, mismo path que "Escribinos por WhatsApp" del resto del sitio) — nunca un emoji de burbuja de mensaje genérica.
- **Mensaje precargado del botón de WhatsApp (recordatorio, `/gestion`)**: cálido, y con la fecha/hora armada dinámicamente ("hoy" / "mañana" / "el X de mes") según el turno real. Explícitamente **sin** agregar "con el Dr. Franco Vinzón" ni "Te esperamos" — mantenerlo así salvo pedido en contra. **Sin emoji** (ver "WhatsApp: los emoji se corrompen en `wa.me`/`api.whatsapp.com`" más abajo — se probaron y se sacaron a propósito, no es un olvido).
- **Botón de WhatsApp en TODAS las filas con teléfono válido**, no solo en las de "paciente nuevo". El badge dorado "Nuevo paciente" y el teléfono en tamaño grande siguen siendo exclusivos de `esNuevoPaciente: true`.

### Badge "⚠ Tel. inválido": criterio es formato, no origen del dato (2026-08-06, corregido)

**Se corrigió el criterio del badge de la fila de `/gestion`.** La primera versión lo
mostraba en cualquier teléfono sin la marca `Teléfono verificado: Sí` — es decir,
cualquier número cargado antes del selector de país, aunque estuviera perfectamente
bien. Eso era demasiado agresivo: marcaba como "a revisar" pacientes cuyo teléfono
legado ya funcionaba bien, solo por no haber pasado por el flujo nuevo.

- **El badge ahora aparece únicamente cuando el teléfono guardado no pasa la
  validación real de formato** — el mismo chequeo que arma el link de `wa.me`
  (`armarLinkWhatsApp()` / `waLinkBase`, que a su vez usa `normalizarTelefonoWhatsApp()`
  para los no verificados). Si el número tiene formato válido, no se muestra nada,
  **tenga o no** la marca `Teléfono verificado: Sí` — el origen del dato (selector nuevo
  vs. legado) ya no es parte del criterio.
- Un número con formato válido pero un dígito equivocado (ej. un 3442 real pero mal
  tipeado) **no** se marca preventivamente: eso se nota solo cuando la secretaria
  intenta mandar el WhatsApp y no anda, no hace falta que el sistema lo adivine antes.
- El texto del badge pasó de "⚠ Tel. a revisar" a **"⚠ Tel. inválido"**, más preciso
  para el nuevo criterio.
- `Teléfono verificado: Sí` / `extraerTelefonoVerificado()` **se siguen escribiendo y
  leyendo**, pero ahora solo para una cosa: decidir, al abrir "Editar tel.", si el
  teléfono guardado ya es un E.164 limpio (se le antepone `+` antes de `setNumber()`) o
  si es texto legado (se pasa tal cual, para que la librería lo interprete con el país
  por default). Ya no alimentan ningún badge ni ninguna tarea del sidebar.

### WhatsApp: los emoji se corrompen en `wa.me`/`api.whatsapp.com` (2026-08-06)

**Comprobado empíricamente, no es un problema de nuestro código.** El mensaje
precargado del botón de WhatsApp de `/gestion` (`mensajeRecordatorio()`) tenía 😊🦷.
Se armaba con `encodeURIComponent()` correctamente (verificado: produce el UTF-8
percent-encoded correcto, `%F0%9F%98%8A` para 😊, etc. — el archivo fuente también
tiene los bytes UTF-8 correctos, no hay mojibake). El problema aparece **después**, del
lado de WhatsApp: se probó navegando a la URL real de `wa.me` con `?text=` conteniendo
distintos emoji (😊, 🦷, ✅, ⏰, 👍 — mezcla de rango BMP y astral) y **los cinco**
terminan reemplazados por el carácter de reemplazo Unicode "�", y esa corrupción ya
está en el propio `href` que arma la página de WhatsApp hacia `web.whatsapp.com`
(`text=...%EF%BF%BD...`) — o sea que pasa en el servidor/script de WhatsApp, antes de
llegar al chat real. El texto sin emoji (acentos, signos de exclamación) se ve
perfecto.

- **Se sacaron los emoji del mensaje precargado.** No hay forma de garantizar que se
  vean bien desde nuestro lado — es una limitación de la plataforma de WhatsApp, no
  nuestra. Si en el futuro se quiere reintentar, probar primero a mano navegando a un
  `wa.me/<numero>?text=<encodeURIComponent(mensaje)>` real antes de asumir que ya
  funciona.
- Los emoji que son **texto plano de la interfaz** (🔄 Mover, 🗑 Cancelar, ✨ Nuevo
  paciente, badges) no se ven afectados — el bug es específico del parámetro `text` de
  wa.me, no de emoji en general.

### Lista de tareas del sidebar: solo "sin teléfono" y "días bloqueados con turnos" (2026-08-06, corregido)

**Se sacó la categoría "corregir teléfono a revisar/inválido" de la lista de tareas.**
Un teléfono con formato inválido ya se marca con el badge de la fila (ver arriba); no
hace falta que además genere una tarea separada en el sidebar — sería redundante.

- La lista de tareas ahora tiene exactamente dos categorías, ambas de datos reales
  (`buscar.js?modo=tareas`, ver `architecture.md`):
  - **"Agregar teléfono"**: turnos/sobreturnos sin ninguna línea de teléfono cargada.
  - **"Reorganizar turnos" (bloqueo con turnos)**: cada bloqueo —día completo con
    "Bloquear un día completo" O rango horario puntual con "Bloquear un horario"— que
    todavía tiene turnos o sobreturnos superpuestos en su rango real. Botón "Ir al día"
    — no abre ningún editor, solo navega: mover/cancelar cada turno se hace con las
    acciones que ya existen en la fila de la agenda.
- Rango: hoy en adelante, 14 días — igual que antes.

### "Reorganizar turnos" también para horarios parciales, y siempre primero (2026-08-06)

**Se extendió la tarea "Mover N turnos" (que solo cubría días bloqueados por completo)
para que también cubra bloqueos de rango horario puntual** (`bloquear-horario.js`), y
se renombró a "Reorganizar turnos del [fecha]" para reflejar ambos casos.

- **Una tarea por cada bloqueo, no por día**: si el mismo día tiene dos bloqueos
  distintos con turnos superpuestos (ej. dos horarios puntuales separados), son dos
  tareas separadas, cada una navegando al mismo día. No se agrupan por fecha porque
  cada bloqueo es una acción de reorganización independiente.
- **El solapamiento se calcula con los límites reales del bloqueo** (`eventBounds`:
  hora exacta para un bloqueo de horario puntual, 00:00→00:00 del día siguiente para
  uno de día completo), no por "mismo día calendario" — así un turno a las 8:00 no
  genera una tarea de reorganización si el bloqueo puntual es de 14:00 a 16:00 y no
  hay ningún turno en ese rango.
- **Prioridad fija en el sidebar**: las tareas "Reorganizar turnos" van siempre
  primero, antes que "Agregar teléfono" — ya no se mezclan cronológicamente entre
  categorías (antes sí, ordenadas todas juntas por fecha). Dentro de cada categoría
  se sigue ordenando por fecha ascendente.

### Destacado visual "urgente" para "Reorganizar turnos" + resumen compacto en mobile (2026-08-06)

- **Las tareas "Reorganizar turnos" se destacan con un rojo suave, a propósito NO
  saturado/agresivo** (`rgba(193,68,55,.07)` de fondo, borde `rgba(193,68,55,.2)`,
  título en `var(--bloqueo)`) más un ícono ❗ al lado — pedido explícito: que se note
  que hay que resolverlas antes que "Agregar teléfono", sin invadir la vista. "Agregar
  teléfono" queda con el estilo neutro de siempre — el destacado es exclusivo de
  `.task-item.urgent` (`t.modo === 'ir-dia'`). Se aplica igual en el sidebar de
  desktop y en el modal de mobile, mismo helper `renderTaskItemHtml()`.
- **El resumen del sidebar (saludo, turnos hoy, huecos libres) antes solo existía en
  desktop (≥1000px)** — en mobile no se veía nada de eso. Se agregó `.mobile-summary`:
  misma identidad visual (mismos títulos/colores/tipografía) pero como franja
  horizontal compacta arriba de la agenda, no como columna lateral — así no ocupa
  media pantalla. La lista de tareas completa NO se repite ahí (sería demasiado alto
  para una franja compacta): en su lugar, un botón "Tareas pendientes (N)" que abre
  un modal (`#tasks-modal-overlay`, mismo patrón visual que `confirmDialog()`) con la
  lista COMPLETA de tareas — a propósito sin el tope de 6 que tiene el sidebar de
  desktop, porque en el modal no hay problema de espacio vertical (tiene scroll
  propio). Botón oculto si no hay tareas pendientes.
- **Desktop (≥1000px) no se tocó**: `.mobile-summary` se oculta con
  `@media (min-width: 1000px)`, igual que `.search-mobile`. El único cambio visible
  en desktop es el destacado rojo de "Reorganizar turnos" en el sidebar, que también
  se pidió ahí explícitamente.

## Título y descripción de eventos

- **Título del evento: solo `"Nombre Apellido"`**, sin prefijo "Turnos" ni paréntesis (se limpiaron ~242 eventos viejos con formato `"Turnos (Nombre)"` en una migración de un solo uso).
- **Descripción con formato de líneas fijo**: `Teléfono: X` / `Motivo: X` / (en turnos de paciente) `Paciente nuevo: Sí|No`. El parseo (`extraerTelefono`, `extraerEsNuevoPaciente`) busca estas etiquetas en cualquier parte del texto, no en una posición fija, y tolera HTML viejo de Apps Script.
- **Eventos viejos sin estas líneas no rompen nada** — todo lo que las lee tiene un default seguro (`telefono: ''`, `esNuevoPaciente: false`).

## Sobreturnos

- **Los sobreturnos se cargan a propósito superpuestos** con turnos normales — es su función (meter un huequito extra en un horario ya ocupado). Por eso "Nuevo sobreturno" sigue con hora libre a mano (sin calendario de disponibilidad) y su chequeo de solapamiento es solo contra el calendario de sobreturnos, nunca contra el principal.
- **"Nuevo turno" (calendario principal) sí usa el mismo selector de calendario + horarios reales que ven los pacientes en `/turnos`** (reutiliza `/api/disponibilidad`, antes `disponibilidad-mes.js`+`horarios-dia.js`, fusionados en 2026-08-06), para no calcular disponibilidad de dos formas distintas.
- **El QR del ticket térmico no ofrece "Cambiar día y horario" para sobreturnos**, solo para turnos del calendario principal. El selector de `/turno` (calendario mensual + horarios de 30 min, copiado de `/turnos`) está construido enteramente alrededor de `CALENDAR_ID`/`SLOT_MINUTES` — no tiene forma de mostrar la disponibilidad real de sobreturnos (15 min, se permiten superpuestos a propósito) sin duplicar esa UI desde cero. Se evaluó y se descartó por alcance: el QR de un sobreturno sí permite ver el turno y cancelarlo (ambas acciones son agnósticas del calendario, solo necesitan el `calendarId` correcto), pero reprogramarlo se sigue haciendo desde `/gestion`, como siempre. Si en el futuro se quiere reprogramar sobreturnos desde el QR, hay que construir un selector de horarios específico para sobreturnos — no es una extensión chica de lo que ya existe.

### Página propia `/turno` para el QR, en vez de reusar `/turnos?eventId=` (2026-08-07)

**El QR del ticket ahora apunta a `/turno` (página nueva), no a `/turnos?eventId=`.** Se pidió explícitamente una pantalla distinta de la confirmación post-reserva, con su propio título ("Detalles de tu turno", nunca "Reservar turno") y su propio diseño de resultado — mismo brand navy/dorado/crema, pero sin el ✓ verde ni el texto "Turno confirmado" que usa `/turnos` después de reservar. Se armó como archivo HTML separado (`turno/index.html`) en vez de agregar un modo/vista más a `/turnos`, porque el pedido era justamente que se sintiera como una pantalla aparte, no una variante de la misma. Reusa `api/reservar.js` tal cual (sin tocarlo); el calendario/horarios/reprogramar/cancelar quedaron duplicados de `/turnos` (no hay bundler) — cualquier cambio a esa lógica compartida hay que replicarlo a mano en las dos páginas si aplica a ambas. El punto de entrada viejo (`?eventId=` en `/turnos`) se dejó intacto por compatibilidad con tickets ya impresos, no se le suman features nuevas de ahí en más.

### Radio de `/gestion`: tarjeta en vez de ícono flotante, y fundido secuencial al cambiar (2026-08-07)

**Se sacó el botón circular + panel popup de la radio** (abajo a la izquierda) y se reemplazó por una tarjeta bien visible dentro del sidebar (desktop, después de "Tareas pendientes") y debajo del resumen compacto (mobile) — pedido explícito: "no un círculo chiquito como el del chat". FM Milenium se sacó de la lista de 5 y se reemplazó por Jazz 24hs (Blackie FM), a pedido explícito.

**El fundido de 3s al cambiar de estación es secuencial, no una superposición real de dos audios.** Solo hay un `<audio>` compartido (igual que antes): al cambiar de estación con algo sonando, primero se baja el volumen de la actual a 0 en 3 segundos, recién ahí se cambia el `src` y se sube la nueva de 0 a 1 en otros 3 segundos — nunca suenan las dos al mismo tiempo. Esto coincide con la descripción exacta que se pidió ("bajar el volumen de la actual... hasta silenciarla, y al reproducir la nueva, subir su volumen"), y evita sumar un segundo elemento `<audio>` solo para un cruce que no se pidió que fuera simultáneo. Pausar la estación que ya está sonando (sin elegir otra) sigue siendo instantáneo — no se pidió fundido para ese caso, sería raro tardar 3s en silenciar algo que la persona quiere cortar ya.

## Confirmación de turno en `/turnos`: acciones post-reserva (2026-08-06)

- **"Agregar al calendario"**: genera un `.ics` 100% en el cliente (sin librerías, sin
  ruta de API nueva) a partir de `fechaSeleccionada`/`horarioSeleccionado`. Argentina es
  siempre UTC-3 fijo, así que el `DTSTART`/`DTEND` del `.ics` se arman sumando 3 horas a
  la hora Argentina para obtener UTC — mismo principio que `toArgDate()` del lado
  servidor, sin necesitar esa función en el cliente.

### "Agregar al calendario": dos botones, sin `download`, más Google Calendar (2026-08-06)

**El botón único original forzaba la descarga del `.ics`** (atributo `download` en el
link) — en iPhone eso manda el archivo a la app Archivos en vez de abrir Calendar
directamente, que era el objetivo. Se cambió a dos opciones:

- **"Agregar a Apple Calendar"**: mismo `.ics` de siempre, pero SIN `download` — se
  navega directo al blob (`Content-Type: text/calendar;charset=utf-8`), que según el
  comportamiento documentado de iOS Safari debería interceptar la navegación y abrir la
  pantalla nativa "Agregar evento" en vez de descargar. **No se pudo confirmar en un
  iPhone real ni en el Simulador** (esta máquina no tiene Xcode completo, solo Command
  Line Tools) — ver `tasks.md`. Si en un iPhone real sigue yendo a Archivos (o similar)
  en vez de abrir Calendar directo, **sacar este botón** y dejar solo el de Google
  Calendar, que no tiene esta incertidumbre.
- **"Agregar a Google Calendar"**: link directo a
  `calendar.google.com/calendar/render?action=TEMPLATE&...` con los datos del turno
  (mismo texto/ubicación/descripción que el `.ics`), sin ningún archivo de por medio —
  abre Google Calendar (app o web) directo, en pestaña nueva.
- **`limitesUTC(fechaStr, horaStr)` centraliza el cálculo UTC±3** usado tanto por
  `construirICS()` como por `armarLinkGoogleCalendar()`, para no duplicar la lógica de
  "Argentina es siempre UTC-3" en dos lugares.
- **Los links se arman con `actualizarLinksCalendario()`** cada vez que se muestra
  `post-actions-card` (al confirmar Y al reprogramar), no una sola vez al cargar la
  página — la fecha/hora puede cambiar. El blob URL anterior se revoca
  (`URL.revokeObjectURL`) antes de crear uno nuevo, para no acumular blobs sin usar.
- **"Cambiar día y horario" / "Cancelar turno": sin link persistente, a propósito.**
  Se evaluó el esquema original que tenía pensado `tasks.md` (token en la URL o
  derivado del `eventId`, para volver a un turno después de haberse ido de la página) y
  **se descartó por alcance**: lo que se pidió esta vez es mucho más acotado —
  corregir un error *en el momento*, sin reiniciar el formulario, no dar
  autogestión persistente. Por eso:
  - El `eventId` que devuelve `/api/reservar` al crear el turno **vive solo en una
    variable JS en memoria** (`ultimoEventId`) durante esa carga de página. No se pone
    en la URL, no se guarda en `localStorage`/`sessionStorage`. Al recargar la página
    se pierde — es intencional, no un descuido.
  - `reservar.js` (público, sin `GESTION_KEY`) acepta `accion: 'mover'|'cancelar'`
    además de crear (que sigue siendo el default). Ambas acciones ignoran cualquier
    `calendarId` — están **hardcodeadas a `CALENDAR_ID`**, porque los pacientes nunca
    reservan sobreturnos; así no hay que confiar en ese dato si viniera del cliente.
  - La seguridad depende de que el `eventId` de Google Calendar es un string de alta
    entropía, no listado en ningún lado público — es el mismo modelo que ya usa
    `agregar-telefono.js`/`evento.js` del lado de `/gestion` (conocer el id alcanza).
    Si en el futuro se quiere una autogestión real después de cerrar la pestaña (el
    ítem 6 original, con link para volver más tarde), hay que retomar el diseño de
    token que ya se había pensado — esto no lo reemplaza, es un caso más chico y más
    seguro (todo pasa en la misma sesión, nunca se comparte un link).
  - "Cambiar día y horario" reutiliza el mismo calendario/horarios que ya estaba
    visible en la página (no hace falta un formulario nuevo de nombre/teléfono/motivo,
    esos datos no cambian) — solo pide confirmar el nuevo horario elegido.

### Resaltado del texto de confirmación, transición de entrada, y celebración para paciente nuevo (2026-08-06)

- **"Turno confirmado para..." (`p#success-text` / `p#success-text-nuevo`) más grande,
  negrita y en verde `--confirmado` (`#4F9A3C`)** — variable nueva, distinta de
  `--success` (que ya usaba el ícono ✓ circular) y de `--gold`, para no pisar esos usos.
  Aplica al mismo mensaje del backend en los dos casos (paciente nuevo y recurrente,
  incluida la reprogramación) porque es el mismo elemento/clase (`.success-highlight`)
  en los tres casos.
- **Transición de entrada de las pantallas de éxito (fade + `translateY`, 220ms
  `ease`)** reemplaza el aparecer/desaparecer instantáneo de `.hidden`. Se dispara con
  `mostrarCardAnimada(el)`: saca `.hidden`, fuerza reflow (`el.offsetWidth`) y agrega
  `.card-visible` en el frame siguiente — el reflow es necesario para poder repetir la
  animación cada vez (ej. reprogramar pasa por la misma tarjeta más de una vez en la
  misma carga de página).
- **"¡Bienvenido/a!" con rebote sutil**: una sola animación `scale(0.4)→scale(1)` con
  curva `cubic-bezier(0.34, 1.56, 0.64, 1)` (easeOutBack) — el overshoot de esa curva ya
  da el efecto de "zoom-in y asentarse" sin necesitar keyframes de varios pasos. Se
  retriggerea con el mismo truco de quitar/forzar reflow/poner la clase.
- **Confeti solo para paciente nuevo**: ráfaga corta (26 piezas, ~1-1.5s, colores
  navy/dorado/blanco de la marca) cayendo desde arriba de la pantalla, sin librería
  (unos `div` con `@keyframes` + variables CSS por pieza para la aleatoriedad). A
  propósito **sutil y corto** (pedido explícito: "no una lluvia larga") y con
  `pointer-events: none` para que nunca tape ni bloquee los botones de abajo (WhatsApp,
  agregar al calendario). Los nodos se sacan del DOM con `setTimeout` apenas termina, no
  quedan acumulando en la página.
- Ninguna de estas cuatro cosas toca la pantalla de "turno cancelado" ni el diálogo de
  confirmación de cancelación — son específicas de las pantallas de éxito.

## Toasts, diálogo de confirmación propio y actualizaciones locales en `/gestion` (2026-08-06)

- **Toasts solo para 4 acciones** (a propósito, "sin exagerar la cantidad" fue pedido
  explícito): turno creado, turno reprogramado, turno eliminado, cambios guardados
  (edición de teléfono). No se agregaron a bloquear/desbloquear día ni a bloquear
  horario — no estaban en la lista pedida.
- **`confirm()` nativo reemplazado en los dos lugares donde existía**: cancelar turno
  ("Eliminar turno" — texto explícitamente pedido) y desbloquear día (mismo componente
  reutilizado, por consistencia — no se pidió un texto puntual para ese caso). Un solo
  `confirmDialog({title, message, confirmLabel, cancelLabel})` genérico, devuelve una
  Promise<boolean>, estilo propio de la app.
- **Actualizaciones locales sin refetch, para evitar el parpadeo de "Cargando
  agenda..."**: editar/agregar teléfono y cancelar turno mutan `agendaItems` en memoria
  con lo que ya devolvió el servidor (por eso `agregar-telefono.js` ahora devuelve
  `telefono`/`telefonoVerificado` en la respuesta) y llaman a `renderAgenda()` local
  (sin volver a pedir el día completo). Crear y mover turno sí necesitan un fetch
  (pueden aterrizar en un día distinto al que se está mirando), pero después resaltan
  la fila nueva/movida (`resaltarEvento()`) en vez de dejar la navegación "seca".
  Este patrón es deliberadamente distinto de una reescritura a diffing/virtual-DOM —
  alcanza para que no haya re-render completo de la lista en las acciones más
  frecuentes, sin sumar una librería ni una capa de abstracción nueva.

## Buscador de `/gestion` (2026-08-06)

- **Reposicionado**: en el sidebar desktop, ahora va inmediatamente debajo de
  saludo/fecha, arriba del resumen del día y de la lista de tareas.
- **Se saca el botón "Volver a la agenda"**: vaciar el campo de búsqueda (borrar todo
  el texto) vuelve sola a la vista Día. No hace falta debounce para este caso — se
  dispara apenas el input queda vacío.
- **"Nuevo turno" en `/gestion` suma la casilla "Paciente nuevo"**, igual que en
  `/turnos` — `crear-turno.js` ahora acepta `esNuevo` y escribe la misma línea
  `Paciente nuevo: Sí|No` que ya escribía `reservar.js`. Antes solo `/turnos` podía
  generar el badge dorado "✨ Nuevo paciente"/teléfono destacado en la agenda; ahora
  también se puede marcar a mano desde `/gestion`. No se agregó a "Nuevo sobreturno"
  (no se pidió, y `/turnos` tampoco ofrece reservar sobreturnos).

## Zona horaria

- **Nunca usar getters locales de `Date` para "hoy"/"ahora"** en código que corre en el navegador (afecta a cualquier visitante en otro huso horario). Siempre `Intl.DateTimeFormat` con `timeZone: 'America/Argentina/Buenos_Aires'` explícito. Ya hubo un bug real de esto, corregido — no reintroducirlo.

## Deploy / operación

- **No hacer polling en loop corto contra el dominio de producción** desde herramientas automatizadas — ya disparó el modo de protección anti-bot de Vercel una vez y bloqueó el sitio real. Espaciar los chequeos y, si hace falta confirmación rápida, pedirle al usuario que mire desde su propio navegador.
