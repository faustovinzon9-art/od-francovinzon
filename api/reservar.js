import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, SLOT_MINUTES, TIME_ZONE,
  toArgDate, eventBounds, crearTurno, formatArgDay, formatArgTime,
  extraerTelefono, extraerMotivo, extraerEsNuevoPaciente,
} from '../lib/googleCalendar.js';

// El ticket térmico imprime un QR también para sobreturnos (ver gestion/index.html),
// así que "obtener"/"cancelar" tienen que poder apuntar a SOBRETURNOS_CALENDAR_ID —
// nunca a un calendario arbitrario que mande el cliente: whitelist de los dos ids
// válidos, cualquier otra cosa cae al default de siempre (CALENDAR_ID).
function resolverCalendarId(calendarId) {
  return calendarId === SOBRETURNOS_CALENDAR_ID ? SOBRETURNOS_CALENDAR_ID : CALENDAR_ID;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { accion } = req.body;
  // Mover/cancelar/consultar el turno, sin key: solo alcanza con el eventId — mismo
  // modelo de seguridad para las tres (ver decisions.md, "Modificar turno desde la
  // confirmación"). El nuevo horario de "mover" siempre sale del calendario/duración
  // normal (CALENDAR_ID, 30 min) — si el eventId que se mueve es un sobreturno
  // (calendarId = SOBRETURNOS_CALENDAR_ID), esto convierte el sobreturno en turno
  // común en vez de solo reprogramarlo (ver moverPropio). "obtener"/"cancelar" ya
  // aceptaban un calendarId whitelisteado para poder mostrar/cancelar sobreturnos.
  if (accion === 'cancelar') return cancelarPropio(req, res);
  if (accion === 'mover') return moverPropio(req, res);
  if (accion === 'obtener') return obtenerPropio(req, res);

  try {
    const { date, time, nombre, apellido, telefono, motivo, esNuevo } = req.body;
    const calendar = getCalendarClient();
    // Misma lógica que usa el chatbot para la reserva conversacional — ver lib/googleCalendar.js.
    const resultado = await crearTurno(calendar, { date, time, nombre, apellido, telefono, motivo, esNuevo });
    res.status(200).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Hubo un error al confirmar el turno. Probá de nuevo.' });
  }
}

// Punto de entrada del QR del ticket térmico (ver gestion/index.html): dado un
// eventId, devuelve nombre/fecha/hora para que /turnos pueda mostrar "Tu turno" y
// habilitar Cambiar día y horario / Cancelar sin haber pasado por la reserva en esa
// misma carga de página. Mismo modelo de seguridad que mover/cancelar (conocer el
// id alcanza) — no expone teléfono ni nada más de la description.
async function obtenerPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a consultar.' });
    }
    const calendar = getCalendarClient();
    const { data: ev } = await calendar.events.get({ calendarId: resolverCalendarId(calendarId), eventId });
    // Un turno recién cancelado no siempre tira error en events.get de entrada —
    // Google Calendar puede devolver el recurso igual con status: 'cancelled'
    // (tombstone) en vez de un 404 inmediato. Bug real encontrado probando el QR
    // de punta a punta: sin este chequeo, un turno ya cancelado seguía
    // mostrándose como válido (con botones de Cambiar/Cancelar de nuevo).
    if (ev.status === 'cancelled') {
      return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
    }
    const { start } = eventBounds(ev);
    res.status(200).json({
      success: true,
      nombre: ev.summary || '',
      date: formatArgDay(start),
      time: formatArgTime(start),
    });
  } catch (err) {
    // events.get tira si el turno ya no existe (cancelado, o id inválido/de otro
    // calendario) — se trata como "no encontrado" sin filtrar el motivo exacto.
    console.error(err);
    res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
  }
}

async function cancelarPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a cancelar.' });
    }
    const calendar = getCalendarClient();
    await calendar.events.delete({ calendarId: resolverCalendarId(calendarId), eventId });
    res.status(200).json({ success: true, message: 'Turno cancelado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo cancelar el turno. Probá de nuevo.' });
  }
}

async function moverPropio(req, res) {
  try {
    const { eventId, date, time, calendarId } = req.body;
    if (!eventId || !date || !time) {
      return res.status(200).json({ success: false, message: 'Faltan datos para reprogramar.' });
    }

    const calendar = getCalendarClient();
    const origenSobreturno = calendarId === SOBRETURNOS_CALENDAR_ID;
    const newStart = toArgDate(date, time);
    const newEnd = new Date(newStart.getTime() + SLOT_MINUTES * 60000);

    // El horario elegido siempre es del calendario principal (30 min) — tanto para
    // reprogramar un turno común como para convertir un sobreturno en uno — así que
    // el chequeo de solapamiento es siempre contra CALENDAR_ID.
    const { data: existing } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: newStart.toISOString(),
      timeMax: newEnd.toISOString(),
      singleEvents: true,
    });

    const overlapping = (existing.items || []).some((ev) => {
      if (ev.id === eventId) return false;
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return newStart < evEnd && newEnd > evStart;
    });

    if (overlapping) {
      return res.status(200).json({ success: false, message: 'Justo se ocupó ese horario. Elegí otro disponible.' });
    }

    if (origenSobreturno) {
      // Convertir sobreturno -> turno común: el paciente eligió un horario del
      // calendario normal (30 min) desde /turno, que no tiene selector de horarios
      // de sobreturno (15 min) — no alcanza con mover fecha/hora, hay que recrear
      // el evento en el otro calendario con la duración correcta. Se crea primero
      // el turno nuevo y recién si sale bien se borra el sobreturno viejo, para no
      // perder el turno si algo falla en el medio (ver decisions.md).
      const { data: original } = await calendar.events.get({ calendarId: SOBRETURNOS_CALENDAR_ID, eventId });
      if (original.status === 'cancelled') {
        return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
      }

      const partes = (original.summary || '').trim().split(/\s+/);
      const nombre = partes.shift() || '';
      const apellido = partes.join(' ');

      const resultado = await crearTurno(calendar, {
        date,
        time,
        nombre,
        apellido,
        telefono: extraerTelefono(original.description || ''),
        motivo: extraerMotivo(original.description || ''),
        esNuevo: extraerEsNuevoPaciente(original.description || ''),
        origen: 'conversion-sobreturno',
      });
      if (!resultado.success) return res.status(200).json(resultado);

      await calendar.events.delete({ calendarId: SOBRETURNOS_CALENDAR_ID, eventId });

      return res.status(200).json({
        success: true,
        message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`,
        eventId: resultado.eventId,
        calendarId: CALENDAR_ID,
      });
    }

    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        start: { dateTime: newStart.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: newEnd.toISOString(), timeZone: TIME_ZONE },
      },
    });

    res.status(200).json({
      success: true,
      message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`,
      eventId,
      calendarId: CALENDAR_ID,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo reprogramar el turno. Probá de nuevo.' });
  }
}
