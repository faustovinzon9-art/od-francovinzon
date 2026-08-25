import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, FERIADO_ATENDIDO_MARKER,
  eventBounds, extraerTelefono, extraerTelefonoVerificado, extraerDni, normalizarTexto,
  isValidGestionKey, toArgDate, formatArgDay,
} from '../../lib/googleCalendar.js';
import { buscarPacienteConsolidadoPorNombre, buscarPacienteConsolidadoPorDni, buscarPacienteConsolidadoPorTelefono, listarPacientesConsolidados } from '../../lib/pacientesConsolidados.js';
import { normalizarDni, rangoPrestacionesObraSocial } from '../../lib/pacientesSheet.js';
import { getPacientesSheetsClient } from '../../lib/googleOAuthPacientes.js';
import { esFeriado } from '../../lib/feriados.js';
import { conReintentos } from '../../lib/retry.js';

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
  if (req.query.modo === 'proximo-bloqueo') {
    return proximoBloqueo(req, res);
  }
  // Feriado de un día puntual (badge en la agenda de /gestion, feature 2026-08-24).
  if (req.query.modo === 'feriados') {
    return feriadoDelDia(req, res);
  }
  // Listado central de pacientes (Fase 2, sistema centralizado 2026-08-25).
  if (req.query.modo === 'pacientes-central') {
    return pacientesCentral(req, res);
  }
  // Perfil central de un paciente (Fase 3): datos de la planilla + turnos + ficha.
  if (req.query.modo === 'perfil-paciente') {
    return perfilPaciente(req, res);
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

// Autocompletado de teléfono+DNI de /gestion (ver el pedido, 2026-08-14) — antes
// escaneaba turnos de Calendar por substring de nombre, lo cual fallaba cuando el
// nombre del turno no coincidía exacto con el de la ficha o cuando el paciente no tenía
// ningún turno reciente con teléfono cargado. Ahora resuelve contra la planilla
// "Pacientes consolidados" (lib/pacientesConsolidados.js), fuente única armada con
// fichas + historial de turnos ya sincronizados de antemano — una sola lectura, sin
// volver a escanear Calendar en cada tipeo.
async function buscarTelefono(req, res) {
  try {
    const nombre = (req.query.nombre || '').trim();
    if (nombre.length < 2) return res.status(200).json({ telefono: null, dni: null });

    const match = await buscarPacienteConsolidadoPorNombre(nombre);
    if (!match || !match.telefono) return res.status(200).json({ telefono: null, dni: null });

    // Nunca "verificado" acá (esa marca es específica de intl-tel-input en /gestion/
    // /turnos) — se pasa el teléfono tal cual, dejando que la librería lo interprete
    // con Argentina como país por default, mismo criterio que un número legado.
    res.status(200).json({ telefono: match.telefono, telefonoVerificado: false, dni: match.dni || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ telefono: null, dni: null });
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
      const g = grupos.get(tituloNorm) || { nombre: titulo, nombreStart: start, telefono: '', telefonoVerificado: false, telStart: null };

      if (start > g.nombreStart) {
        g.nombre = titulo;
        g.nombreStart = start;
      }
      const dniEv = extraerDni(ev.description);
      if (dniEv && (!g.dni || start > g.dniStart)) {
        g.dni = dniEv;
        g.dniStart = start;
      }
      if (telefono && (!g.telStart || start > g.telStart)) {
        g.telefono = telefono;
        g.telefonoVerificado = extraerTelefonoVerificado(ev.description);
        g.telStart = start;
      }

      grupos.set(tituloNorm, g);
    });

    const resultados = [...grupos.values()]
      .sort((a, b) => b.nombreStart - a.nombreStart)
      .slice(0, PACIENTES_LIMITE)
      .map(({ nombre, telefono, telefonoVerificado, dni }) => ({ nombre, telefono: telefono || '', telefonoVerificado, dni: dni || '' }));

    res.status(200).json(resultados);
  } catch (err) {
    console.error(err);
    res.status(200).json([]);
  }
}

