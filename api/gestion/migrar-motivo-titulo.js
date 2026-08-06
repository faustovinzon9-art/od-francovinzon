import { getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, isValidGestionKey } from '../../lib/googleCalendar.js';

// Script de migración de UN SOLO USO — sacar del proyecto y commitear la baja apenas
// se confirma el resultado (límite de 12 funciones serverless del plan Hobby, ver
// CLAUDE.md).
//
// Turnos/sobreturnos viejos que tienen el motivo metido en el título entre paréntesis
// (ej. "Axel Martín (control)") en vez de en la línea "Motivo:" de la descripción —
// por eso el campo Motivo mostraba "sin motivo especificado" aunque el dato sí estaba
// cargado, solo que en el lugar equivocado. Recorre ambos calendarios, detecta el
// patrón "Nombre (texto)" en el título, mueve ese texto a "Motivo:" (sin pisar un
// motivo que ya esté bien cargado) y deja el título limpio como solo "Nombre".
const PATRON_TITULO = /^(.+?)\s*\(([^)]+)\)\s*$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }
  if (!isValidGestionKey(req.body.key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();
    const resultados = [];

    for (const calendarId of [CALENDAR_ID, SOBRETURNOS_CALENDAR_ID]) {
      let pageToken;
      const eventos = [];
      do {
        const { data } = await calendar.events.list({
          calendarId, singleEvents: true, maxResults: 2500, pageToken,
        });
        eventos.push(...(data.items || []));
        pageToken = data.nextPageToken;
      } while (pageToken);

      const candidatos = eventos
        .map((ev) => ({ ev, match: (ev.summary || '').match(PATRON_TITULO) }))
        .filter((x) => x.match && x.match[1].trim());

      for (let i = 0; i < candidatos.length; i++) {
        const { ev, match } = candidatos[i];
        const nombreLimpio = match[1].trim();
        const motivoRescatado = match[2].trim();
        const desc = ev.description || '';
        const motivoActual = (desc.match(/Motivo:\s*([^\n]*)/i) || [])[1];
        const yaTieneMotivo = !!(motivoActual && motivoActual.trim() && motivoActual.trim() !== '-');

        const nuevaDescripcion = yaTieneMotivo
          ? desc
          : (/Motivo:\s*[^\n]*/i.test(desc)
              ? desc.replace(/Motivo:\s*[^\n]*/i, `Motivo: ${motivoRescatado}`)
              : `${desc.replace(/\s+$/, '')}\nMotivo: ${motivoRescatado}`);

        await calendar.events.patch({
          calendarId,
          eventId: ev.id,
          requestBody: { summary: nombreLimpio, description: nuevaDescripcion },
        });

        resultados.push({
          calendarId, eventId: ev.id,
          tituloViejo: ev.summary, tituloNuevo: nombreLimpio,
          motivoRescatado, motivoYaEstaba: yaTieneMotivo,
        });

        // Cuota de Google ~600 req/min compartida con tráfico real del sitio —
        // pausa chica entre lotes, nunca Promise.all sobre muchos patch a la vez.
        if (i % 40 === 39) await new Promise((r) => setTimeout(r, 150));
      }
    }

    res.status(200).json({ success: true, migrados: resultados.length, detalle: resultados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error en la migración: ' + err.message });
  }
}
