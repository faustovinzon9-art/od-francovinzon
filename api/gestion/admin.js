// Panel /admin — TODAS las secciones en un solo archivo a propósito, mismo motivo que
// api/gestion/pacientes.js: no pasarse del límite de 12 funciones serverless del plan
// Hobby (ver CLAUDE.md). Lecturas por GET con `recurso` (+ `modo` cuando hace falta),
// escrituras por POST con `recurso` + `accion`. Clave propia: ADMIN_KEY
// (lib/adminAuth.js), nunca GESTION_KEY — Ayelen no tiene acceso acá.
import { isValidAdminKey } from '../../lib/adminAuth.js';
import { isValidGestionKey } from '../../lib/googleCalendar.js';
import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, TIME_ZONE, WEEKLY_SCHEDULE,
  SLOT_MINUTES, pad2, toArgDate, eventBounds, formatArgDay, formatArgTime, extraerTelefono, extraerConfirmado,
  extraerEsNuevoPaciente, getHorariosLibresDia,
} from '../../lib/googleCalendar.js';
import { getPacientesDriveClient, getPacientesSheetsClient } from '../../lib/googleOAuthPacientes.js';
import {
  PACIENTES_FOLDER_ID, SHEET_NAME, parsearNombreArchivo, rangoMovimientos,
} from '../../lib/pacientesSheet.js';
import { avisarFallo } from '../../lib/alertas.js';
import { conReintentos } from '../../lib/retry.js';
import {
  getConfig, setConfig, obtenerHorariosConfig, obtenerReservaOnlinePausada, logActividad,
  leerActividadReciente, leerAlertasRecientes,
} from '../../lib/adminConfig.js';
import { listarPacientesConsolidados } from '../../lib/pacientesConsolidados.js';

// Config de solo-lectura que también necesita /pacientes y /gestion (listas
// desplegables, radios, plantilla de WhatsApp) — no son datos sensibles, así que
// además de ADMIN_KEY aceptan GESTION_KEY para leerlos (nunca para escribirlos: los
// POST de estos recursos siguen exigiendo ADMIN_KEY más abajo, ver `recurso` en POST).
const RECURSOS_LECTURA_COMPARTIDA = new Set(['listas', 'radios', 'textos']);

