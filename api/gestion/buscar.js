import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER,
  eventBounds, extraerTelefono, extraerTelefonoVerificado, normalizarTexto,
  isValidGestionKey, toArgDate, formatArgDay,
} from '../../lib/googleCalendar.js';

const MESES_RANGO = 6;

// Búsqueda del sidebar (por defecto), autocompletado de teléfono (?modo=telefono),
// autocompletado de pacientes en vivo (?modo=pacientes) y la lista de tareas de
// teléfono del sidebar (?modo=tareas-telefono) comparten ruta para no pasarnos del
// límite de funciones serverless del plan gratuito.
export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.query.modo === 'telefono') {
    return buscarTelefono(req, res);
  }
  if (req.query.modo === 'pacientes') {
    return buscarPacientes(req, res);
  }
  if (req.query.modo === 'tareas-telefono') {
    return tareasTelefono(req, res);
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

const PACIENTES_LIMITE = 8;

async function buscarPacientes(req, res) {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.status(200).json([]);

    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setFullYear(timeMin.getFullYear() - 2);
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

    const qNorm = normalizarTexto(q);
    const todos = [...(principal.data.items || []), ...(sobreturnos.data.items || [])];

    // Agrupa por nombre normalizado: guarda el nombre más reciente para mostrar
    // y, por separado, el teléfono del evento más reciente que tenga uno cargado
    // (puede no ser el mismo evento si el paciente cambió de número).
    const grupos = new Map();

    todos.forEach((ev) => {
      const titulo = (ev.summary || '').trim();
      if (!titulo) return;
      const tituloNorm = normalizarTexto(titulo);
      if (!tituloNorm.includes(qNorm)) return;

      const start = eventBounds(ev).start;
      const telefono = extraerTelefono(ev.description);
      const g = grupos.get(tituloNorm) || { nombre: titulo, nombreStart: start, telefono: '', telStart: null };

      if (start > g.nombreStart) {
        g.nombre = titulo;
        g.nombreStart = start;
      }
      if (telefono && (!g.telStart || start > g.telStart)) {
        g.telefono = telefono;
        g.telStart = start;
      }

      grupos.set(tituloNorm, g);
    });

    const resultados = [...grupos.values()]
      .sort((a, b) => b.nombreStart - a.nombreStart)
      .slice(0, PACIENTES_LIMITE)
      .map(({ nombre, telefono }) => ({ nombre, telefono: telefono || '' }));

    res.status(200).json(resultados);
  } catch (err) {
    console.error(err);
    res.status(200).json([]);
  }
}

const RANGO_TAREAS_DIAS = 14;

// Alimenta la "lista de tareas inteligente" del sidebar de /gestion: turnos/sobreturnos
// de HOY en adelante (no eventos pasados, no bloqueos) sin ninguna línea de teléfono
// cargada, o con teléfono cargado pero sin la marca "Teléfono verificado: Sí" (mismo
// criterio que el badge "⚠ Tel. a revisar" de la agenda — ver decisions.md).
async function tareasTelefono(req, res) {
  try {
    const desde = toArgDate(formatArgDay(new Date()), '00:00');
    const hasta = new Date(desde.getTime() + RANGO_TAREAS_DIAS * 24 * 60 * 60000);

    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: desde.toISOString(),
        timeMax: hasta.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      }),
      calendar.events.list({
        calendarId: SOBRETURNOS_CALENDAR_ID,
        timeMin: desde.toISOString(),
        timeMax: hasta.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      }),
    ]);

    const todos = [
      ...(principal.data.items || []).map((ev) => ({ ev, calendarId: CALENDAR_ID })),
      ...(sobreturnos.data.items || []).map((ev) => ({ ev, calendarId: SOBRETURNOS_CALENDAR_ID })),
    ];

    const sinTelefono = [];
    const aRevisar = [];

    todos.forEach(({ ev, calendarId }) => {
      const allDay = !ev.start.dateTime;
      if (allDay || (ev.description || '').includes(BLOCK_MARKER)) return; // bloqueo, no es turno

      const telefono = extraerTelefono(ev.description);
      const item = {
        id: ev.id,
        calendarId,
        title: ev.summary || '',
        start: eventBounds(ev).start.toISOString(),
      };

      if (!telefono) {
        sinTelefono.push(item);
      } else if (!extraerTelefonoVerificado(ev.description)) {
        aRevisar.push({ ...item, telefono });
      }
    });

    const porFecha = (a, b) => new Date(a.start) - new Date(b.start);
    sinTelefono.sort(porFecha);
    aRevisar.sort(porFecha);

    res.status(200).json({ sinTelefono, aRevisar });
  } catch (err) {
    console.error(err);
    res.status(200).json({ sinTelefono: [], aRevisar: [] });
  }
}
