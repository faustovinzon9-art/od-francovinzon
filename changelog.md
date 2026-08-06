# Changelog

Registro breve de cambios importantes. Agregar una línea (o pocas) después de cada cambio grande — no hace falta detallar cada commit, para eso está `git log`.

## 2026-08-06

- Botón "Mover": ícono cambiado a 🔄 (antes ✎, se confundía con "editar"), y ahora permite editar el motivo desde el mismo modal, tanto para turnos como sobreturnos.
- `normalizarTelefonoWhatsApp()` compartida: normaliza cualquier teléfono al formato que necesita `wa.me`, aplicada en `reservar.js`, `crear-turno.js` y `agregar-telefono.js`. Corregido en la misma vuelta un bug de colisión (números locales que arrancan con "34" se confundían con el código de país de España).
- Teléfono inválido en `/gestion` se trata como "sin teléfono" (no muestra un botón de WhatsApp roto).
- "Editar tel." permite guardar vacío para borrar un número mal cargado; el teléfono sigue siendo obligatorio solo al crear un turno/sobreturno nuevo.
- Botón de WhatsApp por fila: ícono real (SVG) en vez de emoji, mensaje precargado dinámico según hoy/mañana/fecha del turno.

## 2026-08-05 (día grande — varias vueltas)

- **Migración completa de `/turnos` a Google Calendar API propia**, sacando la dependencia de Google Apps Script y del iframe que rompía en Safari/iOS y navegadores embebidos (Instagram/Facebook/TikTok). `/turnos` pasó de iframe → redirect → página propia con calendario y horarios reales.
- Se sacó `attendees`/`sendUpdates` de la creación de eventos (cuenta de servicio sin domain-wide delegation no puede invitar asistentes). Títulos de evento pasaron a ser solo `"Nombre Apellido"`.
- **Se armó `/gestion` desde cero**: panel para la secretaria con login por `GESTION_KEY`, agenda del día (fusiona ambos calendarios), Nuevo turno/sobreturno, bloquear día completo / bloquear horario, mover, cancelar, vista semanal, buscador de pacientes, sidebar con resumen del día, autocompletado de teléfono al escribir el nombre, botón "+ Agregar teléfono" / "Editar tel." inline.
- Auditoría y corrección de zona horaria en el cliente: "hoy"/"ahora" se calculaban con getters locales de `Date`, rotos para visitantes en otro huso horario — corregido a `Intl.DateTimeFormat` con `timeZone` explícito en `/turnos` y `/gestion`.
- Migración de datos de un solo uso, corridas y confirmadas: limpieza de ~242 títulos viejos con formato `"Turnos (Nombre)"`, y rescate de ~242 teléfonos que estaban escritos sueltos en la descripción (sin la etiqueta `Teléfono:`) de 548 eventos revisados.
- **Incidente de infraestructura resuelto**: el plan Hobby de Vercel permite máximo 12 Serverless Functions por deployment; se llegó a 15 y el build empezó a fallar completo (sin aviso claro más que el dashboard). Se resolvió fusionando rutas relacionadas en archivos únicos con un campo `accion`/`modo` (`bloqueo-dia.js`, `evento.js`, `buscar.js` con sus modos). Quedó como regla permanente — ver `CLAUDE.md`.
- Teléfono pasó a ser obligatorio para todos los pacientes (antes era condicional a "paciente nuevo"). Se sacó el campo email del formulario de `/turnos` (no se usa para nada desde que no hay `attendees`).
- Pantalla de bienvenida especial para "paciente nuevo" en `/turnos` (logo, saludo cálido, botón de WhatsApp con mensaje precargado).
- Varios ajustes de diseño/UX en `/gestion`: sidebar en desktop con logo, saludo, resumen y buscador; buscador visible también en mobile; logo con proporción corregida; botón "Bloquear un día completo" ya no requiere estar parado en ese día.

## 2026-08-04

- Sitio inicial: home pública del consultorio, sección "Tratamientos" (antes "Servicios"), ajustes mobile.
