// Planilla "Pacientes consolidados" (ver el pedido, 2026-08-14) — fuente única de verdad
// para dos cosas que antes escaneaban Calendar/Drive por separado en cada request (poco
// confiable y lento): el autocompletado de nombre->teléfono/DNI de /gestion, y la sección
// "Pacientes en total" del panel /admin. Vive en PACIENTES_FOLDER_ID, mismo patrón de
// auto-provisión que la hoja de mapeo teléfono-ficha (ver api/gestion/pacientes.js).
//
// Una fila por persona, clave = teléfono normalizado (últimos 10 dígitos, mismo criterio
// de matching ya establecido en el proyecto — ver normalizarTelefonoMapeo). Si una fila
// tiene fichaId, esos datos (nombre/apellido/dni) SIEMPRE ganan sobre lo que traiga un
// turno para ese mismo teléfono — la ficha es la fuente más confiable.
//
// Se mantiene al día con escrituras puntuales (upsertPacienteConsolidado), no con un
// escaneo completo periódico — se llama desde cada lugar que crea/edita una ficha o un
// turno con nombre/teléfono/DNI (crearPaciente, escribirCampoEnSheet, crear-turno.js,
// agregar-telefono.js, agregar-dni.js, evento.js al mover con nombre nuevo). Todas esas
// llamadas son best-effort: si la planilla falla, nunca tira ni bloquea el flujo
// principal (crear el turno, guardar la ficha) — ver el catch de acá abajo.
import { getPacientesSheetsClient, getPacientesDriveClient } from './googleOAuthPacientes.js';
import { conReintentos } from './retry.js';
import { PACIENTES_FOLDER_ID, normalizarTelefonoMapeo } from './pacientesSheet.js';

export const PACIENTES_CONSOLIDADOS_NAME = 'Pacientes consolidados (no tocar)';
const RANGO_DATOS = 'A2:G';

let cacheSheetId = null;
async function getOrCreateConsolidadosSheetId() {
  if (cacheSheetId) return cacheSheetId;
  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${PACIENTES_CONSOLIDADOS_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) {
    cacheSheetId = data.files[0].id;
    return cacheSheetId;
  }
  const creada = await conReintentos(() => sheets.spreadsheets.create({
    requestBody: { properties: { title: PACIENTES_CONSOLIDADOS_NAME } },
    fields: 'spreadsheetId',
  }));
  const id = creada.data.spreadsheetId;
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: 'A1:G1',
    valueInputOption: 'RAW',
    requestBody: { values: [['telefono', 'nombre', 'apellido', 'dni', 'fichaId', 'origen', 'actualizado']] },
  }));
  // Recién creada vive en "Mi unidad" — se mueve a la carpeta de Pacientes para que
  // quede junto a todo lo demás (mismo criterio que getOrCreateMapeoSheetId).
  await conReintentos(() => drive.files.update({ fileId: id, addParents: PACIENTES_FOLDER_ID, fields: 'id' }));
  cacheSheetId = id;
  return id;
}

function filaDesdeValores(r, i) {
  return {
    fila: i + 2,
    telefono: r[0] || '', nombre: r[1] || '', apellido: r[2] || '', dni: r[3] || '',
    fichaId: r[4] || '', origen: r[5] || '', actualizado: r[6] || '',
  };
}

async function leerFilas(sheets, sheetId) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: RANGO_DATOS }));
  return (data.values || []).filter((r) => r[0]).map(filaDesdeValores);
}

function normalizarNombreConsolidado(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Best-effort a propósito: nunca tira. `telefono` es la clave — sin teléfono no hay con
// qué matchear, y la fila directamente no se escribe (no tiene sentido guardar un
// registro que después no se puede volver a encontrar).
export async function upsertPacienteConsolidado({ telefono, nombre, apellido, dni, fichaId, origen }) {
  const telNorm = normalizarTelefonoMapeo(telefono);
  if (!telNorm) return;

  try {
    const sheetId = await getOrCreateConsolidadosSheetId();
    const sheets = getPacientesSheetsClient();
    const filas = await leerFilas(sheets, sheetId);
    const existente = filas.find((f) => normalizarTelefonoMapeo(f.telefono) === telNorm);
    const ahora = new Date().toISOString();

    if (!existente) {
      await conReintentos(() => sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'A:G',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[telefono, nombre || '', apellido || '', dni || '', fichaId || '', origen || 'turno', ahora]] },
      }));
      return;
    }

    // Si la fila existente ya tiene ficha y esta llamada no trae una (viene de un turno),
    // la ficha gana — solo se completan huecos, nunca se pisa un dato real de la ficha.
    const esFichaGanadora = existente.fichaId && !fichaId;
    const nombreFinal = esFichaGanadora ? (existente.nombre || nombre) : (nombre || existente.nombre);
    const apellidoFinal = esFichaGanadora ? (existente.apellido || apellido) : (apellido || existente.apellido);
    const dniFinal = esFichaGanadora ? (existente.dni || dni) : (dni || existente.dni);
    const fichaIdFinal = fichaId || existente.fichaId;
    const telefonoFinal = esFichaGanadora ? (existente.telefono || telefono) : (telefono || existente.telefono);

    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `A${existente.fila}:G${existente.fila}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[telefonoFinal, nombreFinal, apellidoFinal, dniFinal, fichaIdFinal, fichaIdFinal ? 'ficha' : (existente.origen || 'turno'), ahora]] },
    }));
  } catch (err) {
    console.warn('[pacientesConsolidados] no se pudo sincronizar la planilla consolidada:', err?.message || err);
  }
}

// Autocompletado de /gestion (ver el pedido) — sustituye el escaneo de turnos por
// nombre en Calendar, que fallaba cuando el nombre del turno no coincidía exacto con el
// de la ficha o cuando el paciente no tenía ningún turno reciente con teléfono cargado.
// Coincidencia por substring, igual que antes; ante varios candidatos, gana el que tiene
// ficha y, a igualdad, el más recientemente actualizado.
export async function buscarPacienteConsolidadoPorNombre(nombreBuscado) {
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  const filas = await leerFilas(sheets, sheetId);
  const normalizado = normalizarNombreConsolidado(nombreBuscado);
  if (!normalizado) return null;

  const candidatos = filas.filter((f) => normalizarNombreConsolidado(`${f.nombre} ${f.apellido}`).includes(normalizado));
  candidatos.sort((a, b) => {
    const porFicha = (b.fichaId ? 1 : 0) - (a.fichaId ? 1 : 0);
    if (porFicha !== 0) return porFicha;
    return new Date(b.actualizado || 0) - new Date(a.actualizado || 0);
  });
  return candidatos[0] || null;
}

// Base de "Pacientes en total" del dashboard de /admin — ver el pedido.
export async function listarPacientesConsolidados() {
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  return leerFilas(sheets, sheetId);
}
