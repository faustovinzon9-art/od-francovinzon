// Endpoint propio (no fusionado en agregar-telefono.js) para no arriesgar la lógica ya
// delicada de esa regex (línea "Teléfono verificado" acoplada) al retocarla bajo apuro —
// hay margen de sobra en el límite de 12 funciones (ver CLAUDE.md), así que un archivo
// nuevo y chico es más seguro acá que un retrofit del otro. Mismo patrón general:
// lee la description del evento, parchea (o agrega) la línea "DNI: ...", guarda.
import { getCalendarClient, isValidGestionKey } from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, dni } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  // Vacío = borrar el DNI (mismo criterio que agregar-telefono.js) — no es obligatorio,
  // así que se permite dejarlo en blanco de nuevo si se cargó por error.
  const crudo = (dni || '').trim().replace(/[.\s]/g, '');
  const valorGuardar = crudo || '-';

  try {
    const calendar = getCalendarClient();
    const { data: ev } = await calendar.events.get({ calendarId, eventId });

    const descActual = ev.description || '';
    const yaTieneLinea = /DNI:\s*[^\n]*/i.test(descActual);

    let nuevaDescripcion;
    if (yaTieneLinea) {
      nuevaDescripcion = descActual.replace(/DNI:\s*[^\n]*/i, `DNI: ${valorGuardar}`);
    } else if (valorGuardar !== '-') {
      const limpia = descActual.replace(/\s+$/, '');
      nuevaDescripcion = limpia ? `${limpia}\nDNI: ${valorGuardar}` : `DNI: ${valorGuardar}`;
    } else {
      return res.status(200).json({ success: true, message: 'Sin cambios.', dni: '' });
    }

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    });

    res.status(200).json({
      success: true,
      message: crudo ? 'DNI actualizado.' : 'DNI borrado.',
      dni: valorGuardar === '-' ? '' : valorGuardar,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/agregar-dni.js', error: err });
    res.status(500).json({ success: false, message: 'No se pudo guardar el DNI.' });
  }
}
