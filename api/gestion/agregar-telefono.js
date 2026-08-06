import { getCalendarClient, isValidGestionKey } from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, telefono } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }
  if (!telefono || !telefono.trim()) {
    return res.status(200).json({ success: false, message: 'Ingresá un teléfono.' });
  }

  try {
    const calendar = getCalendarClient();
    const { data: ev } = await calendar.events.get({ calendarId, eventId });

    const descActual = (ev.description || '').replace(/\s+$/, '');
    const nuevaDescripcion = descActual
      ? `${descActual}\nTeléfono: ${telefono.trim()}`
      : `Teléfono: ${telefono.trim()}`;

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    });

    res.status(200).json({ success: true, message: 'Teléfono agregado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo guardar el teléfono.' });
  }
}
