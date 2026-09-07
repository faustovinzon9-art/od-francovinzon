// Confirmación automática de turnos por movimientos en la ficha (pedido 2026-08-25):
// si un paciente tiene un turno el día D y en su ficha hay un MOVIMIENTO VÁLIDO (no
// anulado) con fecha D, ese turno queda "Confirmado: Sí" — aunque sea viejo y nadie lo
// haya confirmado a mano. Reglas acordadas con el usuario (una por una, ver decisions.md):
//   - Solo cuentan los movimientos (tratamiento/pago/debe/haber), NO prestaciones.
//   - Se compara la FECHA DEL MOVIMIENTO (puede cargarse después con "carga histórica")
//     contra el día del turno; aplica a turnos pasados, de hoy y futuros por igual.
//   - Los movimientos anulados no cuentan; pero una vez confirmado un turno queda
//     confirmado (anular el movimiento después no lo des-confirma).
//   - Si el paciente tiene varios turnos ese día se confirman todos; sobreturnos también.
//   - Identidad: DNI del turno si lo tiene; si no, nombre+apellido EXACTOS. Si ese día
//     hay homónimos sin DNI, no se confirma ninguno (nunca marcar al paciente equivocado).
//   - Se respeta un "Confirmado: No" explícito (Ayelen lo desmarcó a mano): la regla
//     solo confirma turnos que no tengan esa marca (los viejos no tienen ninguna marca).
//   - La confirmación automática se registra en el historial como 'turno_confirmado_automatico'.
// Se reusa desde: api/gestion/pacientes.js (al guardar/editar un movimiento) y desde la
// pasada retroactiva única (modo temporal en pacientes.js, dry-run por default). Este
// archivo es lib/ (no suma una función serverless al límite del plan).

import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, FERIADO_ATENDIDO_MARKER,
  eventBounds, formatArgDay, extraerDni, escribirConfirmado, normalizarTexto,
} from './googleCalendar.js';
import { getPacientesSheetsClient } from './googleOAuthPacientes.js';
import { conReintentos } from './retry.js';
import { logActividad } from './adminConfig.js';
import { SHEET_NAME } from './pacientesSheet.js';

const DIA_MS = 24 * 60 * 60000;

// Normaliza fecha de movimiento (viene como "DD/MM/AAAA" texto, o serial de fecha si la
// celda quedó con formato fecha) a "AAAA-MM-DD" (mismo formato que formatArgDay).
export function fechaMovimientoAISO(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Serial de planilla (días desde 1899-12-30): "45235" -> fecha.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 20000 && serial < 60000) {
      const base = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(base.getTime() + serial * 24 * 3600 * 1000);
      return formatArgDay(d);
    }
  }
  return '';
}

// Devuelve las fechas (AAAA-MM-DD) de los movimientos VÁLIDOS (no anulados) de una ficha.
// "Válido" = fila con contenido real (fecha/tratamiento/monto) y tratamiento que no
// empiece con "[ANULADO]". Solo lee B:C (fecha y tratamiento), que es todo lo que hace
// falta para esta regla.
async function fechasMovimientosValidos(sheets, fichaId) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({
    spreadsheetId: fichaId,
    range: `${SHEET_NAME}!B18:C2000`,
  }));
  const fechas = new Set();
  (data.values || []).forEach((r) => {
    const tratamiento = r[1] != null ? String(r[1]).trim() : '';
    if (/^\[ANULADO\]/.test(tratamiento)) return;
    const iso = fechaMovimientoAISO(r[0]);
    if (iso) fechas.add(iso);
  });
  return fechas;
}

