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
- **Formato guardado en la descripción: siempre normalizado**, vía `normalizarTelefonoWhatsApp()` — nunca el texto crudo que escribió la secretaria o el paciente. Ejemplo: `5493442403984`.
- **Reglas de normalización** (ver `lib/googleCalendar.js`): sacar todo lo que no sea dígito; si ya arranca con `54` (largo 12-13) o `598` (largo 11-12) dejarlo tal cual; si no, asumir Argentina — sacar el `0` inicial, sacar el `15` si aparece justo después del código de área, anteponer `549`. Si el resultado no tiene largo plausible (10-15 dígitos), se considera inválido (`null`).
- **Un teléfono guardado que no pasa la validación se trata como "sin teléfono"** en `/gestion`: no se muestra un botón de WhatsApp roto, se muestra "+ Agregar teléfono" para que se pueda corregir ahí mismo.
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
