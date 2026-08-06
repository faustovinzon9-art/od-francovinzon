# Pendientes activos

Último pedido grande (2026-08-06) traía 8 puntos. Se implementaron el 1 y el 2 completos; el resto se dejó explícitamente sin tocar por tamaño/complejidad, a la espera de que el usuario priorice. Están acá en el mismo orden en que se pidieron.

## Hecho y desplegado (no son pendientes, solo referencia)

- ✅ Ítem 1 — Botón "Mover": ícono cambiado a 🔄, permite editar motivo desde el mismo modal (turno y sobreturno). Desplegado y funcionando.
- ✅ Ítem 2 — Teléfonos: normalización compartida, WhatsApp con ícono real y mensaje dinámico, teléfono inválido = "sin teléfono", "Editar tel." permite vacío. Desplegado, probado en vivo con 5 formatos distintos (con 15, con 0, con espacios, con guiones, con +54) — los cinco normalizan igual. Bug de colisión con código de país de España (34) encontrado y corregido en la misma vuelta.

## Pendiente: verificación floja (no bloqueante, pero sin confirmar)

- El flujo de "Editar tel." guardando **vacío** (para borrar un número) se implementó y se revisó el código, pero no se probó en vivo end-to-end (sí se probó extensamente el camino de guardar un número válido). Antes de confiar en que funciona 100%, probarlo una vez desde la interfaz.

## Pendiente: ítems 3 a 8 del pedido del 2026-08-06 (sin empezar)

En orden de pedido, no de prioridad — falta que el usuario diga cuáles quiere primero.

### 3. Lista de tareas inteligente en el sidebar
Debajo del resumen (turnos hoy / huecos libres), lista de tareas tipo "Agregar teléfono a pacientes sin número", "Corregir teléfonos inválidos", con acción directa (editar teléfono sin tener que buscar al paciente a mano). Necesita: una ruta que calcule "pacientes sin teléfono / con teléfono inválido" del día o de un rango, y UI nueva en el sidebar. Ver el límite de funciones antes de sumar una ruta — candidato a fusionar en `buscar.js` con un modo nuevo, o resolver 100% con datos que ya trae `turnos-dia.js`.

### 4. Feriados argentinos + tarea "¿Se atiende este día?"
Detección automática de feriados (necesita una fuente de feriados — no hay ninguna cargada todavía, evaluar una API pública gratuita o una lista fija actualizada a mano por año) + una tarea con ciclo de vida con estado (Sí → se borra; No → ofrece bloquear el día, y si bloquea crea OTRA tarea "Mover pacientes del día bloqueado" que solo desaparece cuando no queda nadie asignado ese día). Es la pieza más compleja de las 6 pendientes — necesita persistencia de estado de tareas en algún lado (hoy no hay ninguna base de datos ni storage propio, todo vive en eventos de Calendar; probablemente haya que "codificar" el estado de la tarea como un evento marcador en el calendario, similar a como se marcan los bloqueos con `BLOCK_MARKER`).

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