// Lista los eventos "de turno" (no bloqueos, no feriado-atendido) de un día en ambos
// calendarios, con lo necesario para matchear paciente y confirmar.
async function eventosTurnosDelDia(calendar, fechaISO) {
  const dayStart = new Date(`${fechaISO}T00:00:00-03:00`);
  const dayEnd = new Date(dayStart.getTime() + DIA_MS);
  const salida = [];
  for (const calendarId of [CALENDAR_ID, SOBRETURNOS_CALENDAR_ID]) {
    const { data } = await conReintentos(() => calendar.events.list({
      calendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
    }));
    (data.items || []).forEach((ev) => {
      const { start } = eventBounds(ev);
      const esBloqueo = !ev.start.dateTime || (ev.description || '').includes(BLOCK_MARKER)
        || ((ev.description || '').includes(FERIADO_ATENDIDO_MARKER) && !ev.start.dateTime);
      if (esBloqueo) return;
      const dniEvento = extraerDni(ev.description);
      salida.push({
        calendarId,
        eventId: ev.id,
        start: start.toISOString(),
        titulo: (ev.summary || '').trim(),
        tituloNorm: normalizarTexto(ev.summary),
        dni: dniEvento,
        description: ev.description || '',
      });
    });
  }
  return salida;
}

// ¿La descripción ya dice "Confirmado: No" explícito? (desmarcado manual — se respeta).
function tieneConfirmadoNo(description) {
  return /Confirmado:\s*No/i.test(description);
}
// ¿Ya está confirmado? (entonces no hay nada que escribir ni loguear).
function yaConfirmado(description) {
  return /Confirmado:\s*S[ií]/i.test(description);
}

// Marca un turno como confirmado (escribe en Calendar + registra en el historial).
// Solo escribe si el turno NO tiene "Confirmado: No" explícito.
async function confirmarEvento(calendar, evento, fechaISO, identidad, dryRun) {
  if (tieneConfirmadoNo(evento.description)) return { confirmado: false, razon: 'no explícito' };
  if (yaConfirmado(evento.description)) return { confirmado: false, razon: 'ya' };
  const titulo = evento.titulo || 'paciente';
  if (dryRun) return { confirmado: true, dryRun: true, titulo, fecha: fechaISO };
  try {
    const nuevaDescripcion = escribirConfirmado(evento.description, true);
    await conReintentos(() => calendar.events.patch({
      calendarId: evento.calendarId,
      eventId: evento.eventId,
      requestBody: { description: nuevaDescripcion },
    }));
    await logActividad({
      tipo: 'turno_confirmado_automatico',
      detalle: `${titulo} — ${fechaISO} (movimiento en la ficha ese día)`,
      actor: 'automático',
    });
    return { confirmado: true, titulo, fecha: fechaISO };
  } catch (err) {
    console.warn('[confirmarTurnosPorMovimiento] no se pudo confirmar turno:', err?.message || err);
    return { confirmado: false, razon: 'error' };
  }
}

// Matchea los eventos del día contra la identidad de la ficha.
// Estrategia (reglas del usuario): primero por DNI exacto (nunca ambiguo). Si el turno
// no trae DNI, matchear por nombre+apellido exactos SOLO si ese día hay exactamente un
// evento con ese nombre (si hay homónimos sin DNI, no confirmar ninguno).
function seleccionarEventos(eventos, { nombre, apellido, dni }) {
  const nombreCompletoNorm = normalizarTexto(`${nombre} ${apellido}`);
  const dniNorm = dni ? String(dni).replace(/\D/g, '') : '';
  const conDni = dniNorm ? eventos.filter((e) => e.dni && String(e.dni).replace(/\D/g, '') === dniNorm) : [];
  if (conDni.length) return conDni;
  const porNombre = eventos.filter((e) => !e.dni && e.tituloNorm === nombreCompletoNorm);
  // Homónimos sin DNI ese día -> no confirmar ninguno (regla del usuario).
  if (porNombre.length !== 1) return [];
  return porNombre;
}

// Lee la identidad (nombre/apellido/dni) de una ficha (celdas C5:C7 de la hoja).
async function leerIdentidadFicha(sheets, fichaId) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({
    spreadsheetId: fichaId,
    range: `${SHEET_NAME}!C5:C7`,
  }));
  const [nombre = '', apellido = '', dni = ''] = (data.values || []).map((r) => (r[0] != null ? String(r[0]).trim() : ''));
  return { nombre, apellido, dni };
}

