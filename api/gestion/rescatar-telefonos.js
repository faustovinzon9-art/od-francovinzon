import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, extraerTelefono, isValidGestionKey,
} from '../../lib/googleCalendar.js';

// Utilidad de un solo uso: busca números de teléfono escritos a mano en formatos
// sueltos ("Tel: ...", "Cel ...", o el número suelto en el texto) en eventos que
// todavía no tienen la línea "Teléfono: X" bien formada, y se la agrega sin tocar
// el resto de la descripción. Procesa en lotes para no pisar la cuota de Google
// Calendar API ni el límite de tiempo de la función — es seguro llamarla varias
// veces seguidas hasta que "restantesPorActualizar" da 0.
export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH_LIMIT = 40;

function buscarTelefonoSuelto(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');

  // Etiquetas alternativas ya usadas a mano ("Tel:", "Cel:", "Whatsapp:", etc.)
  const etiquetado = sinTags.match(/(?:Tel[eé]fono|Tel|Cel(?:ular)?|Whats\s?app|Wpp)\s*:?\s*([^\n<]{6,25})/i);
  if (etiquetado) {
    const digitos = etiquetado[1].replace(/\D/g, '');
    if (digitos.length >= 9 && digitos.length <= 13) return etiquetado[1].trim();
  }

  // Fallback: cualquier secuencia de dígitos "con forma" de teléfono en el texto
  const candidatos = sinTags.match(/\+?\d[\d\s.\-()]{6,17}\d/g) || [];
  for (const c of candidatos) {
    const digitos = c.replace(/\D/g, '');
    if (digitos.length >= 9 && digitos.length <= 13) return c.trim();
  }

  return null;
}

async function listarTodos(calendar, calendarId) {
  let pageToken;
  const items = [];
  do {
    const { data } = await calendar.events.list({
      calendarId,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    (data.items || []).forEach((ev) => items.push({ ...ev, calendarId }));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      listarTodos(calendar, CALENDAR_ID),
      listarTodos(calendar, SOBRETURNOS_CALENDAR_ID),
    ]);
    const todos = [...principal, ...sobreturnos];
    const revisados = todos.length;

    const pendientes = todos.filter((ev) => !extraerTelefono(ev.description));

    const rescatables = [];
    let sinNumeroReconocible = 0;

    pendientes.forEach((ev) => {
      const telefono = buscarTelefonoSuelto(ev.description);
      if (telefono) {
        rescatables.push({ id: ev.id, calendarId: ev.calendarId, telefono, descActual: ev.description || '' });
      } else {
        sinNumeroReconocible++;
      }
    });

    const lote = rescatables.slice(0, BATCH_LIMIT);

    for (const r of lote) {
      const limpia = r.descActual.replace(/\s+$/, '');
      const nuevaDescripcion = limpia ? `${limpia}\nTeléfono: ${r.telefono}` : `Teléfono: ${r.telefono}`;
      await calendar.events.patch({
        calendarId: r.calendarId,
        eventId: r.id,
        requestBody: { description: nuevaDescripcion },
      });
      await sleep(150);
    }

    const restantesPorActualizar = rescatables.length - lote.length;

    res.status(200).json({
      success: true,
      revisados,
      actualizadosEsteLote: lote.length,
      restantesPorActualizar,
      sinNumeroReconocible,
      message: restantesPorActualizar > 0
        ? `Revisé ${revisados} eventos. Actualicé ${lote.length} en este lote, quedan ${restantesPorActualizar} más para rescatar (volvé a llamar esta misma ruta para seguir). ${sinNumeroReconocible} no tenían ningún número reconocible.`
        : `Revisé ${revisados} eventos. Actualicé ${lote.length}. ${sinNumeroReconocible} no tenían ningún número reconocible.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error al rescatar teléfonos.', debug: err && err.message ? err.message : String(err) });
  }
}