async function conError(fn, req, res) {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: req.query?.recurso || '', error: err });
    if (!res.headersSent) res.status(200).json({ success: false, error: err?.message || String(err) });
  }
}

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
      if (recurso === 'reserva-online') return await getReservaOnline(req, res);
      if (recurso === 'textos') return await getTextos(req, res);
      if (recurso === 'listas') return await getListas(req, res);
      if (recurso === 'radios') return await getRadios(req, res);
      if (recurso === 'actividad') return await getActividad(req, res);
      if (recurso === 'monitoreo') return await getMonitoreo(req, res);
      if (recurso === 'metricas') return await getMetricas(req, res);
      if (recurso === 'metricas-avanzadas') return await getMetricasAvanzadas(req, res);
      // Los export-* devuelven un archivo (PDF/CSV), no JSON — si algo dentro tira,
      // el catch de más abajo los mandaría igual por el camino genérico de
      // "Error inesperado." sin ninguna pista. Acá sí se envuelve cada uno para
      // devolver el mensaje real (encontrado en producción, 2026-08-13: un fallo en
      // exportFichaPdf era indistinguible de cualquier otro error del panel).
      if (recurso === 'export-financiero') return await conError(exportFinancieroPdf, req, res);
      if (recurso === 'export-ficha') return await conError(exportFichaPdf, req, res);
      if (recurso === 'export-pacientes-csv') return await conError(exportPacientesCsv, req, res);
      if (recurso === 'export-turnos') return await conError(exportTurnos, req, res);
      return res.status(400).json({ success: false, error: 'recurso inválido' });
    }

    if (req.method === 'POST') {
      if (recurso === 'horarios') return await postHorarios(req, res);
      if (recurso === 'reserva-online') return await postReservaOnline(req, res);
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

// ---------- 1.5 Interruptor de reserva online ----------
// Default = pausada desde el arranque (obtenerReservaOnlinePausada, lib/adminConfig.js)
// — no es una demo, es la configuración real desde el día uno. Mientras esté pausada,
// /turnos y la home dejan de mostrar el flujo de reserva online y muestran un cartel de
// WhatsApp en su lugar (ver api/disponibilidad.js?modo=estado, que es de donde esas
// páginas públicas leen este mismo valor sin necesitar ninguna clave). /gestion no se
// ve afectado: Ayelen y Franco siguen cargando turnos a mano sin restricción nueva.
async function getReservaOnline(req, res) {
  const pausada = await obtenerReservaOnlinePausada();
  res.status(200).json({ pausada });
}

async function postReservaOnline(req, res) {
  const { pausada } = req.body;
  await setConfig('reservaOnlinePausada', !!pausada);
  await logActividad({ tipo: 'config_reserva_online', detalle: pausada ? 'Reserva online pausada' : 'Reserva online activada', actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 2. Textos y plantillas ----------

const TEXTOS_DEFAULT = {
  // Placeholders: {{saludo}} {{nombre}} {{cuando}} {{hora}} {{tipo}} — sin {{link}}
  // desde 2026-08-14: la confirmación pasó a ser escrita (el paciente responde por el
  // chat), no por un link.
  whatsappTemplate:
    '¡Hola, {{saludo}}!!! Te quería recordar el siguiente {{tipo}}:\n\n{{nombre}}\n{{cuando}} a las {{hora}}hs\n\n' +
    'Confirmame por acá que vas a poder venir. Cualquier cosita que no puedas, avisanos. Te esperamos.',
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
  try {
    const eventos = await leerActividadReciente(200);
    res.status(200).json({ eventos });
  } catch (err) {
    console.error(err);
    res.status(200).json({ eventos: [], error: err?.message || String(err) });
  }
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
  try {
    resultados.alertasRecientes = await leerAlertasRecientes(15);
  } catch (err) {
    resultados.alertasRecientes = [];
    resultados.alertasError = err?.message || String(err);
  }
  resultados.ok = resultados.calendar === 'ok' && resultados.pacientes === 'ok';

  res.status(200).json(resultados);
}

// ---------- 9. Dashboard de métricas ----------
// Todo calculado en vivo desde Calendar (rango pedido) — sin caché ni tabla propia,
// "con los datos que ya existen" (ver el pedido). Cancelaciones/reprogramaciones no
// tienen historial retroactivo (Calendar no guarda turnos borrados) — esas dos métricas
// se alimentan desde ahora en adelante vía ActividadLog (lib/adminConfig.js).
//
// Formato argentino: "$" opcional, "." como separador de miles, "," como decimal
// (ej. "$900.000,00" = 900000). parseFloat solo no alcanza — hay que sacar los
// puntos de miles ANTES de convertir la coma decimal a punto, si no
// "900.000,00" -> "900.000.00" -> parseFloat corta en el segundo punto y da 900
// en vez de 900000 (bug real, encontrado en el dashboard el 2026-08-13).
function parsearMontoArgentino(texto) {
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '');
  const sinMiles = limpio.replace(/\./g, '');
  return parseFloat(sinMiles.replace(',', '.')) || 0;
}

// El rango mira `dias` para atrás Y 60 días para adelante (no solo hacia atrás):
// este es un sistema de reserva de turnos, así que en cualquier momento buena parte
// (a veces casi toda, en un sitio recién lanzado) de la actividad real vive en turnos
// ya cargados para fechas futuras, no en el pasado. Un rango solo retroactivo dejaba
// el dashboard vacío incluso con turnos reales cargados. `DIAS_FUTURO_FIJO` no es
// configurable desde la UI a propósito, para no sumar otro control — 60 días cubre el
// horizonte típico de reserva de este consultorio.
const DIAS_FUTURO_FIJO = 60;
// Turnos/sobreturnos del rango + agregados simples (online vs Ayelen, confirmados,
// nuevos vs recurrentes) — independiente de deuda/actividad, se corre en paralelo
// con esas dos (ver getMetricas). Antes corría todo en serie: con muchos pacientes,
// la suma de Calendar + deuda + actividad pasaba largo el límite de 10s de las
// funciones serverless en el plan Hobby y el dashboard quedaba colgado sin ningún
// error visible (encontrado en producción, 2026-08-13). `maxDuration: 60` en
// vercel.json para este archivo da margen extra además de la paralelización.
async function calcularTurnos(desde, hasta) {
  const calendar = getCalendarClient();
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
  return { eventos, porDia, online, cargadoAyelen, confirmados, nuevos, recurrentes, total };
}

// Deuda: recorre las fichas de Pacientes leyendo el saldo — hoja liviana (unas pocas
// celdas por ficha), pero son N llamadas a Sheets. Se acota a 200 fichas y se
// consulta en lotes secuenciales (mismo criterio que el resto del proyecto con la
// cuota de Google, ver CLAUDE.md) para no disparar todo junto. Con muchos pacientes
// esto es lo más lento de todo el dashboard con diferencia — se cachea en memoria
// del proceso 2 minutos para que recargar el dashboard varias veces seguidas (como
// al estar probándolo) no vuelva a escanear todas las fichas cada vez.
let cacheDeuda = null; // { valor, ts }
const TTL_DEUDA_MS = 120000;
async function calcularDeuda(forzar) {
  if (!forzar && cacheDeuda && Date.now() - cacheDeuda.ts < TTL_DEUDA_MS) return cacheDeuda.valor;

  let conDeuda = 0, totalPacientesConSaldo = 0, fallidos = 0;
  const topDeudoresMonto = [];
  const topDeudoresAntiguedad = [];
  try {
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();

    // Paginado completo — con `pageSize` solo (sin seguir `nextPageToken`) se corta
    // en la primera página y cualquier ficha más allá de esa página queda afuera del
    // cálculo entero, en silencio (bug real sospechado en producción, 2026-08-13: "no
    // se están tomando valores más altos"). PACIENTES_FOLDER_ID no debería tener miles
    // de archivos, pero no hay motivo para asumir un tope arbitrario acá.
    let archivos = [];
    let pageToken;
    do {
      const { data } = await conReintentos(() => drive.files.list({
        q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id, name), nextPageToken',
        pageSize: 250,
        pageToken,
      }));
      archivos = archivos.concat(data.files || []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    archivos = archivos.filter((f) => !/^⭐/.test(f.name));

    const LOTE = 25;
    for (let i = 0; i < archivos.length; i += LOTE) {
      const lote = archivos.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const { data: fin } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: f.id, range: `${SHEET_NAME}!E6:F11` }));
          const rows = fin.values || [];
          const saldoTexto = rows[2]?.[1] || '$0,00';
          const diasSinPagoTexto = rows[5]?.[1] || '';
          const saldoNum = parsearMontoArgentino(saldoTexto);
          // La celda de "días sin pago" de la plantilla (=HOY()-últimoPago) devuelve el
          // serial de HOY (~46000 y pico en 2026) cuando no hay último pago cargado, en
          // vez de un valor sensato — se descarta cualquier cosa por encima de 10 años
          // como dato no confiable en vez de mostrar una antigüedad absurda.
          const diasNumCrudo = parseInt(String(diasSinPagoTexto).replace(/\D/g, ''), 10) || 0;
          const diasNum = diasNumCrudo > 3650 ? 0 : diasNumCrudo;
          const { nombre, apellido } = parsearNombreArchivo(f.name);
          return { nombre: `${nombre} ${apellido}`.trim(), saldo: saldoNum, dias: diasNum };
        } catch (err) {
          console.warn(`[admin.js] no se pudo leer la ficha ${f.name} para deuda:`, err?.message || err);
          return null;
        }
      }));
      resultados.forEach((r) => {
        if (!r) { fallidos++; return; }
        totalPacientesConSaldo++;
        if (r.saldo > 0) {
          conDeuda++;
          topDeudoresMonto.push(r);
          if (r.dias > 0) topDeudoresAntiguedad.push(r);
        }
      });
    }
    if (fallidos > 0) {
      console.warn(`[admin.js] deuda: ${fallidos} de ${archivos.length} fichas no se pudieron leer (quedan afuera del cálculo)`);
    }
  } catch (err) {
    console.warn('[admin.js] no se pudo calcular deuda de pacientes:', err?.message || err);
  }

  topDeudoresMonto.sort((a, b) => b.saldo - a.saldo);
  topDeudoresAntiguedad.sort((a, b) => b.dias - a.dias);
  const valor = { conDeuda, totalPacientesConSaldo, fallidos, topDeudoresMonto, topDeudoresAntiguedad };
  cacheDeuda = { valor, ts: Date.now() };
  return valor;
}

