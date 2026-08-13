// Hoja de configuración del panel /admin — se auto-crea la primera vez que hace falta,
// mismo patrón que getOrCreateMapeoSheetId() en api/gestion/pacientes.js. Vive en la
// misma carpeta de Pacientes y usa el mismo cliente OAuth (lib/googleOAuthPacientes.js)
// — no suma una cuenta/credencial nueva.
//
// Tres pestañas:
//   Config       — clave/valor genérico (col A clave, col B valor JSON). Guarda horarios,
//                  textos, listas desplegables y radios: un blob por recurso, no una fila
//                  por dato — alcanza y evita modelar 4 hojas distintas.
//   ActividadLog — feed cronológico simple (fecha, tipo, detalle, actor), append-only.
//   AlertasLog   — espejo de los emails de avisarFallo() (lib/alertas.js), para que
//                  "Monitoreo técnico" en /admin pueda mostrar el detalle sin ir al mail.
//
// IMPORTANTE (ver decisions.md / incidente 2026-08-12): esto se usa desde disponibilidad.js
// y reservar.js, en el camino más transitado de todo el sitio. Por eso getConfig() cachea
// en memoria del proceso (60s) y, ante CUALQUIER error leyendo la hoja, devuelve el default
// sin tirar — un problema en esta hoja nunca puede tumbar la disponibilidad de turnos.
import { getPacientesSheetsClient, getPacientesDriveClient } from './googleOAuthPacientes.js';
import { conReintentos } from './retry.js';
import { PACIENTES_FOLDER_ID } from './pacientesSheet.js';
import { WEEKLY_SCHEDULE, SLOT_MINUTES, SOBRETURNO_MINUTES } from './googleCalendar.js';

export const CONFIG_SHEET_NAME = 'Configuración del panel admin (no tocar)';
const TAB_CONFIG = 'Config';
const TAB_ACTIVIDAD = 'ActividadLog';
const TAB_ALERTAS = 'AlertasLog';

const TTL_MS = 60000;
let cacheSheetId = null;
const cacheValores = {}; // clave -> { valor, ts }

async function getOrCreateConfigSheetId() {
  if (cacheSheetId) return cacheSheetId;

  const drive = getPacientesDriveClient();

  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${CONFIG_SHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) {
    cacheSheetId = data.files[0].id;
    return cacheSheetId;
  }

  const sheets = getPacientesSheetsClient();
  const creada = await conReintentos(() => sheets.spreadsheets.create({
    requestBody: {
      properties: { title: CONFIG_SHEET_NAME },
      sheets: [
        { properties: { title: TAB_CONFIG } },
        { properties: { title: TAB_ACTIVIDAD } },
        { properties: { title: TAB_ALERTAS } },
      ],
    },
    fields: 'spreadsheetId',
  }));
  const id = creada.data.spreadsheetId;
  // Se cachea ACÁ, apenas se creó la hoja — si algo de lo que sigue (headers, mover
  // de carpeta) falla, no se pierde el id. Sin esto, un fallo parcial hacía que la
  // próxima llamada nunca encontrara esta hoja (no queda en PACIENTES_FOLDER_ID hasta
  // el addParents de abajo) y creara OTRA hoja nueva en cada intento — huérfanos
  // acumulándose en "Mi unidad" y ActividadLog/AlertasLog siempre vacíos porque nunca
  // se terminaba de escribir/leer la misma hoja dos veces seguidas.
  cacheSheetId = id;

  try {
    await conReintentos(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${TAB_CONFIG}!A1:C1`, values: [['clave', 'valor', 'actualizado']] },
          { range: `${TAB_ACTIVIDAD}!A1:D1`, values: [['fecha', 'tipo', 'detalle', 'actor']] },
          { range: `${TAB_ALERTAS}!A1:D1`, values: [['fecha', 'endpoint', 'detalle', 'mensaje']] },
        ],
      },
    }));
  } catch (err) {
    console.warn('[adminConfig] no se pudieron escribir los encabezados (no crítico):', err?.message || err);
  }
  try {
    await conReintentos(() => drive.files.update({ fileId: id, addParents: PACIENTES_FOLDER_ID, fields: 'id' }));
  } catch (err) {
    console.warn('[adminConfig] no se pudo mover la hoja a la carpeta de Pacientes (no crítico):', err?.message || err);
  }

  return id;
}

// Lee un valor de configuración con cache de 60s y fallback total ante error — nunca
// tira. `defaultValue` vuelve tal cual si la hoja no existe todavía, la clave no está
// guardada, o cualquier llamada a Sheets falla (transitorio o no).
export async function getConfig(clave, defaultValue) {
  const cacheada = cacheValores[clave];
  if (cacheada && Date.now() - cacheada.ts < TTL_MS) return cacheada.valor;

  try {
    const id = await getOrCreateConfigSheetId();
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_CONFIG}!A2:C` }));
    const fila = (data.values || []).find((r) => r[0] === clave);
    const valor = fila && fila[1] != null ? JSON.parse(fila[1]) : defaultValue;
    cacheValores[clave] = { valor, ts: Date.now() };
    return valor;
  } catch (err) {
    console.warn(`[adminConfig] no se pudo leer "${clave}", uso default:`, err?.message || err);
    return defaultValue;
  }
}

