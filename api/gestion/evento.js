import { getCalendarClient, TIME_ZONE, toArgDate, eventBounds, isValidGestionKey } from '../../lib/googleCalendar.js';

// Mover y cancelar un turno/sobreturno comparten ruta (distinguidos por "accion")
// para no pasarnos del límite de funciones serverless del plan gratuito de Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, accion } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();

    if (accion === 'cancelar') {
      await calendar.events.delete({ calendarId, eventId });
      return res.status(200).json({ success: true, message: 'Turno cancelado.' });
    }

    const { nuevaFecha, nuevaHora } = req.body;

    const { data: original } = await calendar.events.get({ calendarId, eventId });
    const { start: origStart, end: origEnd } = eventBounds(original);
    const durationMs = origEnd.getTime() - origStart.getTime();

    const newStart = toArgDate(nuevaFecha, nuevaHora);
    const newEnd = new Date(newStart.getTime() + durationMs);

    const { data: existing } = await calendar.events.list({
      calendarId,
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
      return res.status(200).json({ success: false, message: 'Ese horario ya está ocupado.' });
    }

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        start: { dateTime: newStart.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: newEnd.toISOString(), timeZone: TIME_ZONE },
      },
    });

    res.status(200).json({ success: true, message: `Movido al ${nuevaFecha} a las ${nuevaHora} hs.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error al procesar el turno.' });
  }
}

