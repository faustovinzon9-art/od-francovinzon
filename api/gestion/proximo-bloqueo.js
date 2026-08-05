import { getCalendarClient, CALENDAR_ID, BLOCK_MARKER, isValidGestionKey } from '../../lib/googleCalendar.js';

const DIAS_ADELANTE = 120;

export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const timeMax = new Date(now.getTime() + DIAS_ADELANTE * 24 * 60 * 60000);

    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      q: BLOCK_MARKER,
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const bloqueoDia = (data.items || []).find(
      (ev) => !ev.start.dateTime && (ev.description || '').includes(BLOCK_MARKER)
    );

    res.status(200).json({ date: bloqueoDia ? bloqueoDia.start.date : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo consultar.' });
  }
}
