# Pendientes activos

Último pedido grande (2026-08-06) traía 8 puntos. Se implementaron el 1, el 2 y el 3 completos; el resto se dejó explícitamente sin tocar por tamaño/complejidad, a la espera de que el usuario priorice. Están acá en el mismo orden en que se pidieron.

## Hecho y desplegado (no son pendientes, solo referencia)

- ✅ Ítem 1 — Botón "Mover": ícono cambiado a 🔄, permite editar motivo desde el mismo modal (turno y sobreturno). Desplegado y funcionando.
- ✅ Ítem 2 — Teléfonos: normalización compartida, WhatsApp con ícono real y mensaje dinámico, teléfono inválido = "sin teléfono", "Editar tel." permite vacío. Desplegado, probado en vivo con 5 formatos distintos (con 15, con 0, con espacios, con guiones, con +54) — los cinco normalizan igual. Bug de colisión con código de país de España (34) encontrado y corregido en la misma vuelta.
- ✅ **Selector de país en vez de adivinar el código de área** (2026-08-06): `intl-tel-input` en los 4 campos de teléfono nuevo, `telefonoParaWhatsApp()` a partir del E.164 real. Ver `decisions.md`.
- ✅ **Ítem 3 — Lista de tareas inteligente en el sidebar** (2026-08-06): implementada. Ver detalle abajo — ya no es un pendiente.
- ✅ **Tres correcciones sobre lo anterior** (2026-08-06, misma tarde): (1) el badge de la fila pasó de "cualquier teléfono sin `Teléfono verificado: Sí`" a "⚠ Tel. inválido" solo cuando el teléfono guardado no pasa la validación real de formato — un legado válido ya no se marca. (2) La lista de tareas del sidebar sacó la categoría "confirmar teléfono"; ahora son solo "Agregar teléfono" (sin ningún teléfono cargado) y "Mover N turnos" (día bloqueado por completo que todavía tiene turnos asignados, botón "Ir al día") — ver `buscar.js?modo=tareas`. (3) Se sacaron los emoji (😊🦷) del mensaje precargado de WhatsApp: comprobado que `wa.me`/`api.whatsapp.com` los corrompe (los reemplaza por "�" ya en el propio link hacia `web.whatsapp.com`, antes de llegar al chat) — no era un bug de nuestro `encodeURIComponent`. Las tres correcciones probadas en vivo con datos simulados. Ver `decisions.md`.

## Pendiente: verificación floja (no bloqueante, pero sin confirmar)

- El flujo de "Editar tel." guardando **vacío** (para borrar un número) se implementó y se revisó el código, pero no se probó en vivo end-to-end (sí se probó extensamente el camino de guardar un número válido). Antes de confiar en que funciona 100%, probarlo una vez desde la interfaz.
- **Selector de país (2026-08-06): probado a fondo del lado del cliente y con datos simulados** (servidor estático local, sin las credenciales de la cuenta de servicio de Google disponibles en esta máquina) — el selector, la búsqueda de país, el cálculo del E.164, el agregado del "9" para Argentina y el payload final que se manda a cada ruta se verificaron uno por uno. **No se probó todavía contra el Calendar real en producción** (crear un turno de punta a punta desde `/turnos` o `/gestion` desplegado, ver el evento real en el calendario, click real al WhatsApp resultante desde el teléfono). Conviene hacer una pasada así después de desplegar, antes de darlo por 100% confirmado en producción.
- **Lista de tareas del sidebar (2026-08-06, con las correcciones de la misma tarde): probada con datos simulados** (mismo motivo — sin credenciales de Google en esta máquina), incluyendo el estado vacío (sección oculta), la tarea "Agregar teléfono" navegando a otro día y abriendo el editor inline, y la tarea "Mover N turnos" de un día bloqueado navegando ahí (sin abrir ningún editor, solo navega). **No probada contra el Calendar real** ni con volumen real de turnos (para confirmar que el límite de 6 tareas visibles + "+N más" se ve bien con una agenda cargada de verdad).
- **Badge "⚠ Tel. inválido" (2026-08-06, corregido): probado con un teléfono legado válido (no se marca) y uno con formato inválido (sí se marca)** con datos simulados. No probado contra el Calendar real.

