import { getCalendarClient, isValidGestionKey } from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({ calendarId, eventId });
    res.status(200).json({ success: true, message: 'Turno cancelado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error al cancelar el turno.' });
  }
}
