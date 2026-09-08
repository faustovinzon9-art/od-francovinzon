// Cálculo de ASISTENCIA por paciente (pedido 2026-08-25, respuestas una por una en
// decisions.md). Guarda el resultado en las columnas I..M de la planilla "Pacientes
// consolidados" (turnosPasados, turnosAsistidos, visitas, ultimaVisita, calcActualizado).
//
// Reglas acordadas:
//   - "Asistió" a un turno = hay un movimiento VÁLIDO (no anulado) en la ficha con fecha
//     = día del turno. Solo movimientos; las prestaciones no cuentan.
//   - El % se calcula POR TURNO: si hubo movimiento ese día, TODOS los turnos de ese día
//     cuentan como asistidos (mismo criterio que la confirmación automática).
//   - Denominador = turnos PASADOS (fecha anterior a HOY — el turno de hoy cuenta recién
//     mañana). Entran turnos normales y sobreturnos. Los cancelados se borran del
//     calendario, así que no aparecen y no cuentan. Los bloqueos/feriados no son turnos.
//   - Visitas = días DISTINTOS con movimiento con fecha ≤ hoy (incluye urgencias sin
//     turno agendado). Último atendido = fecha del último día con movimiento.
//   - Identidad de los turnos: por DNI si el turno lo tiene; si no, por nombre+apellido
//     exactos. Si ese día hay homónimos sin DNI, no se atribuye a nadie.
//
// Estrategia eficiente: se baja UNA vez el índice de turnos pasados del período (ambos
// calendarios, paginado) y se atribuye cada evento a una fila de consolidados (DNI o
// nombre único) en memoria; después se leen los movimientos por ficha (1 batchGet por
// ficha con fichaId) y se escriben las columnas. Best-effort, con tandas (maxFichas/
// offset) para cuidar la cuota compartida con el consultorio.

import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, FERIADO_ATENDIDO_MARKER,
  eventBounds, formatArgDay, extraerDni, normalizarTexto,
} from './googleCalendar.js';
import { getPacientesSheetsClient } from './googleOAuthPacientes.js';
import { conReintentos } from './retry.js';
import { SHEET_NAME, normalizarDni } from './pacientesSheet.js';
import { listarPacientesConsolidados, guardarAsistenciaEnFila } from './pacientesConsolidados.js';
import { fechaMovimientoAISO } from './confirmarTurnosPorMovimiento.js';

const HOY_ISO = (() => {
  const d = new Date();
  return formatArgDay(d);
})();

// Fecha límite para "turnos pasados": ayer inclusive (hoy no cuenta hasta mañana).
const AYER_ISO = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatArgDay(d);
})();

async function listarEventosCalendario(calendar, calendarId, timeMin, timeMax) {
  const items = [];
  let pageToken = undefined;
  do {
    const { data } = await conReintentos(() => calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    }));
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return items;
}

// Baja todos los turnos pasados del período y los atribuye a filas de consolidados.
// Devuelve: { porFila: Map(fila -> { turnos: n, fechasTurnos: [ISO...] }) }
// La atribución usa DNI si el evento lo tiene; si no, nombre exacto ÚNICO ese día (los
// homónimos sin DNI no se atribuyen a nadie — regla del usuario).
async function atribuirTurnosPasados(calendar, filasConsolidadas) {
  // Turnos pasados = fecha ANTERIOR a hoy (el de hoy cuenta recién mañana): se baja el
  // calendario desde 2020 hasta el final de AYER.
  const timeMin = new Date('2020-01-01T00:00:00-03:00');
  const timeMax = new Date(`${AYER_ISO}T23:59:59-03:00`);

  // Índices de identidad por fila: DNI normalizado -> fila; nombre normalizado -> fila.
  const dniAFila = new Map();
  const nombreAFila = new Map();
  const nombresDuplicados = new Set();
  filasConsolidadas.forEach((f) => {
    const dniNorm = normalizarDni(f.dni);
    if (dniNorm && !dniAFila.has(dniNorm)) dniAFila.set(dniNorm, f);
    const nomNorm = normalizarTexto(`${f.nombre} ${f.apellido}`);
    if (nomNorm) {
      if (nombreAFila.has(nomNorm)) nombresDuplicados.add(nomNorm);
      else nombreAFila.set(nomNorm, f);
    }
  });

  // Por día, para detectar homónimos sin DNI: cuántos eventos "solo nombre" hay ese día.
  const eventosPorDia = new Map(); // fecha -> eventos
  for (const calendarId of [CALENDAR_ID, SOBRETURNOS_CALENDAR_ID]) {
    const items = await listarEventosCalendario(calendar, calendarId, timeMin, timeMax);
    items.forEach((ev) => {
      const esBloqueo = !ev.start.dateTime || (ev.description || '').includes(BLOCK_MARKER)
        || ((ev.description || '').includes(FERIADO_ATENDIDO_MARKER) && !ev.start.dateTime);
      if (esBloqueo) return;
      const { start } = eventBounds(ev);
      const fecha = formatArgDay(start);
      if (fecha > AYER_ISO) return; // defensivo: turnos de hoy/futuros no cuentan todavía
      const evData = {
        calendarId, eventId: ev.id,
        fecha,
        tituloNorm: normalizarTexto(ev.summary),
        dni: extraerDni(ev.description),
      };
      if (!eventosPorDia.has(fecha)) eventosPorDia.set(fecha, []);
      eventosPorDia.get(fecha).push(evData);
    });
  }

  // Conteo de "solo nombre" por día para homónimos.
  const soloNombrePorDia = new Map();
  for (const [fecha, eventos] of eventosPorDia) {
    const conteo = new Map();
    eventos.forEach((e) => { if (!e.dni && e.tituloNorm) conteo.set(e.tituloNorm, (conteo.get(e.tituloNorm) || 0) + 1); });
    soloNombrePorDia.set(fecha, conteo);
  }

  const porFila = new Map();
  const cuenta = (fila, fecha) => {
    if (!porFila.has(fila.fila)) porFila.set(fila.fila, { turnos: 0, fechasTurnos: [] });
    const acc = porFila.get(fila.fila);
    acc.turnos += 1;
    acc.fechasTurnos.push(fecha);
  };

  for (const [fecha, eventos] of eventosPorDia) {
    const conteoNombres = soloNombrePorDia.get(fecha);
    eventos.forEach((e) => {
      if (e.dni) {
        const fila = dniAFila.get(normalizarDni(e.dni));
        if (fila) cuenta(fila, fecha);
        return;
      }
      // Sin DNI: solo se atribuye si el nombre es único ese día Y único entre pacientes.
      if (!e.tituloNorm) return;
      if (nombresDuplicados.has(e.tituloNorm)) return;
      if ((conteoNombres.get(e.tituloNorm) || 0) !== 1) return;
      const fila = nombreAFila.get(e.tituloNorm);
      if (fila) cuenta(fila, fecha);
    });
  }

  return porFila;
}