// Cancelados/reprogramados: Calendar no guarda turnos borrados, así que no hay forma
// de calcularlos en vivo como confirmados/nuevos — se cuentan desde ActividadLog (ver
// lib/adminConfig.js), que solo tiene datos desde que se agregó este logging
// (2026-08-13 en adelante). Se muestran como cantidad, no %: no hay un denominador
// común honesto entre "turnos vigentes ahora en Calendar" y "eventos de cancelación
// ya registrados en el log".
async function calcularCancelacionesYReprogramaciones(desde, hasta) {
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
  return { cancelados, reprogramados };
}

const TURNOS_VACIO = { eventos: [], porDia: {}, online: 0, cargadoAyelen: 0, confirmados: 0, nuevos: 0, recurrentes: 0, total: 1 };

async function getMetricas(req, res) {
  const dias = Math.min(Number(req.query.dias) || 30, 90);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60000);
  const hasta = new Date(Date.now() + DIAS_FUTURO_FIJO * 24 * 60 * 60000);

  // Ninguno de los tres cálculos puede tumbar el dashboard entero — cada uno
  // degrada a "sin datos" por su cuenta y el error real queda visible en
  // `errores` para poder diagnosticar sin depender de los logs de Vercel
  // (encontrado en producción, 2026-08-13: un error acá se mostraba como
  // "No se pudieron cargar las métricas" sin ninguna pista de la causa real).
  const errores = [];
  const [
    { eventos, porDia, online, cargadoAyelen, confirmados, nuevos, recurrentes, total },
    { conDeuda, totalPacientesConSaldo, fallidos: fichasFallidas, topDeudoresMonto, topDeudoresAntiguedad },
    { cancelados, reprogramados },
  ] = await Promise.all([
    calcularTurnos(desde, hasta).catch((err) => {
      console.error('[admin.js] calcularTurnos falló:', err);
      errores.push(`turnos: ${err?.message || err}`);
      return TURNOS_VACIO;
    }),
    calcularDeuda(!!req.query.forzar),
    calcularCancelacionesYReprogramaciones(desde, hasta),
  ]);

  res.status(200).json({
    ...(errores.length ? { errores } : {}),
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
    totalPacientesConSaldo,
    fichasFallidas,
  });
}