export async function setConfig(clave, valor) {
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_CONFIG}!A2:C` }));
  const filas = data.values || [];
  const idx = filas.findIndex((r) => r[0] === clave);
  const fila = [clave, JSON.stringify(valor), new Date().toISOString()];

  if (idx === -1) {
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${TAB_CONFIG}!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] },
    }));
  } else {
    const filaSheet = idx + 2;
    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${TAB_CONFIG}!A${filaSheet}:C${filaSheet}`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    }));
  }
  cacheValores[clave] = { valor, ts: Date.now() };
}

// Fire-and-forget: nunca tira, nunca bloquea a quien la llama. Se usa desde endpoints
// públicos y protegidos por igual (login, altas/bajas/cambios de turno).
export async function logActividad({ tipo, detalle = '', actor = '' }) {
  try {
    const id = await getOrCreateConfigSheetId();
    const sheets = getPacientesSheetsClient();
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${TAB_ACTIVIDAD}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[new Date().toISOString(), tipo, detalle, actor]] },
    }));
  } catch (err) {
    console.warn('[adminConfig] no se pudo registrar actividad:', err?.message || err);
  }
}

// Idem, llamada desde avisarFallo() (lib/alertas.js) además del mail.
export async function logAlerta({ endpoint, detalle = '', mensaje = '' }) {
  try {
    const id = await getOrCreateConfigSheetId();
    const sheets = getPacientesSheetsClient();
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${TAB_ALERTAS}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[new Date().toISOString(), endpoint, detalle, String(mensaje).slice(0, 500)]] },
    }));
  } catch (err) {
    console.warn('[adminConfig] no se pudo registrar alerta:', err?.message || err);
  }
}

// Único punto de lectura de horarios para todos los endpoints que calculan
// disponibilidad o crean turnos — default = lo de siempre (WEEKLY_SCHEDULE/
// SLOT_MINUTES/SOBRETURNO_MINUTES de lib/googleCalendar.js) si nunca se guardó nada
// desde /admin, o si la hoja de Config falla por lo que sea (ver getConfig).
export async function obtenerHorariosConfig() {
  const defaults = { schedule: WEEKLY_SCHEDULE, slotMinutes: SLOT_MINUTES, sobreturnoMinutes: SOBRETURNO_MINUTES };
  const guardado = await getConfig('horarios', null);
  if (!guardado) return defaults;
  return {
    schedule: guardado.schedule || defaults.schedule,
    slotMinutes: Number(guardado.slotMinutes) || defaults.slotMinutes,
    sobreturnoMinutes: Number(guardado.sobreturnoMinutes) || defaults.sobreturnoMinutes,
  };
}

export async function leerActividadReciente(limite = 100) {
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_ACTIVIDAD}!A2:D` }));
  return (data.values || [])
    .filter((r) => r[0])
    .map((r) => ({ fecha: r[0], tipo: r[1] || '', detalle: r[2] || '', actor: r[3] || '' }))
    .slice(-limite)
    .reverse();
}

export async function leerAlertasRecientes(limite = 50) {
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_ALERTAS}!A2:D` }));
  return (data.values || [])
    .filter((r) => r[0])
    .map((r) => ({ fecha: r[0], endpoint: r[1] || '', detalle: r[2] || '', mensaje: r[3] || '' }))
    .slice(-limite)
    .reverse();
}
