import {
  getCalendarClient, CALENDAR_ID, SLOT_MINUTES, CLINIC_ADDRESS, TIME_ZONE,
  toArgDate, eventBounds, telefonoParaWhatsApp,
} from '../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { accion } = req.body;
  // Mover/cancelar el turno recién confirmado, sin key: solo alcanza con el eventId
  // que devolvimos al crearlo (no persiste en URL ni localStorage, vive en memoria del
  // cliente durante esa sesión — ver decisions.md, "Modificar turno desde la
  // confirmación"). Scope fijo a CALENDAR_ID: los pacientes nunca tocan sobreturnos.
  if (accion === 'cancelar') return cancelarPropio(req, res);
  if (accion === 'mover') return moverPropio(req, res);

  try {
    const { date, time, nombre, apellido, telefono, motivo, esNuevo } = req.body;

    if (!telefono || !telefono.trim()) {
      return res.status(200).json({ success: false, message: 'El teléfono es obligatorio.' });
    }
    const telNormalizado = telefonoParaWhatsApp(telefono);
    if (!telNormalizado) {
      return res.status(200).json({ success: false, message: 'Ese teléfono no parece válido. Revisalo e intentá de nuevo.' });
    }

    const start = toArgDate(date, time);
    const end = new Date(start.getTime() + SLOT_MINUTES * 60000);

    const calendar = getCalendarClient();

    const { data: existing } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
    });

    const stillFree = !(existing.items || []).some((ev) => {
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return start < evEnd && end > evStart;
    });

    if (!stillFree) {
      return res.status(200).json({
        success: false,
        message: 'Justo se ocupó ese horario. Por favor elegí otro disponible.',
      });
    }

    const title = `${nombre} ${apellido || ''}`.trim();
    const description =
      `Teléfono: ${telNormalizado}\n` +
      'Teléfono verificado: Sí\n' +
      `Motivo: ${motivo || '-'}\n` +
      `Paciente nuevo: ${esNuevo ? 'Sí' : 'No'}\n` +
      'Reservado desde el formulario propio (hora Argentina fija, sin depender del dispositivo del paciente).';

    const eventBody = {
      summary: title,
      location: CLINIC_ADDRESS,
      description,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    };

    const { data: created } = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: eventBody,
    });

    res.status(200).json({
      success: true,
      message: `Turno confirmado para el ${date} a las ${time} hs (hora Argentina).`,
      eventId: created.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Hubo un error al confirmar el turno. Probá de nuevo.' });
  }
}

async function cancelarPropio(req, res) {
  try {
    const { eventId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a cancelar.' });
    }
    const calendar = getCalendarClient();
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    res.status(200).json({ success: true, message: 'Turno cancelado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo cancelar el turno. Probá de nuevo.' });
  }
}

async function moverPropio(req, res) {
  try {
    const { eventId, date, time } = req.body;
    if (!eventId || !date || !time) {
      return res.status(200).json({ success: false, message: 'Faltan datos para reprogramar.' });
    }

    const calendar = getCalendarClient();
    const newStart = toArgDate(date, time);
    const newEnd = new Date(newStart.getTime() + SLOT_MINUTES * 60000);

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
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo reprogramar el turno. Probá de nuevo.' });
  }
}
