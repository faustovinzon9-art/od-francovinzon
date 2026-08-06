import { getCalendarClient, isValidGestionKey, normalizarTelefonoWhatsApp } from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, telefono } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  // Vacío = borrar el número (permitido solo acá, no al crear un turno nuevo).
  const crudo = (telefono || '').trim();
  let valorGuardar = '-';
  if (crudo) {
    const normalizado = normalizarTelefonoWhatsApp(crudo);
    if (!normalizado) {
      return res.status(200).json({ success: false, message: 'Ese número no parece válido. Revisalo e intentá de nuevo.' });
    }
    valorGuardar = normalizado;
  }

  try {
    const calendar = getCalendarClient();
    const { data: ev } = await calendar.events.get({ calendarId, eventId });

    const descActual = ev.description || '';
    const yaTieneLinea = /Tel[eé]fono:\s*[^\n]*/i.test(descActual);

    let nuevaDescripcion;
    if (yaTieneLinea) {
      nuevaDescripcion = descActual.replace(/Tel[eé]fono:\s*[^\n]*/i, `Teléfono: ${valorGuardar}`);
    } else if (valorGuardar !== '-') {
      const limpia = descActual.replace(/\s+$/, '');
      nuevaDescripcion = limpia ? `${limpia}\nTeléfono: ${valorGuardar}` : `Teléfono: ${valorGuardar}`;
    } else {
      return res.status(200).json({ success: true, message: 'Sin cambios.' });
    }

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    });

    res.status(200).json({ success: true, message: crudo ? 'Teléfono actualizado.' : 'Teléfono borrado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'No se pudo guardar el teléfono.' });
  }
}