// ---------- 9b. Métricas avanzadas (ocupación, inasistencia, ingresos, pacientes, ticket) ----------
// Aparte de getMetricas() (recurso=metricas) a propósito: acá adentro está el escaneo
// más pesado de todo el panel (movimientos de CADA ficha, no solo un par de celdas como
// calcularDeuda), así que separarlo en su propio recurso deja que el dashboard "rápido"
// cargue y se pinte sin esperar esto, y que este pedazo tenga su propio spinner/caché.

// ---- (a) Ocupación mensual ----
// Capacidad nominal = slots de slotMinutes según el horario configurado (WEEKLY_SCHEDULE
// o lo guardado en /admin), menos los minutos bloqueados ese mes (día completo o
// parcial). Los sobreturnos NO restan de la capacidad nominal (son turnos extra fuera de
// la grilla habitual) — por eso la ocupación puede superar el 100%, a propósito.
async function calcularOcupacionMes(calendar, year, month, schedule, slotMinutes) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = toArgDate(`${year}-${pad2(month)}-01`, '00:00');
  const lastDayStr = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
  const monthEnd = new Date(toArgDate(lastDayStr, '00:00').getTime() + 24 * 60 * 60000);

  const [principal, sobreturnos] = await Promise.all([
    conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin: monthStart.toISOString(), timeMax: monthEnd.toISOString(), singleEvents: true, maxResults: 2500 })),
    conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin: monthStart.toISOString(), timeMax: monthEnd.toISOString(), singleEvents: true, maxResults: 2500 })),
  ]);

  const eventosPrincipal = principal.data.items || [];
  const bloqueos = eventosPrincipal.filter((ev) => (ev.description || '').includes(BLOCK_MARKER));
  const turnosReservados = eventosPrincipal.length - bloqueos.length;
  const sobreturnosReservados = (sobreturnos.data.items || []).length;

  let capacidad = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    const ranges = schedule[dayOfWeek] || [];
    ranges.forEach(([ini, fin]) => {
      const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
      const mins = (toArgDate(dateStr, fin) - toArgDate(dateStr, ini)) / 60000;
      capacidad += Math.floor(mins / slotMinutes);
    });
  }
  const minutosBloqueados = bloqueos.reduce((acc, ev) => {
    const { start, end } = eventBounds(ev);
    return acc + (end - start) / 60000;
  }, 0);
  capacidad = Math.max(0, capacidad - Math.round(minutosBloqueados / slotMinutes));

  return {
    anio: year,
    mes: month,
    turnosReservados,
    sobreturnosReservados,
    capacidad,
    porcentaje: capacidad > 0 ? Math.round((turnosReservados / capacidad) * 100) : null,
  };
}

