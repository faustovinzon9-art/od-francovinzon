import { getCalendarClient, CALENDAR_ID, isValidGestionKey } from '../../lib/googleCalendar.js';

// Utilidad de un solo uso: renombra eventos viejos con título "Turnos (Nombre)"
// dejando solo "Nombre". Si no encuentra ninguno, no hace nada (idempotente).
export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    if (aRenombrar.length === 0) {
      return res.status(200).json({ success: true, renombrados: 0, message: 'No quedaban títulos viejos para limpiar.' });
    }

    // Secuencial y con una pequeña pausa entre llamadas para no pisar la cuota
    // de Google Calendar API (compartida con el resto de las rutas en uso).
    for (const p of aRenombrar) {
      await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: p.id, requestBody: { summary: p.nuevoTitulo } });
      await sleep(120);
    }

    res.status(200).json({
      success: true,
      renombrados: aRenombrar.length,
      message: `${aRenombrar.length} evento(s) renombrado(s).`,
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
