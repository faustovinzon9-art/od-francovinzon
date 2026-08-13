// Panel /admin — TODAS las secciones en un solo archivo a propósito, mismo motivo que
// api/gestion/pacientes.js: no pasarse del límite de 12 funciones serverless del plan
// Hobby (ver CLAUDE.md). Lecturas por GET con `recurso` (+ `modo` cuando hace falta),
// escrituras por POST con `recurso` + `accion`. Clave propia: ADMIN_KEY
// (lib/adminAuth.js), nunca GESTION_KEY — Ayelen no tiene acceso acá.
import { isValidAdminKey } from '../../lib/adminAuth.js';
import { isValidGestionKey } from '../../lib/googleCalendar.js';
import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, TIME_ZONE,
  pad2, toArgDate, eventBounds, formatArgDay, formatArgTime, extraerTelefono, extraerConfirmado,
  extraerEsNuevoPaciente, getHorariosLibresDia,
} from '../../lib/googleCalendar.js';
import { getPacientesDriveClient, getPacientesSheetsClient } from '../../lib/googleOAuthPacientes.js';
import {
  PACIENTES_FOLDER_ID, SHEET_NAME, parsearNombreArchivo,
} from '../../lib/pacientesSheet.js';
import { avisarFallo } from '../../lib/alertas.js';
import { conReintentos } from '../../lib/retry.js';
import {
  getConfig, setConfig, obtenerHorariosConfig, logActividad,
  leerActividadReciente, leerAlertasRecientes,
} from '../../lib/adminConfig.js';

// Config de solo-lectura que también necesita /pacientes y /gestion (listas
// desplegables, radios, plantilla de WhatsApp) — no son datos sensibles, así que
// además de ADMIN_KEY aceptan GESTION_KEY para leerlos (nunca para escribirlos: los
// POST de estos recursos siguen exigiendo ADMIN_KEY más abajo, ver `recurso` en POST).
const RECURSOS_LECTURA_COMPARTIDA = new Set(['listas', 'radios', 'textos']);

export default async function handler(req, res) {
  try {
    const key = req.method === 'GET' ? req.query.key : req.body.key;
    const recurso = req.method === 'GET' ? req.query.recurso : req.body.recurso;

    // login-log: registro de actividad ("quién entró a /gestion" del pedido, sección 7)
    // — cualquiera de las dos claves puede escribir ahí, no expone ni cambia nada.
    const esLoginLog = req.method === 'POST' && recurso === 'login-log';
    const autorizado = (req.method === 'GET' && RECURSOS_LECTURA_COMPARTIDA.has(recurso)) || esLoginLog
      ? isValidAdminKey(key) || isValidGestionKey(key)
      : isValidAdminKey(key);
    if (!autorizado) return res.status(401).json({ success: false, error: 'unauthorized' });

    if (esLoginLog) {
      await logActividad({ tipo: 'login', detalle: req.body.panel || '', actor: isValidAdminKey(key) ? 'admin' : 'gestión (Ayelen)' });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'GET') {
      if (recurso === 'horarios') return await getHorarios(req, res);
      if (recurso === 'textos') return await getTextos(req, res);
      if (recurso === 'listas') return await getListas(req, res);
      if (recurso === 'radios') return await getRadios(req, res);
      if (recurso === 'actividad') return await getActividad(req, res);
      if (recurso === 'monitoreo') return await getMonitoreo(req, res);
      if (recurso === 'metricas') return await getMetricas(req, res);
      if (recurso === 'export-financiero') return await exportFinancieroPdf(req, res);
      if (recurso === 'export-ficha') return await exportFichaPdf(req, res);
      if (recurso === 'export-pacientes-csv') return await exportPacientesCsv(req, res);
      if (recurso === 'export-turnos') return await exportTurnos(req, res);
      return res.status(400).json({ success: false, error: 'recurso inválido' });
    }

    if (req.method === 'POST') {
      if (recurso === 'horarios') return await postHorarios(req, res);
      if (recurso === 'textos') return await postTextos(req, res);
      if (recurso === 'listas') return await postListas(req, res);
      if (recurso === 'radios') return await postRadios(req, res);
      if (recurso === 'accesos') return await postAccesos(req, res);
      return res.status(400).json({ success: false, error: 'recurso inválido' });
    }

    res.status(405).json({ success: false, error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: `${req.method} ${req.query?.recurso || req.body?.recurso || ''}`, error: err });
    res.status(500).json({ success: false, error: 'Error inesperado.' });
  }
}