// Lee los movimientos válidos de una ficha (1 batchGet) → Set de fechas ≤ hoy (fecha del
// movimiento; los movimientos anulados no cuentan; con fecha futura no es "visita" aún).
async function leerMovimientosFicha(sheets, fichaId) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: fichaId,
    ranges: [`${SHEET_NAME}!B18:C2000`],
  }));
  const fechas = new Set();
  const filas = data.valueRanges?.[0]?.values || [];
  filas.forEach((r) => {
    const tratamiento = r[1] != null ? String(r[1]).trim() : '';
    if (/^\[ANULADO\]/.test(tratamiento)) return;
    const iso = fechaMovimientoAISO(r[0]);
    if (iso && iso <= HOY_ISO) fechas.add(iso);
  });
  return fechas;
}

// Recálculo de asistencia. dryRun = contar sin escribir. Tandas con maxFichas/offset
// sobre las filas CON fichaId (las que no tienen ficha no tienen movimientos → sin %).
export async function recalcularAsistencia({ dryRun = false, maxFichas = 0, offset = 0 } = {}) {
  try {
    const filas = await listarPacientesConsolidados();
    const conFicha = filas.filter((f) => f.fichaId);
    const totalConFicha = conFicha.length;
    const slice = maxFichas > 0 ? conFicha.slice(offset, offset + maxFichas) : conFicha;
    if (!slice.length) return { filas: 0, totalConFicha, aviso: 'sin fichas en el rango' };

    const calendar = getCalendarClient();
    const sheets = getPacientesSheetsClient();

    // Atribución de turnos pasados (1 sola bajada de Calendar, sirve para cualquier tanda).
    const porFila = await atribuirTurnosPasados(calendar, filas);

    let procesadas = 0;
    const detalles = [];
    for (const fila of slice) {
      const atrib = porFila.get(fila.fila) || { turnos: 0, fechasTurnos: [] };
      const turnosPasados = atrib.turnos;

      let fechasMov;
      try {
        fechasMov = await leerMovimientosFicha(sheets, fila.fichaId);
      } catch (err) {
        if (/quota/i.test(err?.message || '')) throw err; // dejar que el reintento superior la maneje
        console.warn('[asistenciaPacientes] ficha ilegible:', fila.fichaId, err?.message);
        continue;
      }

      const visitas = fechasMov.size;
      const ultimaVisita = visitas ? [...fechasMov].sort().pop() : '';
      // Asistidos = turnos pasados cuyo día tiene movimiento (por turno).
      let turnosAsistidos = 0;
      if (visitas) {
        for (const fecha of atrib.fechasTurnos) {
          if (fechasMov.has(fecha)) turnosAsistidos += 1;
        }
      }

      if (!dryRun) {
        await guardarAsistenciaEnFila({
          fila: fila.fila,
          turnosPasados,
          turnosAsistidos,
          visitas,
          ultimaVisita,
        });
      }
      procesadas += 1;
      if (detalles.length < 10) {
        detalles.push({
          fila: fila.fila, nombre: `${fila.nombre} ${fila.apellido}`.trim(),
          turnosPasados, turnosAsistidos, visitas, ultimaVisita, dryRun,
        });
      }
    }

    return { filasProcesadas: procesadas, totalConFicha, detalle: detalles };
  } catch (err) {
    console.error('[asistenciaPacientes] recálculo:', err);
    return { error: err?.message || String(err) };
  }
}

export { AYER_ISO, HOY_ISO };