// Confirma los turnos del paciente de una ficha en una fecha puntual (AAAA-MM-DD).
// Se llama tras guardar/editar un movimiento con esa fecha (el movimiento puede ser de
// hoy o histórico). Best-effort: nunca tira (el guardado del movimiento no puede fallar
// por esto).
export async function confirmarTurnosDeFichaEnFecha({ fichaId, fechaISO, dryRun = false }) {
  if (!fichaId || !fechaISO) return { confirmados: 0 };
  try {
    const sheets = getPacientesSheetsClient();
    const identidad = await leerIdentidadFicha(sheets, fichaId);
    if (!identidad.nombre || !identidad.apellido) return { confirmados: 0 };
    const calendar = getCalendarClient();
    const eventos = await eventosTurnosDelDia(calendar, fechaISO);
    const elegidos = seleccionarEventos(eventos, identidad);
    const resultados = [];
    for (const evento of elegidos) {
      const r = await confirmarEvento(calendar, evento, fechaISO, identidad, dryRun);
      resultados.push(r);
    }
    return { confirmados: resultados.filter((r) => r.confirmado).length, total: elegidos.length };
  } catch (err) {
    console.warn('[confirmarTurnosPorMovimiento] confirmarTurnosDeFichaEnFecha:', err?.message || err);
    return { confirmados: 0, error: err?.message };
  }
}

// ---- Hook "turno creado/movido a un día que ya tiene movimiento" (Q13) ----
// Se llama después de crear o mover un turno. Busca la ficha del paciente (por DNI,
// teléfono o nombre exacto en la planilla consolidada) y, si esa ficha tiene un
// movimiento válido con la fecha del turno, confirma ESE evento puntual.
// Best-effort: nunca tira (crear/mover turno no puede fallar por esto).
export async function confirmarTurnoPuntualSiMovimiento({ eventId, calendarId, nombre, apellido, dni, telefono, fechaISO, dryRun = false }) {
  if (!eventId || !calendarId || !fechaISO) return { confirmado: 0 };
  try {
    const { buscarPacienteConsolidadoPorDni, buscarPacienteConsolidadoPorTelefono, buscarPacienteConsolidadoPorNombre } = await import('./pacientesConsolidados.js');
    const dniNorm = dni ? String(dni).replace(/\D/g, '') : '';
    let ficha = null;
    if (dniNorm) ficha = await buscarPacienteConsolidadoPorDni(dniNorm);
    if (!ficha && telefono) ficha = await buscarPacienteConsolidadoPorTelefono(telefono);
    if (!ficha && nombre && apellido) ficha = await buscarPacienteConsolidadoPorNombre(`${nombre} ${apellido}`);
    if (!ficha || !ficha.fichaId) return { confirmado: 0 };

    const sheets = getPacientesSheetsClient();
    const fechas = await fechasMovimientosValidos(sheets, ficha.fichaId);
    if (!fechas.has(fechaISO)) return { confirmado: 0 };

    const calendar = getCalendarClient();
    const { data } = await conReintentos(() => calendar.events.get({ calendarId, eventId }));
    const descripcion = data.description || '';
    if (tieneConfirmadoNo(descripcion) || yaConfirmado(descripcion)) return { confirmado: 0 };
    if (dryRun) return { confirmado: 1, dryRun: true };
    const nuevaDescripcion = escribirConfirmado(descripcion, true);
    await conReintentos(() => calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    }));
    await logActividad({
      tipo: 'turno_confirmado_automatico',
      detalle: `${data.summary || 'paciente'} — ${fechaISO} (movimiento en la ficha ese día)`,
      actor: 'automático',
    });
    return { confirmado: 1 };
  } catch (err) {
    console.warn('[confirmarTurnosPorMovimiento] confirmarTurnoPuntualSiMovimiento:', err?.message || err);
    return { confirmado: 0, error: err?.message };
  }
}