// ---- (b) % de inasistencia mensual ----
// Solo se cuenta desde INASISTENCIA_DESDE en adelante (pedido explícito): antes de esa
// fecha el estado "confirmado" no era un dato confiable para todos los turnos viejos.
// "Inasistencia" acá = turno YA PASADO sin confirmar — no distingue si el paciente avisó
// o no, mismo criterio simple que el resto de las métricas de este dashboard.
const INASISTENCIA_DESDE = '2026-08-13';
async function calcularInasistenciaMensual(calendar) {
  const desde = toArgDate(INASISTENCIA_DESDE, '00:00');
  const ahora = new Date();
  if (ahora <= desde) return [];

  let eventos = [];
  let pageToken;
  do {
    const { data } = await conReintentos(() => calendar.events.list({
      calendarId: CALENDAR_ID, timeMin: desde.toISOString(), timeMax: ahora.toISOString(),
      singleEvents: true, maxResults: 2500, pageToken,
    }));
    eventos = eventos.concat(data.items || []);
    pageToken = data.nextPageToken;
  } while (pageToken);

  const porMes = {};
  eventos.forEach((ev) => {
    if ((ev.description || '').includes(BLOCK_MARKER)) return;
    const { start } = eventBounds(ev);
    if (start > ahora) return;
    const key = formatArgDay(start).slice(0, 7);
    (porMes[key] ||= { mes: key, total: 0, inasistencias: 0 });
    porMes[key].total++;
    if (!extraerConfirmado(ev.description)) porMes[key].inasistencias++;
  });

  return Object.values(porMes)
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .map((m) => ({ ...m, porcentaje: m.total ? Math.round((m.inasistencias / m.total) * 100) : 0 }));
}

// ---- Cotización histórica del dólar blue (ArgentinaDatos, sin auth) ----
// Se trae el HISTÓRICO COMPLETO de una sola vez (un solo fetch, ~5700 filas, liviano)
// en vez de una llamada por cada pago cobrado — con cientos de movimientos guardados,
// eso hubiera sido cientos de fetches a una API externa solo para armar el ticket
// promedio en USD. Cacheado 6hs en memoria del proceso (la cotización de un día que ya
// pasó no cambia más).
let cacheDolarBlue = null; // { porFecha: Map, fechasOrdenadas: string[], ts }
const TTL_DOLAR_MS = 6 * 60 * 60 * 1000;
async function obtenerHistoricoDolarBlue() {
  if (cacheDolarBlue && Date.now() - cacheDolarBlue.ts < TTL_DOLAR_MS) return cacheDolarBlue;
  const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/blue');
  if (!r.ok) throw new Error(`ArgentinaDatos respondió ${r.status}`);
  const data = await r.json();
  const porFecha = new Map();
  (data || []).forEach((d) => { if (d.fecha && d.venta) porFecha.set(d.fecha, d.venta); });
  const fechasOrdenadas = [...porFecha.keys()].sort();
  cacheDolarBlue = { porFecha, fechasOrdenadas, ts: Date.now() };
  return cacheDolarBlue;
}