// ---------- 1. Horarios y agenda ----------

async function getHorarios(req, res) {
  const config = await obtenerHorariosConfig();
  const calendar = getCalendarClient();

  const desde = toArgDate(formatArgDay(new Date()), '00:00');
  const hasta = new Date(desde.getTime() + 120 * 24 * 60 * 60000);
  const { data } = await conReintentos(() => calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: desde.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: true,
    q: BLOCK_MARKER,
  }));
  const bloqueos = (data.items || [])
    .filter((ev) => (ev.description || '').includes(BLOCK_MARKER))
    .map((ev) => {
      const { start, end } = eventBounds(ev);
      const diaCompleto = !ev.start.dateTime;
      return {
        id: ev.id,
        motivo: ev.summary || '',
        diaCompleto,
        fecha: formatArgDay(start),
        horaInicio: diaCompleto ? null : formatArgTime(start),
        horaFin: diaCompleto ? null : formatArgTime(end),
      };
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  res.status(200).json({ ...config, bloqueos });
}

async function postHorarios(req, res) {
  const { accion } = req.body;
  const calendar = getCalendarClient();

  if (accion === 'guardar') {
    const { schedule, slotMinutes, sobreturnoMinutes } = req.body;
    if (!schedule || !slotMinutes || !sobreturnoMinutes) {
      return res.status(400).json({ success: false, message: 'Faltan datos del horario.' });
    }
    await setConfig('horarios', { schedule, slotMinutes: Number(slotMinutes), sobreturnoMinutes: Number(sobreturnoMinutes) });
    await logActividad({ tipo: 'config_horarios', detalle: 'Horarios/duración de turnos actualizados', actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  if (accion === 'bloquear-dia') {
    const { date, motivo } = req.body;
    await conReintentos(() => calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
        description: BLOCK_MARKER,
        start: { date },
        end: { date: nextDayStr(date) },
      },
    }));
    await logActividad({ tipo: 'dia_bloqueado', detalle: `${date}${motivo ? ` — ${motivo}` : ''}`, actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  if (accion === 'bloquear-horario') {
    const { date, horaInicio, horaFin, motivo } = req.body;
    const start = toArgDate(date, horaInicio);
    const end = toArgDate(date, horaFin);
    if (!(end > start)) return res.status(200).json({ success: false, message: 'La hora de fin tiene que ser posterior a la de inicio.' });
    await conReintentos(() => calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
        description: BLOCK_MARKER,
        start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      },
    }));
    await logActividad({ tipo: 'horario_bloqueado', detalle: `${date} ${horaInicio}-${horaFin}${motivo ? ` — ${motivo}` : ''}`, actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  if (accion === 'desbloquear') {
    const { eventId } = req.body;
    await conReintentos(() => calendar.events.delete({ calendarId: CALENDAR_ID, eventId }));
    await logActividad({ tipo: 'bloqueo_eliminado', detalle: eventId, actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  res.status(400).json({ success: false, message: 'Acción inválida.' });
}

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// ---------- 2. Textos y plantillas ----------

const TEXTOS_DEFAULT = {
  // Placeholders: {{saludo}} {{nombre}} {{cuando}} {{hora}} {{tipo}} {{link}}
  whatsappTemplate:
    '¡Hola, {{saludo}}!!! Te quería recordar el siguiente {{tipo}}:\n\n{{nombre}}\n{{cuando}} a las {{hora}}hs\n' +
    'Tocá este link para confirmarlo:\n{{link}}\n\nCualquier cosita que no puedas venir avisar. Te esperamos.',
  direccion: 'Ameghino 410, E3260 Concepción del Uruguay, Entre Ríos, Argentina',
  bienvenidaNuevoPaciente: '¡Bienvenido/a! Te esperamos con gusto en tu primera visita.',
};

async function getTextos(req, res) {
  const textos = await getConfig('textos', TEXTOS_DEFAULT);
  res.status(200).json(textos);
}

async function postTextos(req, res) {
  const { whatsappTemplate, direccion, bienvenidaNuevoPaciente } = req.body;
  const actual = await getConfig('textos', TEXTOS_DEFAULT);
  await setConfig('textos', {
    whatsappTemplate: whatsappTemplate ?? actual.whatsappTemplate,
    direccion: direccion ?? actual.direccion,
    bienvenidaNuevoPaciente: bienvenidaNuevoPaciente ?? actual.bienvenidaNuevoPaciente,
  });
  await logActividad({ tipo: 'config_textos', detalle: 'Textos/plantilla de WhatsApp actualizados', actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 3. Listas desplegables ----------

const LISTAS_DEFAULT = {
  obrasSociales: ['Particular'],
  planes: ['Particular'],
  tratamientos: [
    'Escaneo 3D', 'Ortodoncia', 'Blanqueamiento dental', 'Odontopediatría',
    'Endodoncia mecanizada', 'Reconstrucciones estéticas', 'Carillas dentales',
    'Implantes', 'Limpieza dental', 'Urgencias',
  ],
};

async function getListas(req, res) {
  const listas = await getConfig('listas', LISTAS_DEFAULT);
  res.status(200).json(listas);
}

async function postListas(req, res) {
  const { obrasSociales, planes, tratamientos } = req.body;
  const actual = await getConfig('listas', LISTAS_DEFAULT);
  await setConfig('listas', {
    obrasSociales: Array.isArray(obrasSociales) ? obrasSociales : actual.obrasSociales,
    planes: Array.isArray(planes) ? planes : actual.planes,
    tratamientos: Array.isArray(tratamientos) ? tratamientos : actual.tratamientos,
  });
  await logActividad({ tipo: 'config_listas', detalle: 'Listas desplegables actualizadas', actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 4. Radios ----------

const RADIOS_DEFAULT = {
  estaciones: [
    { nombre: 'Radio Mitre', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/AM790_56AAC.aac' },
    { nombre: 'La 100', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/FM999_56.mp3' },
    { nombre: 'Aspen', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ASPENAAC.aac' },
    { nombre: 'Radio Rivadavia', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RIVADAVIA.mp3' },
    { nombre: 'Jazz 24hs — Blackie FM', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/BLACKIE_89_1.mp3' },
  ],
};

async function getRadios(req, res) {
  const radios = await getConfig('radios', RADIOS_DEFAULT);
  res.status(200).json(radios);
}

async function postRadios(req, res) {
  const { estaciones } = req.body;
  if (!Array.isArray(estaciones)) return res.status(400).json({ success: false, message: 'Lista de estaciones inválida.' });
  await setConfig('radios', { estaciones });
  await logActividad({ tipo: 'config_radios', detalle: `${estaciones.length} estaciones`, actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 6. Accesos: rotar GESTION_KEY vía API de Vercel ----------
// Requiere VERCEL_API_TOKEN (Vercel → Account Settings → Tokens, scope del proyecto),
// nueva variable de entorno que hay que agregar a mano UNA vez — no hay forma de que
// el propio sitio se la genere sola. process.env.VERCEL_PROJECT_ID lo agrega Vercel
// automáticamente a todo deployment, no hace falta configurarlo.
async function postAccesos(req, res) {
  const { accion, nuevaClave } = req.body;
  if (accion !== 'rotar-gestion-key') return res.status(400).json({ success: false, message: 'Acción inválida.' });
  if (!nuevaClave || nuevaClave.trim().length < 6) {
    return res.status(200).json({ success: false, message: 'La nueva clave tiene que tener al menos 6 caracteres.' });
  }

  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    return res.status(200).json({
      success: false,
      message: 'Falta configurar VERCEL_API_TOKEN en Vercel (Account Settings → Tokens) para poder cambiar la clave desde acá. Mientras tanto, cambiala a mano en Vercel → Settings → Environment Variables → GESTION_KEY.',
    });
  }

  try {
    const listResp = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = await listResp.json();
    if (!listResp.ok) throw new Error(listData?.error?.message || 'No se pudo leer las variables de entorno.');

    const existentes = (listData.envs || []).filter((e) => e.key === 'GESTION_KEY');
    if (!existentes.length) {
      return res.status(200).json({ success: false, message: 'No se encontró GESTION_KEY en Vercel. Creala primero a mano una vez.' });
    }

    for (const env of existentes) {
      const updResp = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env/${env.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: nuevaClave.trim() }),
      });
      if (!updResp.ok) {
        const updData = await updResp.json().catch(() => ({}));
        throw new Error(updData?.error?.message || 'No se pudo actualizar GESTION_KEY.');
      }
    }

    await logActividad({ tipo: 'clave_gestion_rotada', detalle: 'GESTION_KEY cambiada desde /admin', actor: 'admin' });

    const redeploy = await intentarRedeploy(token, projectId);

    res.status(200).json({
      success: true,
      message: redeploy.ok
        ? 'Clave actualizada. Se disparó un redeploy — en 1-2 minutos ya queda en producción.'
        : `Clave actualizada en Vercel, pero no se pudo disparar el redeploy automático (${redeploy.error}). Entrá a Vercel → Deployments y tocá "Redeploy" en el último deploy de producción para que tome efecto.`,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: 'rotar-gestion-key', error: err });
    res.status(200).json({ success: false, message: `No se pudo cambiar la clave: ${err.message}` });
  }
}

// Un cambio de env var por API no se aplica solo — Vercel necesita un deploy nuevo
// (mismo criterio que un cambio a mano en el dashboard). Se busca el último
// deployment READY de producción y se vuelve a desplegar tal cual (mismo código,
// variables de entorno ya actualizadas). Nunca hace fallar la respuesta principal —
// la clave YA quedó cambiada en Vercel aunque esto falle, ver postAccesos().
async function intentarRedeploy(token, projectId) {
  try {
    const listResp = await fetch(
      `https://api.vercel.com/v7/deployments?projectId=${projectId}&target=production&state=READY&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listResp.json();
    if (!listResp.ok) throw new Error(listData?.error?.message || 'No se pudo buscar el último deploy.');
    const ultimo = (listData.deployments || [])[0];
    if (!ultimo) throw new Error('No se encontró ningún deploy de producción.');

    const redeployResp = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ultimo.name, project: projectId, deploymentId: ultimo.uid, target: 'production' }),
    });
    const redeployData = await redeployResp.json();
    if (!redeployResp.ok) throw new Error(redeployData?.error?.message || 'No se pudo disparar el redeploy.');

    return { ok: true };
  } catch (err) {
    console.warn('[admin.js] no se pudo redesplegar automáticamente:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------- 7. Registro de actividad ----------

async function getActividad(req, res) {
  const eventos = await leerActividadReciente(200);
  res.status(200).json({ eventos });
}

// ---------- 8. Monitoreo técnico ----------

async function getMonitoreo(req, res) {
  const resultados = {};

  try {
    const calendar = getCalendarClient();
    await getHorariosLibresDia(calendar, formatArgDay(new Date()));
    resultados.calendar = 'ok';
  } catch (err) {
    resultados.calendar = 'error';
    resultados.calendarError = err?.message || String(err);
  }

  try {
    const drive = getPacientesDriveClient();
    await conReintentos(() => drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    }));
    resultados.pacientes = 'ok';
  } catch (err) {
    resultados.pacientes = 'error';
    resultados.pacientesError = err?.message || String(err);
  }

  resultados.resendConfigurado = !!process.env.RESEND_API_KEY;
  resultados.alertasRecientes = await leerAlertasRecientes(15);
  resultados.ok = resultados.calendar === 'ok' && resultados.pacientes === 'ok';

  res.status(200).json(resultados);
}

// ---------- 9. Dashboard de métricas ----------
// Todo calculado en vivo desde Calendar (rango pedido) — sin caché ni tabla propia,
// "con los datos que ya existen" (ver el pedido). Cancelaciones/reprogramaciones no
// tienen historial retroactivo (Calendar no guarda turnos borrados) — esas dos métricas
// se alimentan desde ahora en adelante vía ActividadLog (lib/adminConfig.js).
//
// El rango mira `dias` para atrás Y 60 días para adelante (no solo hacia atrás):
// este es un sistema de reserva de turnos, así que en cualquier momento buena parte
// (a veces casi toda, en un sitio recién lanzado) de la actividad real vive en turnos
// ya cargados para fechas futuras, no en el pasado. Un rango solo retroactivo dejaba
// el dashboard vacío incluso con turnos reales cargados. `DIAS_FUTURO_FIJO` no es
// configurable desde la UI a propósito, para no sumar otro control — 60 días cubre el
// horizonte típico de reserva de este consultorio.
const DIAS_FUTURO_FIJO = 60;
async function getMetricas(req, res) {
  const dias = Math.min(Number(req.query.dias) || 30, 90);
  const calendar = getCalendarClient();
  const desde = new Date(Date.now() - dias * 24 * 60 * 60000);
  const hasta = new Date(Date.now() + DIAS_FUTURO_FIJO * 24 * 60 * 60000);

  const [principal, sobreturnos] = await Promise.all([
    conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 2500 })),
    conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 2500 })),
  ]);

  const eventos = [
    ...(principal.data.items || []).map((ev) => ({ ev, tipo: 'turno' })),
    ...(sobreturnos.data.items || []).map((ev) => ({ ev, tipo: 'sobreturno' })),
  ].filter(({ ev }) => !(ev.description || '').includes(BLOCK_MARKER));

  const porDia = {};
  let online = 0, cargadoAyelen = 0, confirmados = 0, nuevos = 0, recurrentes = 0;

  eventos.forEach(({ ev }) => {
    const { start } = eventBounds(ev);
    const dia = formatArgDay(start);
    porDia[dia] = (porDia[dia] || 0) + 1;

    const desc = ev.description || '';
    if (desc.includes('Cargado manualmente desde el panel de gestión')) cargadoAyelen++;
    else online++;

    if (extraerConfirmado(desc)) confirmados++;
    if (extraerEsNuevoPaciente(desc)) nuevos++; else recurrentes++;
  });

  const total = eventos.length || 1;

  // Deuda: recorre las fichas de Pacientes leyendo el saldo — hoja liviana (unas pocas
  // celdas por ficha), pero son N llamadas a Sheets. Se acota a 200 fichas y se
  // consulta en lotes chicos secuenciales (mismo criterio que el resto del proyecto
  // con la cuota de Google, ver CLAUDE.md) para no disparar todo junto.
  let conDeuda = 0, totalPacientesConSaldo = 0;
  const topDeudoresMonto = [];
  const topDeudoresAntiguedad = [];
  try {
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 250,
    }));
    const archivos = (data.files || []).filter((f) => !/^⭐/.test(f.name)).slice(0, 200);

    const LOTE = 20;
    for (let i = 0; i < archivos.length; i += LOTE) {
      const lote = archivos.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const { data: fin } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: f.id, range: `${SHEET_NAME}!E6:F11` }));
          const rows = fin.values || [];
          const saldoTexto = rows[2]?.[1] || '$0,00';
          const diasSinPagoTexto = rows[5]?.[1] || '';
          const saldoNum = parseFloat(String(saldoTexto).replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
          const diasNum = parseInt(String(diasSinPagoTexto).replace(/\D/g, ''), 10) || 0;
          const { nombre, apellido } = parsearNombreArchivo(f.name);
          return { nombre: `${nombre} ${apellido}`.trim(), saldo: saldoNum, dias: diasNum };
        } catch {
          return null;
        }
      }));
      resultados.filter(Boolean).forEach((r) => {
        totalPacientesConSaldo++;
        if (r.saldo > 0) {
          conDeuda++;
          topDeudoresMonto.push(r);
          if (r.dias > 0) topDeudoresAntiguedad.push(r);
        }
      });
    }
  } catch (err) {
    console.warn('[admin.js] no se pudo calcular deuda de pacientes:', err?.message || err);
  }

  topDeudoresMonto.sort((a, b) => b.saldo - a.saldo);
  topDeudoresAntiguedad.sort((a, b) => b.dias - a.dias);

  // Cancelados/reprogramados: Calendar no guarda turnos borrados, así que no hay
  // forma de calcularlos en vivo como confirmados/nuevos — se cuentan desde
  // ActividadLog (ver lib/adminConfig.js), que solo tiene datos desde que se agregó
  // este logging (2026-08-13 en adelante). Se muestran como cantidad, no %: no hay un
  // denominador común honesto entre "turnos vigentes ahora en Calendar" (arriba) y
  // "eventos de cancelación ya registrados en el log" (acá).
  let cancelados = 0, reprogramados = 0;
  try {
    const actividad = await leerActividadReciente(500);
    actividad.forEach((ev) => {
      const fechaEv = new Date(ev.fecha);
      if (fechaEv < desde || fechaEv > hasta) return;
      if (ev.tipo === 'turno_cancelado') cancelados++;
      else if (ev.tipo === 'turno_reprogramado') reprogramados++;
    });
  } catch (err) {
    console.warn('[admin.js] no se pudo leer cancelados/reprogramados:', err?.message || err);
  }

  res.status(200).json({
    rangoDias: dias,
    volumenPorDia: Object.entries(porDia).sort(([a], [b]) => a.localeCompare(b)).map(([fecha, cantidad]) => ({ fecha, cantidad })),
    porcentajeOnline: Math.round((online / total) * 100),
    porcentajeCargadoAyelen: Math.round((cargadoAyelen / total) * 100),
    porcentajeConfirmados: Math.round((confirmados / total) * 100),
    porcentajeNuevos: Math.round((nuevos / total) * 100),
    porcentajeRecurrentes: Math.round((recurrentes / total) * 100),
    totalTurnos: eventos.length,
    cancelados,
    reprogramados,
    porcentajeConDeuda: totalPacientesConSaldo ? Math.round((conDeuda / totalPacientesConSaldo) * 100) : null,
    topDeudoresMonto: topDeudoresMonto.slice(0, 10),
    topDeudoresAntiguedad: topDeudoresAntiguedad.slice(0, 10),
  });
}

// ---------- 5. Exportaciones ----------

async function exportPacientesCsv(req, res) {
  const drive = getPacientesDriveClient();
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  }));
  const archivos = (data.files || []).filter((f) => !/^⭐/.test(f.name));
  const filas = archivos
    .map((f) => {
      const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
      return [nombre, apellido, dni];
    })
    .sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`, 'es'));

  const csv = ['Nombre,Apellido,DNI', ...filas.map((f) => f.map(csvEscape).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pacientes.csv"');
  res.status(200).send('﻿' + csv);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportTurnos(req, res) {
  const { desde, hasta, formato } = req.query;
  const calendar = getCalendarClient();
  const timeMin = toArgDate(desde, '00:00').toISOString();
  const timeMax = new Date(toArgDate(hasta, '00:00').getTime() + 24 * 60 * 60000).toISOString();

  const [principal, sobreturnos] = await Promise.all([
    conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, maxResults: 2500 })),
    conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin, timeMax, singleEvents: true, maxResults: 2500 })),
  ]);

  const filas = [
    ...(principal.data.items || []).map((ev) => ({ ev, tipo: 'Turno' })),
    ...(sobreturnos.data.items || []).map((ev) => ({ ev, tipo: 'Sobreturno' })),
  ]
    .filter(({ ev }) => !(ev.description || '').includes(BLOCK_MARKER))
    .map(({ ev, tipo }) => {
      const { start } = eventBounds(ev);
      return {
        fecha: formatArgDay(start),
        hora: formatArgTime(start),
        paciente: ev.summary || '',
        tipo,
        telefono: extraerTelefono(ev.description),
        confirmado: extraerConfirmado(ev.description) ? 'Sí' : 'No',
      };
    })
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));

  if (formato === 'pdf') {
    const { generarPdfTabla } = await import('../../lib/pdfExport.js');
    const buffer = await generarPdfTabla({
      titulo: `Turnos ${desde} a ${hasta}`,
      columnas: ['Fecha', 'Hora', 'Paciente', 'Tipo', 'Teléfono', 'Confirmado'],
      filas: filas.map((f) => [f.fecha, f.hora, f.paciente, f.tipo, f.telefono, f.confirmado]),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="turnos_${desde}_${hasta}.pdf"`);
    return res.status(200).send(buffer);
  }

  const csv = [
    'Fecha,Hora,Paciente,Tipo,Teléfono,Confirmado',
    ...filas.map((f) => [f.fecha, f.hora, f.paciente, f.tipo, f.telefono, f.confirmado].map(csvEscape).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="turnos_${desde}_${hasta}.csv"`);
  res.status(200).send('﻿' + csv);
}

// Ficha completa (datos + movimientos + prestaciones) en PDF.
async function exportFichaPdf(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ success: false, message: 'Falta id.' });

  const sheets = getPacientesSheetsClient();
  const [campos, financiero, movRaw] = await Promise.all([
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C15` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!E6:F11` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!B18:H2000` })),
  ]);

  const c = (campos.data.values || []).map((r) => r[0] || '');
  const [nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento] = c;
  const f = financiero.data.values || [];
  const movimientos = (movRaw.data.values || [])
    .map((row) => ({ fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '', saldo: row[4] || '', formaPago: row[6] || '' }))
    .filter((m) => m.fecha || m.tratamiento);

  const { generarPdfFicha } = await import('../../lib/pdfExport.js');
  const buffer = await generarPdfFicha({
    campos: { nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento },
    financiero: { total: f[0]?.[1] || '$0,00', pagado: f[1]?.[1] || '$0,00', saldo: f[2]?.[1] || '$0,00' },
    movimientos,
    mostrarFormaPago: true,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}_${apellido}_ficha.pdf"`);
  res.status(200).send(buffer);
}

// Estado de cuenta SIN método de pago — para cuando un paciente reclama que ya pagó
// (ver el pedido, sección 5): fecha, tratamiento, debe, haber, saldo nada más.
async function exportFinancieroPdf(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ success: false, message: 'Falta id.' });

  const sheets = getPacientesSheetsClient();
  const [campos, movRaw] = await Promise.all([
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C6` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!B18:F2000` })),
  ]);
  const [nombre, apellido] = (campos.data.values || []).map((r) => r[0] || '');
  const movimientos = (movRaw.data.values || [])
    .map((row) => ({ fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '', saldo: row[4] || '' }))
    .filter((m) => m.fecha || m.tratamiento);

  const { generarPdfFicha } = await import('../../lib/pdfExport.js');
  const buffer = await generarPdfFicha({
    campos: { nombre, apellido },
    movimientos,
    mostrarFormaPago: false,
    soloFinanciero: true,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}_${apellido}_estado_cuenta.pdf"`);
  res.status(200).send(buffer);
}