const RANGO_SIN_TELEFONO_DIAS = 14;
// Los bloqueos se pueden cargar con mucha anticipación (ej. cerrar por
// vacaciones/fiestas con meses de anticipo) — 14 días se quedaba corto y la tarea
// "Reorganizar turnos" no aparecía para un bloqueo+turno más lejano en el tiempo,
// aunque el cruce en sí estuviera bien calculado (bug real: no se llegaba a pedir
// esos eventos a la Calendar API). Mismo horizonte que ya usa proximo-bloqueo.js.
const RANGO_REORGANIZAR_DIAS = 120;

// Badge de feriado del día en la agenda de /gestion: GET ?modo=feriados&date=YYYY-MM-DD.
// Devuelve { feriado: { fecha, tipo, nombre } | null, atendido: bool (marcador de
// "se atiende"), bloqueado: bool (bloqueo de día completo) }. Fallback seguro: si la
// API de feriados no responde, feriado = null (nunca rompe el panel).
async function feriadoDelDia(req, res) {
  try {
    const dateStr = req.query.date;
    const [feriado, calendar] = await Promise.all([
      esFeriado(dateStr),
      getCalendarClient(),
    ]);
    let atendido = false;
    let bloqueado = false;
    if (feriado) {
      const dayStart = toArgDate(dateStr, '00:00');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);
      const { data } = await conReintentos(() => calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      }));
      (data.items || []).forEach((ev) => {
        if (!ev.start.dateTime) {
          const desc = ev.description || '';
          if (desc.includes(FERIADO_ATENDIDO_MARKER)) atendido = true;
          else if (desc.includes(BLOCK_MARKER)) bloqueado = true;
        }
      });
    }
    res.status(200).json({ feriado, atendido, bloqueado });
  } catch (err) {
    console.error(err);
    res.status(200).json({ feriado: null, atendido: false, bloqueado: false });
  }
}

