import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER,
  eventBounds, extraerTelefono, normalizarTexto, isValidGestionKey,
} from '../../lib/googleCalendar.js';

const MESES_RANGO = 6;

// Búsqueda del sidebar (por defecto) y autocompletado de teléfono (?modo=telefono)
// comparten ruta para no pasarnos del límite de funciones serverless del plan gratuito.
export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.query.modo === 'telefono') {
    return buscarTelefono(req, res);
  }

  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(200).json([]);

    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setMonth(timeMin.getMonth() - MESES_RANGO);
    const timeMax = new Date(now);
    timeMax.setMonth(timeMax.getMonth() + MESES_RANGO);

    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      calendar.events.list({
        calendarId: CALENDAR_ID,
        q,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      }),
      calendar.events.list({
        calendarId: SOBRETURNOS_CALENDAR_ID,
        q,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      }),
    ]);

    const items = [];

    (principal.data.items || []).forEach((ev) => {
      const { start, end } = eventBounds(ev);
      const allDay = !ev.start.dateTime;
      const isBloqueo = allDay || (ev.description || '').includes(BLOCK_MARKER);
      items.push({
        id: ev.id,
        calendarId: CALENDAR_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        title: ev.summary || '',
        description: ev.description || '',
        tipo: isBloqueo ? 'bloqueo' : 'turno',
        allDay,
      });
    });

    (sobreturnos.data.items || []).forEach((ev) => {
      const { start, end } = eventBounds(ev);
      items.push({
        id: ev.id,
        calendarId: SOBRETURNOS_CALENDAR_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        title: ev.summary || '',
        description: ev.description || '',
        tipo: 'sobreturno',
        allDay: !ev.start.dateTime,
      });
    });

    items.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo buscar.' });
  }
}

async function buscarTelefono(req, res) {
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
    const candidatos = [...(principal.data.items || []), ...(sobreturnos.data.items || [])]
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
