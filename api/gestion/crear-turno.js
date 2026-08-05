import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, CLINIC_ADDRESS, TIME_ZONE,
  SLOT_MINUTES, SOBRETURNO_MINUTES, toArgDate, eventBounds, isValidGestionKey,
} from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date, time, nombre, apellido, telefono, motivo, sobreturno } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendarId = sobreturno ? SOBRETURNOS_CALENDAR_ID : CALENDAR_ID;
    const duration = sobreturno ? SOBRETURNO_MINUTES : SLOT_MINUTES;

    const start = toArgDate(date, time);
    const end = new Date(start.getTime() + duration * 60000);

    const calendar = getCalendarClient();

    const { data: existing } = await calendar.events.list({
      calendarId,
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
        message: 'Ese horario ya está ocupado en ese calendario.',
      });
    }

    const title = `${nombre} ${apellido || ''}`.trim();
    const description =
      `Teléfono: ${telefono || '-'}\n` +
      `Motivo: ${motivo}\n` +
      'Cargado manualmente desde el panel de gestión.';

    await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: title,
        location: CLINIC_ADDRESS,
        description,
        start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      },
    });

    res.status(200).json({
      success: true,
      message: `${sobreturno ? 'Sobreturno' : 'Turno'} cargado para el ${date} a las ${time} hs.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error al cargar el turno.' });
  }
}