// Alimenta la "lista de tareas inteligente" del sidebar de /gestion. Tres categorías,
// todas de datos reales, cada una con su propia ventana (sinDni comparte la ventana
// corta de sinTelefono — mismo criterio: no tiene sentido recordar un dato faltante de
// un turno lejano todavía, ver el pedido, 2026-08-13):
// - reorganizar: cada bloqueo (día completo, bloqueo-dia.js, O rango horario puntual,
//   bloquear-horario.js — ambos solo en CALENDAR_ID) que TODAVÍA tiene algún turno o
//   sobreturno superpuesto en su rango — hay que reubicarlos. Una tarea POR BLOQUEO,
//   no por día: si un mismo día tiene dos bloqueos con turnos (ej. dos horarios
//   puntuales distintos), son dos tareas separadas. El solapamiento se calcula con los
//   límites reales del bloqueo (eventBounds ya da 00:00→00:00 del día siguiente para
//   uno de día completo, así que la misma comparación sirve para los dos casos).
//   Ventana: hoy + 120 días (RANGO_REORGANIZAR_DIAS).
// - sinTelefono: turnos/sobreturnos sin ninguna línea de teléfono cargada. Ventana
//   más corta a propósito (hoy + 14 días, RANGO_SIN_TELEFONO_DIAS) — no tiene sentido
//   recordar "agregar teléfono" de un turno lejano todavía.
// No incluye teléfonos con formato inválido: ese caso ya no genera tarea, solo el
// badge visual de la fila (ver decisions.md).
async function tareas(req, res) {
  try {
    const desde = toArgDate(formatArgDay(new Date()), '00:00');
    const limiteSinTelefono = new Date(desde.getTime() + RANGO_SIN_TELEFONO_DIAS * 24 * 60 * 60000);
    const hasta = new Date(desde.getTime() + RANGO_REORGANIZAR_DIAS * 24 * 60 * 60000);

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
    const sinDni = [];
    const bloqueos = [];
    const turnos = [];
    const feriadosAtendidos = new Set(); // fechas con marcador FERIADO_ATENDIDO (se atiende)

    todos.forEach(({ ev, calendarId }) => {
      const allDay = !ev.start.dateTime;
      const { start, end } = eventBounds(ev);
      const esMarcadorFeriado = allDay && (ev.description || '').includes(FERIADO_ATENDIDO_MARKER);
      if (esMarcadorFeriado) {
        feriadosAtendidos.add(formatArgDay(start));
        return;
      }
      const esBloqueo = allDay || (ev.description || '').includes(BLOCK_MARKER);

      if (esBloqueo) {
        // Los bloqueos (día completo u horario puntual) solo se crean en CALENDAR_ID
        // — ver bloqueo-dia.js / bloquear-horario.js / architecture.md.
        if (calendarId === CALENDAR_ID) {
          bloqueos.push({ start, end, fecha: formatArgDay(start) });
        }
        return;
      }

      turnos.push({ start, end });

      // "Agregar teléfono"/"Agregar DNI" solo para turnos dentro de la ventana corta —
      // el turno en sí ya se agregó a `turnos` arriba con la ventana larga, para que el
      // cruce con bloqueos lejanos funcione igual. El DNI no es obligatorio al crear un
      // turno (ver el pedido) — por eso, si falta, queda como recordatorio acá en vez de
      // bloquear la carga.
      if (start < limiteSinTelefono) {
        const telefono = extraerTelefono(ev.description);
        if (!telefono) {
          sinTelefono.push({
            id: ev.id,
            calendarId,
            title: ev.summary || '',
            start: start.toISOString(),
          });
        }
        if (!extraerDni(ev.description)) {
          sinDni.push({
            id: ev.id,
            calendarId,
            title: ev.summary || '',
            start: start.toISOString(),
          });
        }
      }
    });

    const reorganizar = bloqueos
      .map((b) => ({
        fecha: b.fecha,
        cantidadTurnos: turnos.filter((t) => t.start < b.end && t.end > b.start).length,
      }))
      .filter((b) => b.cantidadTurnos > 0)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    // "¿Se atiende este día?" (feature 2026-08-24): feriados en la ventana corta (14
    // días) que todavía no se decidieron — sin bloqueo ese día (ya se decidió "no") y
    // sin marcador de atendido (ya se decidió "sí"). Una tarea por feriado, para que la
    // secretaria responda con un toque (Sí = marcador, No = bloqueo de día completo).
    const bloqueosPorFecha = new Set(bloqueos.map((b) => b.fecha));
    const feriados = [];
    for (let i = 0; i < RANGO_SIN_TELEFONO_DIAS; i++) {
      const dia = new Date(desde.getTime() + i * 24 * 60 * 60000);
      const fechaStr = formatArgDay(dia);
      if (bloqueosPorFecha.has(fechaStr) || feriadosAtendidos.has(fechaStr)) continue;
      const feriado = await esFeriado(fechaStr);
      if (feriado) {
        feriados.push({ fecha: fechaStr, nombre: feriado.nombre, tipo: feriado.tipo });
      }
    }

    sinTelefono.sort((a, b) => new Date(a.start) - new Date(b.start));
    sinDni.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json({ sinTelefono, sinDni, reorganizar, feriados });
  } catch (err) {
    console.error(err);
    res.status(200).json({ sinTelefono: [], sinDni: [], reorganizar: [], feriados: [] });
  }
}

