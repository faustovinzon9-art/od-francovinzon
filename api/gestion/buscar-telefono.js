import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID,
  eventBounds, extraerTelefono, normalizarTexto, isValidGestionKey,
} from '../../lib/googleCalendar.js';

export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ telefono: null });
  }

  try {
    const nombre = (req.query.nombre || '').trim();
    if (nombre.length < 2) return res.status(200).json({ telefono: null });

    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setFullYear(timeMin.getFullYear() - 1);
    const timeMax = new Date(now);
    timeMax.setMonth(timeMax.getMonth() + 3);

    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      }),
      calendar.events.list({
        calendarId: SOBRETURNOS_CALENDAR_ID,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      }),
    ]);

    const nombreNorm = normalizarTexto(nombre);
    const todos = [...(principal.data.items || []), ...(sobreturnos.data.items || [])];

    const candidatos = todos
      .filter((ev) => normalizarTexto(ev.summary).includes(nombreNorm))
      .map((ev) => ({ start: eventBounds(ev).start, telefono: extraerTelefono(ev.description) }))
      .filter((c) => c.telefono)
      .sort((a, b) => b.start - a.start);

    res.status(200).json({ telefono: candidatos.length ? candidatos[0].telefono : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ telefono: null });
  }
}
