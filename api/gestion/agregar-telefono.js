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

    const descActual = ev.description || '';
    const yaTieneLinea = /Tel[eé]fono:\s*[^\n]*/i.test(descActual);

    let nuevaDescripcion;
    if (yaTieneLinea) {
      // Editar: reemplaza la línea existente en el lugar, sin duplicarla.
      nuevaDescripcion = descActual.replace(/Tel[eé]fono:\s*[^\n]*/i, `Teléfono: ${telefono.trim()}`);
    } else {
      const limpia = descActual.replace(/\s+$/, '');
      nuevaDescripcion = limpia ? `${limpia}\nTeléfono: ${telefono.trim()}` : `Teléfono: ${telefono.trim()}`;
    }

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    });

    res.status(200).json({ success: true, message: yaTieneLinea ? 'Teléfono actualizado.' : 'Teléfono agregado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo guardar el teléfono.' });
  }
}
