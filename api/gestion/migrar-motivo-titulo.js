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

// La primera corrida (2026-08-06) migró 45 eventos, pero 3 de ellos tenían el
// patrón VIEJO "Turnos (Nombre)" de la limpieza de Apps Script (decisions.md —
// "Turnos" era un prefijo genérico, no un nombre) en vez de "Nombre (motivo)". El
// regex no distingue los dos casos, así que a esos 3 les invirtió título/motivo:
// quedó "Turnos" de título y el nombre real del paciente en Motivo. Se revierten acá
// puntualmente por eventId (no con el mismo regex, para no arriesgar falsos
// positivos nuevos) antes de borrar el script.
const EVENTOS_A_REVERTIR = [
  { calendarId: 'odontologofrancovinzon@gmail.com', eventId: 'dfun8nppp09totrap7164u214s' }, // "Turnos Odontólogo Franco Vinzón" -> "Nicolas Gomez"
  { calendarId: 'odontologofrancovinzon@gmail.com', eventId: '8hlfijoth12d9d7fcvshookj7k' }, // "Turnos" -> "Cecilia  Romani"
  { calendarId: 'odontologofrancovinzon@gmail.com', eventId: 'dd379uusolab8a343pc5e3udec' }, // "Turnos" -> "Camila Daniela Rodriguez"
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }
  if (!isValidGestionKey(req.body.key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  if (req.body.accion === 'revertir-turnos-genericos') {
    try {
      const calendar = getCalendarClient();
      const resultados = [];
      for (const { calendarId, eventId } of EVENTOS_A_REVERTIR) {
        const { data: ev } = await calendar.events.get({ calendarId, eventId });
        const desc = ev.description || '';
        const motivoActual = (desc.match(/Motivo:\s*([^\n]*)/i) || [])[1];
        const nombreReal = motivoActual ? motivoActual.trim() : null;
        if (!nombreReal) {
          resultados.push({ calendarId, eventId, saltado: true, razon: 'sin línea Motivo: para recuperar el nombre' });
          continue;
        }
        const descripcionRevertida = desc.replace(/\n?Motivo:\s*[^\n]*/i, '').replace(/\s+$/, '');
        await calendar.events.patch({
          calendarId,
          eventId,
          requestBody: { summary: nombreReal, description: descripcionRevertida },
        });
        resultados.push({ calendarId, eventId, tituloRevertidoA: nombreReal });
      }
      return res.status(200).json({ success: true, revertidos: resultados.length, detalle: resultados });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: 'Error al revertir: ' + err.message });
    }
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