// Si el día exacto no tiene cotización (fin de semana/feriado, ver el pedido), se usa la
// fecha disponible más cercana ANTERIOR — búsqueda binaria porque `fechasOrdenadas` puede
// tener miles de entradas y esto se llama una vez por cada pago cobrado.
function dolarBlueEnFecha(cache, fechaISO) {
  if (cache.porFecha.has(fechaISO)) return cache.porFecha.get(fechaISO);
  const { fechasOrdenadas } = cache;
  let lo = 0, hi = fechasOrdenadas.length - 1, resultado = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fechasOrdenadas[mid] <= fechaISO) { resultado = fechasOrdenadas[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return resultado ? cache.porFecha.get(resultado) : null;
}

// "D/M/AAAA" (ver fechaInputASheet en pacientes/index.html) -> "YYYY-MM-DD". Devuelve
// null si no matchea el formato esperado (fila vieja/mal cargada a mano) en vez de
// reventar todo el cálculo por una sola fila rara.
function fechaSheetAIso(fechaStr) {
  const m = String(fechaStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ---- (c)+(d)+(e) Escaneo combinado de fichas: ingresos, ticket promedio y pacientes ----
// Un solo recorrido de todas las fichas (batchGet de 2 rangos por archivo: identidad +
// movimientos) en vez de tres escaneos separados — ya es la operación más cara del
// panel con uno solo. Mismo patrón de lotes de 25 en paralelo que calcularDeuda(), con
// paginado completo de Drive (ver el bug real de "no se están tomando valores más altos"
// del 2026-08-13 — cortar en la primera página deja fichas afuera en silencio).
let cacheFinanzas = null; // { valor, ts }
const TTL_FINANZAS_MS = 300000;
async function calcularFinanzasPacientes(forzar) {
  if (!forzar && cacheFinanzas && Date.now() - cacheFinanzas.ts < TTL_FINANZAS_MS) return cacheFinanzas.valor;

  const ingresosPorDia = {};
  const pagos = []; // { fechaISO, monto }
  const fichasIdentidad = []; // { id, nombre, apellido, dni, telefono }
  let fallidos = 0;

  try {
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();

    let archivos = [];
    let pageToken;
    do {
      const { data } = await conReintentos(() => drive.files.list({
        q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id, name), nextPageToken',
        pageSize: 250,
        pageToken,
      }));
      archivos = archivos.concat(data.files || []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    archivos = archivos.filter((f) => !/^⭐/.test(f.name));

    const LOTE = 25;
    for (let i = 0; i < archivos.length; i += LOTE) {
      const lote = archivos.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
            spreadsheetId: f.id,
            ranges: [`${SHEET_NAME}!C5:C15`, rangoMovimientos()],
          }));
          const [identidadRaw, movRaw] = data.valueRanges || [];
          const c = (identidadRaw?.values || []).map((r) => (r[0] != null ? String(r[0]) : ''));
          while (c.length < 11) c.push('');
          const [nombre, apellido, dni, , , , , , , telefono] = c;

          const movimientos = (movRaw?.values || [])
            .map((row) => ({ fecha: row[0] || '', tratamiento: row[1] || '', haber: row[3] || '' }))
            .filter((m) => m.fecha && m.haber && !/^\[ANULADO\]/.test(m.tratamiento));

          return { id: f.id, nombre, apellido, dni, telefono, movimientos };
        } catch (err) {
          console.warn(`[admin.js] no se pudo leer la ficha ${f.name} para finanzas:`, err?.message || err);
          return null;
        }
      }));
      resultados.forEach((r) => {
        if (!r) { fallidos++; return; }
        fichasIdentidad.push({ id: r.id, nombre: r.nombre, apellido: r.apellido, dni: r.dni, telefono: r.telefono });
        r.movimientos.forEach((m) => {
          const fechaISO = fechaSheetAIso(m.fecha);
          if (!fechaISO) return;
          const monto = parsearMontoArgentino(m.haber);
          if (monto <= 0) return;
          ingresosPorDia[fechaISO] = (ingresosPorDia[fechaISO] || 0) + monto;
          pagos.push({ fechaISO, monto });
        });
      });
    }
  } catch (err) {
    console.warn('[admin.js] no se pudo calcular finanzas de pacientes:', err?.message || err);
  }

  // (e) Ticket promedio en $ y USD, agrupado por mes y por año — cada pago se convierte
  // con la cotización blue REAL del día que se cobró (pedido explícito), no la de hoy.
  let dolarCache = null;
  let dolarError = null;
  try {
    dolarCache = await obtenerHistoricoDolarBlue();
  } catch (err) {
    console.warn('[admin.js] no se pudo obtener el histórico del dólar blue:', err?.message || err);
    dolarError = err?.message || String(err);
  }

  const acumPorMes = {};
  const acumPorAnio = {};
  pagos.forEach((p) => {
    const mesKey = p.fechaISO.slice(0, 7);
    const anioKey = p.fechaISO.slice(0, 4);
    const cotizacion = dolarCache ? dolarBlueEnFecha(dolarCache, p.fechaISO) : null;
    const montoUsd = cotizacion ? p.monto / cotizacion : null;

    (acumPorMes[mesKey] ||= { mes: mesKey, cantidad: 0, sumaArs: 0, sumaUsd: 0, pagosConUsd: 0 });
    acumPorMes[mesKey].cantidad++;
    acumPorMes[mesKey].sumaArs += p.monto;
    if (montoUsd != null) { acumPorMes[mesKey].sumaUsd += montoUsd; acumPorMes[mesKey].pagosConUsd++; }

    (acumPorAnio[anioKey] ||= { anio: anioKey, cantidad: 0, sumaArs: 0, sumaUsd: 0, pagosConUsd: 0 });
    acumPorAnio[anioKey].cantidad++;
    acumPorAnio[anioKey].sumaArs += p.monto;
    if (montoUsd != null) { acumPorAnio[anioKey].sumaUsd += montoUsd; acumPorAnio[anioKey].pagosConUsd++; }
  });
  const armarPromedio = (acum) => ({
    ...acum,
    promedioArs: acum.cantidad ? Math.round(acum.sumaArs / acum.cantidad) : 0,
    promedioUsd: acum.pagosConUsd ? Math.round((acum.sumaUsd / acum.pagosConUsd) * 100) / 100 : null,
  });
  const ticketPorMes = Object.values(acumPorMes).sort((a, b) => a.mes.localeCompare(b.mes)).map(armarPromedio);
  const ticketPorAnio = Object.values(acumPorAnio).sort((a, b) => a.anio.localeCompare(b.anio)).map(armarPromedio);

  // (c) Ingresos: serie diaria completa (la usa el frontend para armar tanto la vista
  // diaria del mes actual como los totales mensual/anual, sumando sobre esta misma serie
  // en vez de mandar tres formatos distintos desde el back).
  const ingresosDiarios = Object.entries(ingresosPorDia)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, monto]) => ({ fecha, monto: Math.round(monto * 100) / 100 }));

  const valor = {
    ingresosDiarios,
    ticketPorMes,
    ticketPorAnio,
    dolarError,
    fichasIdentidad,
    fichasFallidas: fallidos,
  };
  cacheFinanzas = { valor, ts: Date.now() };
  return valor;
}

