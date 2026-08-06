import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER,
  eventBounds, extraerTelefono, normalizarTexto,
  isValidGestionKey, toArgDate, formatArgDay,
} from '../../lib/googleCalendar.js';

const MESES_RANGO = 6;

// Búsqueda del sidebar (por defecto), autocompletado de teléfono (?modo=telefono),
// autocompletado de pacientes en vivo (?modo=pacientes) y la lista de tareas
// inteligente del sidebar (?modo=tareas) comparten ruta para no pasarnos del
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
  if (req.query.modo === 'tareas') {
    return tareas(req, res);
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

// Alimenta la "lista de tareas inteligente" del sidebar de /gestion, de HOY en
// adelante (14 días). Dos categorías, ambas de datos reales:
// - reorganizar: cada bloqueo (día completo, bloqueo-dia.js, O rango horario puntual,
//   bloquear-horario.js — ambos solo en CALENDAR_ID) que TODAVÍA tiene algún turno o
//   sobreturno superpuesto en su rango — hay que reubicarlos. Una tarea POR BLOQUEO,
//   no por día: si un mismo día tiene dos bloqueos con turnos (ej. dos horarios
//   puntuales distintos), son dos tareas separadas. El solapamiento se calcula con los
//   límites reales del bloqueo (eventBounds ya da 00:00→00:00 del día siguiente para
//   uno de día completo, así que la misma comparación sirve para los dos casos).
// - sinTelefono: turnos/sobreturnos sin ninguna línea de teléfono cargada.
// No incluye teléfonos con formato inválido: ese caso ya no genera tarea, solo el
// badge visual de la fila (ver decisions.md).
async function tareas(req, res) {
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
    const bloqueos = [];
    const turnos = [];

    todos.forEach(({ ev, calendarId }) => {
      const allDay = !ev.start.dateTime;
      const esBloqueo = allDay || (ev.description || '').includes(BLOCK_MARKER);

      if (esBloqueo) {
        // Los bloqueos (día completo u horario puntual) solo se crean en CALENDAR_ID
        // — ver bloqueo-dia.js / bloquear-horario.js / architecture.md.
        if (calendarId === CALENDAR_ID) {
          const { start, end } = eventBounds(ev);
          bloqueos.push({ start, end, fecha: formatArgDay(start) });
        }
        return;
      }

      const { start, end } = eventBounds(ev);
      turnos.push({ start, end });

      const telefono = extraerTelefono(ev.description);
      if (!telefono) {
        sinTelefono.push({
          id: ev.id,
          calendarId,
          title: ev.summary || '',
          start: start.toISOString(),
        });
      }
    });

    const reorganizar = bloqueos
      .map((b) => ({
        fecha: b.fecha,
        cantidadTurnos: turnos.filter((t) => t.start < b.end && t.end > b.start).length,
      }))
      .filter((b) => b.cantidadTurnos > 0)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    sinTelefono.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json({ sinTelefono, reorganizar });
  } catch (err) {
    console.error(err);
    res.status(200).json({ sinTelefono: [], reorganizar: [] });
  }
}
