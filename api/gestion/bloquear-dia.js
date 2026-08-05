import { getCalendarClient, CALENDAR_ID, BLOCK_MARKER, pad2, isValidGestionKey } from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date, motivo } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
        description: BLOCK_MARKER,
        start: { date },
        end: { date: nextDayStr(date) },
      },
    });

    res.status(200).json({ success: true, message: `Día ${date} bloqueado.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error al bloquear el día.' });
  }
}

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