// ---- (d) Pacientes totales: fichas + turnos sin ficha, sin duplicar ----
// Ya no escanea Calendar en vivo (ver el pedido, 2026-08-14) — lee directo de la
// planilla "Pacientes consolidados" (lib/pacientesConsolidados.js), la misma fuente
// única que ahora usa también el autocompletado de /gestion, mantenida al día con
// escrituras puntuales en vez de un escaneo completo por request. Mismo criterio de
// matching "ya establecido en el proyecto" (mismo teléfono) que antes, solo que
// resuelto de antemano en vez de en cada carga del dashboard.
async function calcularPacientesTotales() {
  let filas = [];
  try {
    filas = await listarPacientesConsolidados();
  } catch (err) {
    console.warn('[admin.js] no se pudo leer la planilla consolidada para pacientes totales:', err?.message || err);
    return { total: null, totalFichas: null, totalSoloTurno: null, fichas: [], soloTurno: [] };
  }

  const fichas = filas
    .filter((f) => f.fichaId)
    .map((f) => ({ id: f.fichaId, nombre: f.nombre, apellido: f.apellido, dni: f.dni, telefono: f.telefono }));
  const soloTurno = filas
    .filter((f) => !f.fichaId)
    .map((f) => ({ nombre: `${f.nombre} ${f.apellido}`.trim(), dni: f.dni, telefono: f.telefono }));

  return {
    total: fichas.length + soloTurno.length,
    totalFichas: fichas.length,
    totalSoloTurno: soloTurno.length,
    fichas,
    soloTurno: soloTurno.slice(0, 500),
  };
}