// Próximo día bloqueado por completo a partir de hoy — resumen del sidebar.
// (Fusionado desde proximo-bloqueo.js, mismo horizonte que RANGO_REORGANIZAR_DIAS.)
async function proximoBloqueo(req, res) {
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const timeMax = new Date(now.getTime() + RANGO_REORGANIZAR_DIAS * 24 * 60 * 60000);

    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      q: BLOCK_MARKER,
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const bloqueoDia = (data.items || []).find(
      (ev) => !ev.start.dateTime && (ev.description || '').includes(BLOCK_MARKER)
    );

    res.status(200).json({ date: bloqueoDia ? bloqueoDia.start.date : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo consultar.' });
  }
}


// ---------- FASE 2/3 — SISTEMA CENTRALIZADO DE PACIENTES (2026-08-25) ----------

// Listado central de pacientes: GET ?modo=pacientes-central&q=. Todas las fuentes
// (fichas + turnos + creados desde gestión) unificadas en la planilla consolidada.
// Filtra por nombre/apellido/DNI/teléfono/email (substring normalizado). Devuelve
// hasta 50; fallback seguro a lista vacía.
async function pacientesCentral(req, res) {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    let filas = await listarPacientesConsolidados();
    if (q) {
      const qNorm = normalizarTexto(q);
      const qDni = q.replace(/\D/g, '');
      filas = filas.filter((f) =>
        normalizarTexto(`${f.nombre} ${f.apellido}`).includes(qNorm) ||
        (qDni && normalizarDni(f.dni).includes(qDni)) ||
        normalizarTexto(f.telefono).includes(qNorm) ||
        String(f.email || '').toLowerCase().includes(q)
      );
    }
    let resultado = filas.slice(0, 500).map((f) => ({
      nombre: f.nombre, apellido: f.apellido, dni: f.dni, telefono: f.telefono,
      email: f.email, conFicha: !!f.fichaId, fichaId: f.fichaId || '', origen: f.origen,
      actualizado: f.actualizado,
    }));

    // PLAN B (lección 2026-08-25): si la planilla consolidada no trae resultados (está
    // vacía/incompleta o la búsqueda no matchea), caer a la búsqueda en Calendar para que
    // el buscador NUNCA quede vacío — la sección Pacientes no puede romperse por la
    // planilla. Se marca el origen para que la UI lo muestre igual.
    if (resultado.length === 0 && q) {
      try {
        const desdeC = new Date();
        desdeC.setFullYear(desdeC.getFullYear() - 2);
        const hastaC = new Date();
        hastaC.setMonth(hastaC.getMonth() + 3);
        const calendar = getCalendarClient();
        const [p, s] = await Promise.all([
          conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin: desdeC.toISOString(), timeMax: hastaC.toISOString(), singleEvents: true, maxResults: 2500 })),
          conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin: desdeC.toISOString(), timeMax: hastaC.toISOString(), singleEvents: true, maxResults: 2500 })),
        ]);
        const qNorm = normalizarTexto(q);
        const vistos = new Map();
        [...(p.data.items || []), ...(s.data.items || [])].forEach((ev) => {
          if ((ev.description || '').includes(BLOCK_MARKER)) return;
          const titulo = (ev.summary || '').trim();
          if (!titulo || !normalizarTexto(titulo).includes(qNorm)) return;
          const key = normalizarTexto(titulo) + '|' + normalizarDni(extraerDni(ev.description));
          if (!vistos.has(key)) {
            const partes = titulo.split(' ');
            vistos.set(key, {
              nombre: partes.shift() || '', apellido: partes.join(' '), dni: extraerDni(ev.description),
              telefono: extraerTelefono(ev.description), email: '', conFicha: false, fichaId: '', origen: 'turno', actualizado: '',
            });
          }
        });
        if (vistos.size) resultado = [...vistos.values()].slice(0, 100);
      } catch (err) {
        console.warn('[buscar.js] fallback a Calendar falló:', err?.message || err);
      }
    }

    res.status(200).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(200).json([]);
  }
}

