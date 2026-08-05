import { getCalendarClient, CALENDAR_ID, BLOCK_MARKER, toArgDate, isValidGestionKey } from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();
    const dayStart = toArgDate(date, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
    });

    const bloqueos = (data.items || []).filter(
      (ev) => !ev.start.dateTime && (ev.description || '').includes(BLOCK_MARKER)
    );

    if (bloqueos.length === 0) {
      return res.status(200).json({ success: false, message: 'Ese día no está bloqueado.' });
    }

    await Promise.all(
      bloqueos.map((ev) => calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id }))
    );

    res.status(200).json({ success: true, message: `Día ${date} desbloqueado.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error al desbloquear el día.' });
  }
}