async function getMetricasAvanzadas(req, res) {
  const calendar = getCalendarClient();
  const config = await obtenerHorariosConfig();
  const hoy = new Date();
  const anioActual = hoy.getFullYear();
  const mesActual = hoy.getMonth() + 1;
  const anioSiguiente = mesActual === 12 ? anioActual + 1 : anioActual;
  const mesSiguiente = mesActual === 12 ? 1 : mesActual + 1;

  const errores = [];
  const [ocupacionActual, ocupacionSiguiente, inasistenciaMensual, finanzas] = await Promise.all([
    calcularOcupacionMes(calendar, anioActual, mesActual, config.schedule, config.slotMinutes).catch((err) => {
      errores.push(`ocupación: ${err?.message || err}`);
      return null;
    }),
    calcularOcupacionMes(calendar, anioSiguiente, mesSiguiente, config.schedule, config.slotMinutes).catch((err) => {
      errores.push(`ocupación próximo mes: ${err?.message || err}`);
      return null;
    }),
    calcularInasistenciaMensual(calendar).catch((err) => {
      errores.push(`inasistencia: ${err?.message || err}`);
      return [];
    }),
    calcularFinanzasPacientes(!!req.query.forzar).catch((err) => {
      errores.push(`finanzas: ${err?.message || err}`);
      return { ingresosDiarios: [], ticketPorMes: [], ticketPorAnio: [], fichasIdentidad: [], fichasFallidas: 0 };
    }),
  ]);

  const pacientesTotales = await calcularPacientesTotales().catch((err) => {
    errores.push(`pacientes totales: ${err?.message || err}`);
    return { total: null, totalFichas: null, totalSoloTurno: null, fichas: [], soloTurno: [] };
  });

  res.status(200).json({
    ...(errores.length ? { errores } : {}),
    ocupacion: { actual: ocupacionActual, siguiente: ocupacionSiguiente },
    inasistenciaMensual,
    ingresosDiarios: finanzas.ingresosDiarios,
    ticketPorMes: finanzas.ticketPorMes,
    ticketPorAnio: finanzas.ticketPorAnio,
    dolarError: finanzas.dolarError || null,
    pacientesTotales,
    fichasFallidas: finanzas.fichasFallidas,
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

// Un Content-Disposition con tildes/ñ sin encodear (ej. "José" o "Núñez", nombres
// reales comunes acá) hace que Node tire ERR_INVALID_CHAR al setear el header — bug
// real encontrado en producción, 2026-08-13 ("Error inesperado" al exportar la ficha
// de un paciente con nombre acentuado). Se sacan los diacríticos para el filename
// (solo afecta el nombre de archivo sugerido, no el contenido del PDF).
function nombreArchivoSeguro(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim() || 'archivo';
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
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoSeguro(nombre)}_${nombreArchivoSeguro(apellido)}_ficha.pdf"`);
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
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoSeguro(nombre)}_${nombreArchivoSeguro(apellido)}_estado_cuenta.pdf"`);
  res.status(200).send(buffer);
}
