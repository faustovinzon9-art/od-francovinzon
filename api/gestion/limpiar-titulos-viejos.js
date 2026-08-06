import { getCalendarClient, CALENDAR_ID, isValidGestionKey } from '../../lib/googleCalendar.js';

// Utilidad de un solo uso: renombra eventos viejos con título "Turnos (Nombre)"
// dejando solo "Nombre". Si no encuentra ninguno, no hace nada (idempotente).
export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH_LIMIT = 40; // por invocación, para no pisar la cuota ni el límite de tiempo

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
    const patron = /^Turnos \((.+)\)$/;

    let pageToken;
    const aRenombrar = [];

    do {
      const { data } = await calendar.events.list({
        calendarId: CALENDAR_ID,
        singleEvents: true,
        maxResults: 2500,
        pageToken,
      });

      (data.items || []).forEach((ev) => {
        const match = (ev.summary || '').match(patron);
        if (match) aRenombrar.push({ id: ev.id, nuevoTitulo: match[1].trim() });
      });

      pageToken = data.nextPageToken;
    } while (pageToken);

    const totalEncontrados = aRenombrar.length;

    if (totalEncontrados === 0) {
      return res.status(200).json({ success: true, renombrados: 0, restantes: 0, message: 'No quedaban títulos viejos para limpiar.' });
    }

    // Procesa como máximo BATCH_LIMIT por invocación (secuencial, con pausa entre
    // llamadas) para no pisar la cuota de Google ni el límite de tiempo de la función.
    // Es seguro llamar esta ruta varias veces seguidas: cada vez toma los que todavía
    // no se renombraron, hasta que "restantes" da 0.
    const lote = aRenombrar.slice(0, BATCH_LIMIT);

    for (const p of lote) {
      await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: p.id, requestBody: { summary: p.nuevoTitulo } });
      await sleep(150);
    }

    const restantes = totalEncontrados - lote.length;

    res.status(200).json({
      success: true,
      renombrados: lote.length,
      restantes,
      message: restantes > 0
        ? `${lote.length} evento(s) renombrado(s) en este lote. Quedan ${restantes}: volvé a llamar la misma ruta para seguir.`
        : `${lote.length} evento(s) renombrado(s). Listo, no queda ninguno más.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: 'Error al limpiar títulos.',
      debug: err && err.message ? err.message : String(err),
      debugData: err && err.response && err.response.data ? err.response.data : null,
    });
  }
}
