import {
  getCalendarClient, CALENDAR_ID, BLOCK_MARKER, pad2, toArgDate, isValidGestionKey,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// Bloquear y desbloquear un día completo comparten ruta (distinguidos por "accion")
// para no pasarnos del límite de funciones serverless del plan gratuito de Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date, motivo, accion } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();

    if (accion === 'desbloquear') {
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

      return res.status(200).json({ success: true, message: `Día ${date} desbloqueado.` });
    }

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
    await avisarFallo({ endpoint: 'api/gestion/bloqueo-dia.js', detalle: accion, error: err });
    res.status(500).json({ success: false, message: 'Error al procesar el bloqueo del día.' });
  }
}
