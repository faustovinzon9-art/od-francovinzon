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
  esfuerzo de siempre, pero además se marcan como **"pendiente de revisión manual"**
  (badge `⚠ Tel. a revisar` en la fila de `/gestion`, ver `telefonoVerificado` más abajo)
  en vez de darse por válidos a ciegas. La secretaria los puede confirmar o corregir
  desde "Editar tel.", que ya usa el selector de país nuevo.
- **Marca `Teléfono verificado: Sí` en la descripción del evento**: la agregan
  `reservar.js`, `crear-turno.js` y `agregar-telefono.js` únicamente cuando el número
  vino del selector de país (nunca al adivinar). `extraerTelefonoVerificado()` la lee;
  su ausencia (todo lo cargado antes de este cambio) es la señal de "pendiente de
  revisión". Si se borra el teléfono desde "Editar tel.", también se saca esta marca.
- **Un teléfono guardado que no pasa la validación se trata como "sin teléfono"** en
  `/gestion`: no se muestra un botón de WhatsApp roto, se muestra "+ Agregar teléfono"
  para que se pueda corregir ahí mismo.
- **El botón de WhatsApp de cada fila usa el ícono real del logo** (SVG, mismo path que "Escribinos por WhatsApp" del resto del sitio) — nunca un emoji de burbuja de mensaje genérica.
- **Mensaje precargado del botón de WhatsApp (recordatorio, `/gestion`)**: cálido, con 🦷, y con la fecha/hora armada dinámicamente ("hoy" / "mañana" / "el X de mes") según el turno real. Explícitamente **sin** agregar "con el Dr. Franco Vinzón" ni "Te esperamos" — mantenerlo así salvo pedido en contra.
- **Botón de WhatsApp en TODAS las filas con teléfono válido**, no solo en las de "paciente nuevo". El badge dorado "Nuevo paciente" y el teléfono en tamaño grande siguen siendo exclusivos de `esNuevoPaciente: true`.

## Título y descripción de eventos

- **Título del evento: solo `"Nombre Apellido"`**, sin prefijo "Turnos" ni paréntesis (se limpiaron ~242 eventos viejos con formato `"Turnos (Nombre)"` en una migración de un solo uso).
- **Descripción con formato de líneas fijo**: `Teléfono: X` / `Motivo: X` / (en turnos de paciente) `Paciente nuevo: Sí|No`. El parseo (`extraerTelefono`, `extraerEsNuevoPaciente`) busca estas etiquetas en cualquier parte del texto, no en una posición fija, y tolera HTML viejo de Apps Script.
- **Eventos viejos sin estas líneas no rompen nada** — todo lo que las lee tiene un default seguro (`telefono: ''`, `esNuevoPaciente: false`).

## Sobreturnos

- **Los sobreturnos se cargan a propósito superpuestos** con turnos normales — es su función (meter un huequito extra en un horario ya ocupado). Por eso "Nuevo sobreturno" sigue con hora libre a mano (sin calendario de disponibilidad) y su chequeo de solapamiento es solo contra el calendario de sobreturnos, nunca contra el principal.
- **"Nuevo turno" (calendario principal) sí usa el mismo selector de calendario + horarios reales que ven los pacientes en `/turnos`** (reutiliza `/api/disponibilidad-mes` y `/api/horarios-dia`), para no calcular disponibilidad de dos formas distintas.

## Zona horaria

- **Nunca usar getters locales de `Date` para "hoy"/"ahora"** en código que corre en el navegador (afecta a cualquier visitante en otro huso horario). Siempre `Intl.DateTimeFormat` con `timeZone: 'America/Argentina/Buenos_Aires'` explícito. Ya hubo un bug real de esto, corregido — no reintroducirlo.

## Deploy / operación

- **No hacer polling en loop corto contra el dominio de producción** desde herramientas automatizadas — ya disparó el modo de protección anti-bot de Vercel una vez y bloqueó el sitio real. Espaciar los chequeos y, si hace falta confirmación rápida, pedirle al usuario que mire desde su propio navegador.