// Perfil central: GET ?modo=perfil-paciente&dni= (o &identidad= con teléfono normalizado).
// Devuelve los datos centrales + la lista de turnos del paciente (pasados y futuros,
// ambos calendarios, ±1 año) + si tiene ficha. Solo lectura — la edición va por
// api/gestion/pacientes.js (accion 'actualizar-paciente-central').
async function perfilPaciente(req, res) {
  try {
    const dni = String(req.query.dni || '').trim();
    const telefono = String(req.query.telefono || '').trim();
    const paciente = dni ? await buscarPacienteConsolidadoPorDni(dni) : (telefono ? await buscarPacienteConsolidadoPorTelefono(telefono) : null);
    if (!paciente) {
      return res.status(200).json({ encontrado: false });
    }
    const calendar = getCalendarClient();
    const ahora = new Date();
    const desde = new Date(ahora.getTime() - 365 * 24 * 60 * 60000);
    const hasta = new Date(ahora.getTime() + 365 * 24 * 60 * 60000);

    const turnos = [];
    const dniNorm = normalizarDni(dni);
    for (const calendarId of [CALENDAR_ID, SOBRETURNOS_CALENDAR_ID]) {
      let pageToken;
      do {
        const { data } = await conReintentos(() => calendar.events.list({
          calendarId,
          timeMin: desde.toISOString(),
          timeMax: hasta.toISOString(),
          singleEvents: true,
          maxResults: 2500,
          pageToken,
        }));
        for (const ev of data.items || []) {
          if ((ev.description || '').includes(BLOCK_MARKER)) continue;
          // matchear por DNI exacto cuando el evento lo tiene; si no, por título igual
          const evDni = normalizarDni(extraerDni(ev.description));
          const matcheaDni = evDni && evDni === dniNorm;
          const matcheaNombre = !evDni && (ev.summary || '').trim() === `${paciente.nombre} ${paciente.apellido}`.trim();
          if (!matcheaDni && !matcheaNombre) continue;
          const { start, end } = eventBounds(ev);
          turnos.push({
            eventId: ev.id, calendarId, title: ev.summary || '',
            start: start.toISOString(), end: end.toISOString(),
            tipo: !ev.start.dateTime ? 'bloqueo' : (calendarId === SOBRETURNOS_CALENDAR_ID ? 'sobreturno' : 'turno'),
            confirmado: /Confirmado:\s*S[ií]/i.test(ev.description || ''),
            telefono: extraerTelefono(ev.description),
          });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    }
    turnos.sort((a, b) => new Date(a.start) - new Date(b.start));

    // Prestaciones de obra social: viven en la ficha (tabla J:M). Si el paciente tiene
    // ficha, se devuelven las últimas 8 con su estado — el perfil central las muestra sin
    // salir de /gestion (Fase 3 completa).
    let prestaciones = [];
    if (paciente.fichaId) {
      try {
        const sheets = getPacientesSheetsClient();
        const { data: pres } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: paciente.fichaId, range: rangoPrestacionesObraSocial() }));
        const limpiar = (v) => (v === true || v === false || v === 'TRUE' || v === 'FALSE') ? '' : (v || '');
        prestaciones = (pres.data.values || [])
          .map((row) => ({ fecha: row[0] || '', tratamiento: limpiar(row[1]), codigo: limpiar(row[2]), autorizado: row[3] === true || row[3] === 'TRUE' }))
          .filter((p) => p.fecha || p.tratamiento || p.codigo)
          .slice(-8)
          .reverse();
      } catch (err) {
        console.warn('[buscar.js] no se pudieron leer las prestaciones del perfil:', err?.message || err);
      }
    }

    res.status(200).json({
      encontrado: true,
      paciente: {
        nombre: paciente.nombre, apellido: paciente.apellido, dni: paciente.dni,
        telefono: paciente.telefono, email: paciente.email,
        conFicha: !!paciente.fichaId, fichaId: paciente.fichaId || '', origen: paciente.origen,
      },
      turnos,
      prestaciones,
    });
  } catch (err) {
    console.error(err);
    res.status(200).json({ encontrado: false });
  }
}

