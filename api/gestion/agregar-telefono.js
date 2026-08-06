import { getCalendarClient, isValidGestionKey, telefonoParaWhatsApp } from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, telefono } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  // Vacío = borrar el número (permitido solo acá, no al crear un turno nuevo).
  // "telefono" llega ya en formato E.164 del selector de país (intl-tel-input) del cliente.
  const crudo = (telefono || '').trim();
  let valorGuardar = '-';
  if (crudo) {
    const normalizado = telefonoParaWhatsApp(crudo);
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

    // "Teléfono verificado: Sí" marca que el número pasó por el selector de país recién
    // (ver decisions.md). Si se borra el teléfono, se saca la marca; si se carga uno
    // nuevo, se agrega o reemplaza.
    const yaTieneVerificado = /Tel[eé]fono verificado:\s*[^\n]*/i.test(nuevaDescripcion);
    if (valorGuardar === '-') {
      if (yaTieneVerificado) {
        nuevaDescripcion = nuevaDescripcion.replace(/\n?Tel[eé]fono verificado:\s*[^\n]*/i, '');
      }
    } else if (yaTieneVerificado) {
      nuevaDescripcion = nuevaDescripcion.replace(/Tel[eé]fono verificado:\s*[^\n]*/i, 'Teléfono verificado: Sí');
    } else {
      nuevaDescripcion = nuevaDescripcion.replace(
        /(Tel[eé]fono:\s*[^\n]*)/i,
        '$1\nTeléfono verificado: Sí'
      );
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