## Pendiente: ítems 4 a 8 del pedido del 2026-08-06 (sin empezar)

En orden de pedido, no de prioridad — falta que el usuario diga cuáles quiere primero. (El ítem 3 — lista de tareas inteligente — ya está hecho, ver arriba.)

### 4. Feriados argentinos + tarea "¿Se atiende este día?"
Detección automática de feriados (necesita una fuente de feriados — no hay ninguna cargada todavía, evaluar una API pública gratuita o una lista fija actualizada a mano por año) + una tarea con ciclo de vida con estado (Sí → se borra; No → ofrece bloquear el día). Es la pieza más compleja de las 5 pendientes — necesita persistencia de estado de tareas en algún lado (hoy no hay ninguna base de datos ni storage propio, todo vive en eventos de Calendar; probablemente haya que "codificar" el estado de la tarea como un evento marcador en el calendario, similar a como se marcan los bloqueos con `BLOCK_MARKER`).

**Nota (2026-08-06):** la tarea "Mover turnos de un día bloqueado" que este ítem iba a necesitar **ya está implementada** (independiente de la detección de feriados — se generaliza a cualquier día bloqueado a mano, no solo feriados). Lo que falta acá es específicamente la detección automática de feriados y la tarea "¿Se atiende este día?" con su ciclo de vida Sí/No.

### 5. "Agregar al calendario del dispositivo" después de confirmar un turno
En `/turnos`, después de la confirmación. El pedido explícito fue "solo si es simple, sin herramientas externas ni procesos largos" — la opción simple es generar un archivo `.ics` al vuelo (texto plano, sin librerías) y ofrecerlo para descargar/abrir. No necesita ruta de API nueva, se puede armar 100% en el cliente.

### 6. Modificar/cancelar turno desde la pantalla de confirmación (paciente)
Hoy el paciente no tiene forma de volver a su turno después de confirmarlo — no hay login ni identidad de paciente. Para hacer esto de forma segura hace falta algún esquema de link único por turno (ej. un token en la URL, guardado en la `description` del evento o derivado del `eventId`) para no permitir que cualquiera cancele el turno de cualquiera. Pensar el esquema de seguridad antes de implementar — es la decisión de diseño más delicada de todo lo pendiente.

### 7. Apple Liquid Glass (sutil) en las 3 páginas
Efecto visual tipo "Liquid Glass" de Apple, tinted según el color de cada botón, muy sutil, manteniendo la paleta actual (navy/dorado/crema). Afecta `index.html`, `turnos/index.html` y `gestion/index.html` — es un pase de CSS relativamente autocontenido, bajo riesgo de romper funcionalidad, pero hay que aplicarlo con cuidado para que "se note sutil" y no termine viéndose como un efecto exagerado.

### 8. Toasts + animaciones de feedback
Notificaciones tipo toast (arriba, autodesaparecen) para confirmaciones de acciones en `/turnos` y `/gestion` (turno confirmado, modificado, cancelado, teléfono actualizado, paciente movido, etc.) + micro-animaciones. Toca muchos puntos de la UI (cada `fetch(...).then(...)` que hoy solo actualiza un `<div class="msg">` inline) — conviene armar una función toast genérica una sola vez y después ir reemplazando los mensajes inline de a poco, no todos de golpe.

## Nota sobre alcance

Los ítems 4 y 6 en particular no son "una tarde de trabajo" — cada uno implica decisiones de producto y de diseño técnico que vale la pena confirmar con el usuario antes de programar (fuente de feriados, esquema de seguridad para autogestión del paciente). No asumir la implementación más simple sin preguntar si toca alguno de estos dos.
