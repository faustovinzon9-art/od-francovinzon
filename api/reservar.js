import {
  getCalendarClient, CALENDAR_ID, SLOT_MINUTES, CLINIC_ADDRESS, TIME_ZONE,
  toArgDate, eventBounds,
} from '../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  try {
    const { date, time, nombre, apellido, email, telefono, motivo } = req.body;

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

    const title = `Turnos (${nombre} ${apellido || ''})`.trim();
    const description =
      `Email: ${email || '-'}\n` +
      `Teléfono: ${telefono}\n` +
      `Motivo: ${motivo || '-'}\n` +
      'Reservado desde el formulario propio (hora Argentina fija, sin depender del dispositivo del paciente).';

    const eventBody = {
      summary: title,
      location: CLINIC_ADDRESS,
      description,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    };

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: eventBody,
    });

    res.status(200).json({
      success: true,
      message: `Turno confirmado para el ${date} a las ${time} hs (hora Argentina).`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Hubo un error al confirmar el turno. Probá de nuevo.' });
  }
}
