// Módulo de Pacientes (Fase 1) — TODAS las acciones en un solo archivo a propósito,
// para no pasarnos del límite de 12 funciones serverless del plan Hobby (ver
// CLAUDE.md). Lecturas van por GET con `modo`, escrituras por POST con `accion` —
// mismo patrón que ya usan buscar.js y evento.js.
//
// Autenticación con Google Sheets/Drive: OAuth como el odontólogo (ver
// lib/googleOAuthPacientes.js), no la cuenta de servicio — el porqué está documentado
// ahí mismo. Calendar (autocompletar teléfono desde turnos) sigue usando la cuenta de
// servicio de siempre (lib/googleCalendar.js), sin cambios.
import {
  getPacientesSheetsClient, getPacientesDriveClient, buildAuthUrl, exchangeCodeForTokens,
} from '../../lib/googleOAuthPacientes.js';
import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, normalizarTexto, extraerTelefono,
  extraerDni, isValidGestionKey, getHorariosLibresDia, formatArgDay, formatArgTime, toArgDate,
} from '../../lib/googleCalendar.js';
import {
  PACIENTES_FOLDER_ID, FICHA_TEMPLATE_ID, BACKUP_FOLDER_NAME, SHEET_NAME,
  FORMA_PAGO_COLUMN_INDEX, CAMPO_CELDA, CAMPOS_ORDENADOS, rangoMovimientos,
  rangoPrestacionesObraSocial, primeraFilaLibre, esCeldaConDatoReal,
  MOVIMIENTOS_FILA_INICIO, MOVIMIENTOS_FILA_FIN,
  nombreArchivo, parsearNombreArchivo,
  normalizarDni, CAMPOS_MAYUSCULAS, aMayusculas, aTituloCase,
  MAPEO_TELEFONO_FICHA_NAME, normalizarTelefonoMapeo,
} from '../../lib/pacientesSheet.js';
import { avisarFallo } from '../../lib/alertas.js';
// Reintentos puntuales, call site por call site — NUNCA envolver el cliente entero
// (getPacientesSheetsClient()/getPacientesDriveClient()) en un Proxy, ver el incidente
// documentado en lib/googleCalendar.js y decisions.md.
import { conReintentos } from '../../lib/retry.js';
import { isValidAdminKey } from '../../lib/adminAuth.js';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { upsertPacienteConsolidado, actualizarPacienteConsolidado, listarPacientesConsolidados, PACIENTES_CONSOLIDADOS_NAME } from '../../lib/pacientesConsolidados.js';
import { generarPdfReceta } from '../../lib/pdfExport.js';
import { parsearReceta, camposFaltantes } from '../../lib/recetaParser.js';
import { extraerUrlFirmaElectronica } from '../../lib/recetaFirmaQr.js';

// drive.files.create espera un stream legible en media.body, no un Buffer crudo.
function bufferToStream(buffer) {
  return Readable.from(buffer);
}

// /admin (sección "Datos de pacientes", ver el pedido) reusa este mismo motor en vez
// de reimplementar 950 líneas — ADMIN_KEY vale como alternativa a GESTION_KEY solo
// para las operaciones de datos (no para oauth-iniciar/healthcheck, que no aplican).
function claveValida(key) {
  return isValidGestionKey(key) || isValidAdminKey(key);
}

export default async function handler(req, res) {
  try {
    // Callback de Google (siempre GET, sin `modo`, con `code` y `state`) — no lleva
    // GESTION_KEY porque viene del navegador del odontólogo después del consentimiento,
    // no de un fetch nuestro. El `state` es la propia GESTION_KEY: si no coincide, se
    // rechaza (evita que alguien dispare el intercambio de code con un state ajeno).
    if (req.method === 'GET' && req.query.code) {
      return await oauthCallback(req, res);
    }

    if (req.method === 'GET' && req.query.modo === 'oauth-iniciar') {
      if (!isValidGestionKey(req.query.key)) return res.status(401).send('unauthorized');
      return res.redirect(302, buildAuthUrl(req.query.key));
    }

    // Cron de salud diario (ver vercel.json) — sin GESTION_KEY porque no es un fetch del
    // panel: lo llama Vercel Cron solo, autenticado con CRON_SECRET (header Authorization
    // que Vercel agrega automáticamente a cada invocación de cron cuando esa variable de
    // entorno está seteada). Vive acá adentro (en vez de un archivo nuevo en api/) para no
    // pasar el límite de 12 funciones serverless del plan Hobby — mismo motivo que el resto
    // de este archivo, ver el comentario del encabezado.
    if (req.method === 'GET' && req.query.modo === 'healthcheck') {
      return await healthcheck(req, res);
    }

    // UTILITARIO TEMPORAL DE DIAGNÓSTICO (2026-08-25): solo lectura — reporta el estado de
    // la planilla "Pacientes consolidados" (encabezado, cantidad de filas, primeras 5) para
    // entender por qué la sección Pacientes aparece vacía. Se saca apenas se diagnostique.
    if (req.method === 'GET' && req.query.modo === 'diagnostico-consolidados') {
      return await diagnosticoConsolidados(req, res);
    }

    // Fotos de pacientes (/mobilephotouploaderodfrancovinzon, ver el pedido) — SIN
    // clave a propósito (decisión explícita del usuario): la única protección es que
    // la URL de esa página no es adivinable. Se acota el daño igual: buscar-publico
    // nunca devuelve más que nombre/apellido/dni (nada financiero ni de contacto), y
    // fotos/foto-imagen solo sirven lo que ya se subió como foto de paciente — mismo
    // nivel de exposición que decidió aceptar el usuario para esa página entera.
    if (req.method === 'GET' && req.query.modo === 'buscar-publico') {
      return await buscarPublico(req, res);
    }
    if (req.method === 'GET' && req.query.modo === 'hoy-publico') {
      return await hoyPublico(req, res);
    }
    if (req.method === 'GET' && req.query.modo === 'fotos') {
      return await listarFotos(req, res);
    }
    if (req.method === 'GET' && req.query.modo === 'foto-imagen') {
      return await servirFotoImagen(req, res);
    }
    // Recetas (mismo nivel de exposición que las fotos de arriba — decisión explícita
    // del usuario, 2026-08-20: URL no adivinable como única protección, consistente con
    // el resto de /mobile en vez de sumar un sistema de clave nuevo ahí).
    if (req.method === 'GET' && req.query.modo === 'recetas') {
      return await listarRecetas(req, res);
    }
    if (req.method === 'GET' && req.query.modo === 'receta-pdf') {
      return await servirRecetaPdf(req, res);
    }
    if (req.method === 'GET' && req.query.modo === 'receta-proceso') {
      return await obtenerRecetaProceso(req, res);
    }




    if (req.method === 'GET') {
      if (!claveValida(req.query.key)) return res.status(401).json({ error: 'unauthorized' });
      if (req.query.modo === 'listar') return await listar(req, res);
      if (req.query.modo === 'ficha') return await obtenerFicha(req, res);
      if (req.query.modo === 'modified') return await obtenerModified(req, res);
      if (req.query.modo === 'telefono-turnos') return await telefonoDesdeTurnos(req, res);
      if (req.query.modo === 'telefono') return await obtenerTelefonoFicha(req, res);
      if (req.query.modo === 'mapeos') return await obtenerMapeos(req, res);
      if (req.query.modo === 'cumpleanos-hoy') return await cumpleanosHoy(req, res);
      return res.status(400).json({ error: 'modo inválido' });
    }

    if (req.method === 'POST' && req.body.accion === 'subir-foto') {
      return await subirFoto(req, res);
    }
    if (req.method === 'POST' && req.body.accion === 'eliminar-foto') {
      return await eliminarFoto(req, res);
    }
    // Recetas — mismo nivel sin clave que subir-foto/eliminar-foto arriba (ver el
    // comentario de modo=recetas más arriba en este mismo handler).
    if (req.method === 'POST' && req.body.accion === 'receta-procesar-pdf') {
      return await procesarRecetaPdf(req, res);
    }
    if (req.method === 'POST' && req.body.accion === 'receta-guardar') {
      return await guardarReceta(req, res);
    }
    if (req.method === 'POST' && req.body.accion === 'receta-recibir-shortcut') {
      return await recibirRecetaShortcut(req, res);
    }
    if (req.method === 'POST') {
      if (!claveValida(req.body.key)) return res.status(401).json({ error: 'unauthorized' });
      if (req.body.accion === 'crear') return await crearPaciente(req, res);
      if (req.body.accion === 'actualizar-campo') return await actualizarCampo(req, res);
      if (req.body.accion === 'actualizar-paciente-central') return await actualizarPacienteCentral(req, res);
      if (req.body.accion === 'fusionar') return await fusionarPacientes(req, res);
      if (req.body.accion === 'completar-telefono-turno') return await completarTelefonoTurno(req, res);
      if (req.body.accion === 'confirmar-match') return await confirmarMatch(req, res);
      if (req.body.accion === 'movimiento-agregar') return await movimientoAgregar(req, res);
      if (req.body.accion === 'movimiento-editar') return await movimientoEditar(req, res);
      if (req.body.accion === 'movimiento-anular') return await movimientoAnular(req, res);
      if (req.body.accion === 'prestacion-agregar') return await prestacionAgregar(req, res);
      if (req.body.accion === 'prestacion-editar') return await prestacionEditar(req, res);
      if (req.body.accion === 'prestacion-eliminar') return await prestacionEliminar(req, res);
      return res.status(400).json({ error: 'acción inválida' });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    await avisarFallo({
      endpoint: 'api/gestion/pacientes.js',
      detalle: req.query?.modo || req.body?.accion || '(sin modo/acción)',
      error: err,
    });
    res.status(500).json({ error: 'Error inesperado.' });
  }
}

// ---------- Chequeo de salud diario (cron de Vercel, ver vercel.json) ----------
// Prueba que las piezas clave (Calendar y Sheets/Drive) respondan, SIN crear ni
// modificar ningún dato real — solo lecturas ya usadas en producción (disponibilidad de
// hoy, listado de fichas), las mismas que ya tienen reintentos. Si algo falla incluso
// después de reintentar, dispara el mismo email de alerta que el resto del sitio.
async function healthcheck(req, res) {
  const secreto = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secreto || auth !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const resultados = {};

  try {
    // getHorariosLibresDia() ya reintenta internamente su propia llamada a Calendar
    // (ver lib/googleCalendar.js) — no hace falta envolverla de nuevo acá.
    const calendar = getCalendarClient();
    await getHorariosLibresDia(calendar, formatArgDay(new Date()));
    resultados.calendar = 'ok';
  } catch (err) {
    resultados.calendar = 'error';
    console.error('[healthcheck] calendar:', err);
    await avisarFallo({ endpoint: 'healthcheck', detalle: 'Calendar (disponibilidad de hoy)', error: err });
  }

  try {
    // listarArchivosPacientes() también reintenta internamente, mismo motivo.
    const drive = getPacientesDriveClient();
    await listarArchivosPacientes(drive);
    resultados.pacientes = 'ok';
  } catch (err) {
    resultados.pacientes = 'error';
    console.error('[healthcheck] pacientes:', err);
    await avisarFallo({ endpoint: 'healthcheck', detalle: 'Pacientes (Sheets/Drive)', error: err });
  }

  const huboFallo = Object.values(resultados).some((v) => v === 'error');
  res.status(huboFallo ? 500 : 200).json({ ok: !huboFallo, ...resultados, hora: new Date().toISOString() });
}

// ---------- OAuth (setup único, ver gestion/conectar-drive.html) ----------

async function oauthCallback(req, res) {
  if (req.query.state !== process.env.GESTION_KEY) {
    return res.status(401).send('No autorizado.');
  }
  try {
    const tokens = await exchangeCodeForTokens(req.query.code);
    if (!tokens.refresh_token) {
      return res.status(200).send(
        '<p>Google no mandó un refresh_token (probablemente ya se había autorizado antes). ' +
        'Volvé a intentarlo — la app fuerza <code>prompt=consent</code>, así que debería aparecer ' +
        'de nuevo la pantalla de permisos.</p>'
      );
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`
      <div style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px;">
        <h2>Conectado correctamente</h2>
        <p>Copiá este valor y guardalo en Vercel como la variable de entorno
        <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> (Production and Preview). Después de guardarlo hay
        que volver a desplegar para que tome efecto.</p>
        <textarea readonly style="width:100%; height:80px; font-family: monospace; padding: 8px;">${tokens.refresh_token}</textarea>
        <p>Una vez guardado, se puede cerrar esta pestaña.</p>
      </div>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo completar la conexión con Google. Revisar logs.');
  }
}

// ---------- Lectura ----------

// Lista cruda de fichas (id + nombre de archivo) desde Drive — base tanto de `listar`
// (para la UI) como del chequeo de DNI duplicado al crear una ficha nueva.
async function listarArchivosPacientes(drive) {
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  }));
  // Bug real encontrado en la auditoría de integridad (2026-08-14): esto NO excluía
  // las hojas propias del sistema (Mapeo teléfono-ficha, Pacientes consolidados), que
  // viven en la misma carpeta y son Sheets igual que las fichas — se colaban en el
  // listado de pacientes, en calcularDeuda/calcularFinanzasPacientes de /admin, y en
  // el escaneo de la auditoría misma (que las reportó como si fueran una ficha real).
  // "(no tocar)" es la convención ya establecida en todo el proyecto para marcar estas
  // hojas/carpetas de sistema (ver FOTOS_FOLDER_NAME, BACKUP_FOLDER_NAME,
  // MAPEO_TELEFONO_FICHA_NAME, PACIENTES_CONSOLIDADOS_NAME) — nunca se había aplicado acá.
  return (data.files || []).filter((f) => f.id !== FICHA_TEMPLATE_ID && !/^⭐/.test(f.name) && !/\(no tocar\)\s*$/.test(f.name));
}

async function listar(req, res) {
  const drive = getPacientesDriveClient();
  const archivos = await listarArchivosPacientes(drive);

  const pacientes = archivos
    .map((f) => {
      const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
      return { id: f.id, nombre, apellido, dni };
    })
    .sort((a, b) => `${a.nombre} ${a.apellido}`.localeCompare(`${b.nombre} ${b.apellido}`, 'es'));

  res.status(200).json(pacientes);
}

// Buscador SIN clave para /mobilephotouploaderodfrancovinzon (ver el pedido) — a
// propósito devuelve mucho menos que `listar()`: nada de eso se expone salvo que
// alguien busque activamente por nombre/DNI, y nunca hay más de 15 resultados.
async function buscarPublico(req, res) {
  const q = normalizarTexto((req.query.q || '').trim());
  if (q.length < 2) return res.status(200).json([]);

  const drive = getPacientesDriveClient();
  const archivos = await listarArchivosPacientes(drive);

  const resultados = archivos
    .map((f) => {
      const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
      return { id: f.id, nombre, apellido, dni };
    })
    .filter((p) => {
      // Bug real (2026-08-13): con una búsqueda sin dígitos (ej. "Fa"), `qDigits` queda
      // vacío y `cualquierString.includes('')` da SIEMPRE true en JS — el OR de abajo
      // terminaba matcheando TODAS las fichas por la rama de DNI, ignorando el nombre
      // tipeado. Por eso la rama de DNI solo se evalúa si `qDigits` tiene contenido.
      const qDigits = q.replace(/\D/g, '');
      return normalizarTexto(`${p.nombre} ${p.apellido}`).includes(q) || (qDigits && normalizarDni(p.dni).includes(qDigits));
    })
    .sort((a, b) => `${a.nombre} ${a.apellido}`.localeCompare(`${b.nombre} ${b.apellido}`, 'es'))
    .slice(0, 15);

  res.status(200).json(resultados);
}

// "Pacientes de hoy" para /mobilephotouploaderodfrancovinzon (ver el pedido, 2026-08-13)
// — mismo criterio "de hoy" que /pacientes, pero simplificado a propósito: solo el
// match EXACTO nombre+apellido turno<->ficha (nivel 1/2 de /pacientes), sin la cascada
// de teléfono/similitud difusa (nivel 3/4/5) que ese panel sí hace — acá es un atajo de
// conveniencia para no tener que buscar a mano, no la fuente de verdad del matching, así
// que un paciente que no matchee exacto simplemente no aparece en la lista rápida (sigue
// pudiendo buscarse a mano arriba, sin ningún dato perdido).
async function hoyPublico(req, res) {
  try {
    const calendar = getCalendarClient();
    const hoyStr = formatArgDay(new Date());
    const desde = toArgDate(hoyStr, '00:00');
    const hasta = new Date(desde.getTime() + 24 * 60 * 60000);

    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 200 })),
      conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 200 })),
    ]);
    const eventos = [...(principal.data.items || []), ...(sobreturnos.data.items || [])]
      .filter((ev) => ev.start.dateTime && !(ev.description || '').includes(BLOCK_MARKER))
      .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

    const drive = getPacientesDriveClient();
    const archivos = await listarArchivosPacientes(drive);
    const fichas = archivos.map((f) => {
      const { nombre, apellido } = parsearNombreArchivo(f.name);
      return { id: f.id, nombre, apellido };
    });

    const vistos = new Set();
    const resultado = [];
    eventos.forEach((ev) => {
      const nombreTurno = normalizarTexto(ev.summary || '');
      const ficha = fichas.find((p) => !vistos.has(p.id) && normalizarTexto(`${p.nombre} ${p.apellido}`) === nombreTurno);
      if (!ficha) return;
      vistos.add(ficha.id);
      resultado.push({ id: ficha.id, nombre: ficha.nombre, apellido: ficha.apellido, hora: formatArgTime(new Date(ev.start.dateTime)) });
    });

    res.status(200).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(200).json([]);
  }
}

// Detección de duplicados por DNI (único criterio — ver decisions.md): recorre todas las
// fichas de la carpeta buscando el mismo DNI normalizado (solo dígitos). Se usa al crear
// una ficha nueva, para ofrecer "Abrir ficha" en vez de dejar crear una segunda.
async function buscarPacientePorDni(drive, dniNormalizado, excluirId) {
  if (!dniNormalizado) return null;
  const archivos = await listarArchivosPacientes(drive);
  for (const f of archivos) {
    if (excluirId && f.id === excluirId) continue;
    const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
    if (normalizarDni(dni) === dniNormalizado) return { id: f.id, nombre, apellido };
  }
  return null;
}

// Algunas fichas viejas tienen la validación de casilla del checkbox "Autorizado"
// aplicada por error a una columna de texto (Tratamiento o Código) en vez de solo a la
// suya — Sheets devuelve 'FALSE'/'TRUE' (string) para esas celdas sin completar, que no
// son datos reales cargados por nadie. Se descartan acá para que no aparezcan como filas
// falsas en la tabla de prestaciones (ver tasks.md).
function celdaTextoLimpia(valor) {
  if (valor === true || valor === false || valor === 'TRUE' || valor === 'FALSE') return '';
  return valor || '';
}

async function obtenerFicha(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id.' });

  const sheets = getPacientesSheetsClient();
  const drive = getPacientesDriveClient();

  await intentarRecuperarRespaldos(sheets, drive, id);

  const [campos, financiero, movRaw, presRaw, meta] = await Promise.all([
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C15` })),
    // Columna E también: "AL DÍA"/"DEBE $X" vive en una celda combinada E9:F10 — el
    // valor solo está en la celda ancla E9, F9 devuelve vacío (ver decisions.md).
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!E6:F11` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoMovimientos() })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoPrestacionesObraSocial() })),
    conReintentos(() => drive.files.get({ fileId: id, fields: 'modifiedTime, name' })),
  ]);

  const c = (campos.data.values || []).map((r) => (r[0] != null ? String(r[0]) : ''));
  while (c.length < 11) c.push('');
  const [nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento] = c;

  const f = financiero.data.values || [];
  const total = f[0]?.[1] || '$0,00';
  const pagado = f[1]?.[1] || '$0,00';
  const saldo = f[2]?.[1] || '$0,00';
  const alDiaTexto = f[3]?.[0] || '';
  const diasSinPagoTexto = f[5]?.[1] || '';

  const movimientos = (movRaw.data.values || [])
    .map((row, i) => ({
      fila: 18 + i,
      fecha: row[0] || '',
      tratamiento: row[1] || '',
      debe: row[2] || '',
      haber: row[3] || '',
      saldo: row[4] || '',
      formaPago: row[6] || '',
    }))
    .filter((m) => m.fecha || m.tratamiento || m.debe || m.haber)
    .map((m) => ({ ...m, anulado: /^\[ANULADO\]/.test(m.tratamiento) }));

  const prestacionesObraSocial = (presRaw.data.values || [])
    .map((row, i) => ({
      fila: 18 + i,
      fecha: row[0] || '',
      tratamiento: celdaTextoLimpia(row[1]),
      codigo: celdaTextoLimpia(row[2]),
      autorizado: row[3] === true || row[3] === 'TRUE',
    }))
    .filter((p) => p.fecha || p.tratamiento || p.codigo);

  res.status(200).json({
    id,
    driveModifiedTime: meta.data.modifiedTime,
    campos: { nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento },
    financiero: { total, pagado, saldo, alDiaTexto, diasSinPagoTexto },
    movimientos,
    prestacionesObraSocial,
  });
}

// Fetch liviano de un solo campo (una sola celda, C14 = teléfono dentro del rango
// C5:C15 que usa obtenerFicha) — usado por el cruce de fichas de nivel 3 en
// pacientes/index.html (mismo teléfono + nombre parecido), que solo necesita comparar
// un teléfono para un puñado de candidatos por turno, no la ficha completa.
async function obtenerTelefonoFicha(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id.' });
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C14` }));
  const telefono = data.values?.[0]?.[0] || '';
  res.status(200).json({ telefono: String(telefono) });
}

async function obtenerModified(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id.' });
  const drive = getPacientesDriveClient();
  const { data } = await conReintentos(() => drive.files.get({ fileId: id, fields: 'modifiedTime' }));
  res.status(200).json({ modifiedTime: data.modifiedTime });
}

// Autocompletado de teléfono al crear un paciente (ver decisions.md / tasks del pedido):
// coincidencia EXACTA de nombre+apellido en cualquiera de los dos calendarios, cualquier
// fecha. Única coincidencia -> teléfono. Ninguna o varias -> null (nunca se adivina).
async function telefonoDesdeTurnos(req, res) {
  const nombre = (req.query.nombre || '').trim();
  const apellido = (req.query.apellido || '').trim();
  if (!nombre || !apellido) return res.status(200).json({ telefono: null, multiple: false });

  const calendar = getCalendarClient();
  const q = `${nombre} ${apellido}`;

  const [principal, sobreturnos] = await Promise.all([
    conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, q, maxResults: 2500, singleEvents: true })),
    conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, q, maxResults: 2500, singleEvents: true })),
  ]);

  const objetivo = normalizarTexto(q);
  const telefonos = new Set();
  [...(principal.data.items || []), ...(sobreturnos.data.items || [])].forEach((ev) => {
    if (normalizarTexto(ev.summary || '') !== objetivo) return;
    const tel = extraerTelefono(ev.description);
    if (tel) telefonos.add(tel);
  });

  if (telefonos.size === 1) {
    return res.status(200).json({ telefono: [...telefonos][0], multiple: false });
  }
  res.status(200).json({ telefono: null, multiple: telefonos.size > 1 });
}

// Autocompletado cruzado ficha → turno (dirección opuesta a telefonoDesdeTurnos): un
// turno de hoy sin teléfono, cuya ficha coincidente sí tiene uno, se completa solo (sin
// popup, ver decisions.md — el frontend ya hizo el match exacto de nombre+apellido antes
// de llamar acá). El teléfono viene tal cual está escrito en la ficha (texto libre, no
// necesariamente E.164) — a diferencia de agregar-telefono.js de /gestion, acá no se pasa
// por telefonoParaWhatsApp() porque el dato no viene del selector de país. Re-chequea que
// el evento siga sin teléfono antes de escribir (defensivo: puede haber pasado tiempo
// entre que el cliente armó la lista de "hoy" y esta llamada).
async function completarTelefonoTurno(req, res) {
  const { eventId, calendarId, telefono } = req.body;
  if (!eventId || !calendarId || !telefono) {
    return res.status(400).json({ success: false, message: 'Faltan datos.' });
  }
  try {
    const calendar = getCalendarClient();
    const { data: ev } = await conReintentos(() => calendar.events.get({ calendarId, eventId }));
    if (extraerTelefono(ev.description)) {
      return res.status(200).json({ success: true, sinCambios: true }); // ya tiene, no se pisa
    }
    const limpia = (ev.description || '').replace(/\s+$/, '');
    const nuevaDescripcion = limpia ? `${limpia}\nTeléfono: ${telefono}` : `Teléfono: ${telefono}`;
    await conReintentos(() => calendar.events.patch({ calendarId, eventId, requestBody: { description: nuevaDescripcion } }));
    res.status(200).json({ success: true, telefono });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'completar-telefono-turno', error: err });
    res.status(500).json({ success: false, message: 'No se pudo completar el teléfono del turno.' });
  }
}

// ---------- Mapeo teléfono↔ficha ("¿Es este paciente?", ver decisions.md) ----------
// Hoja chica y propia (no una ficha), se crea sola la primera vez que hace falta —
// mismo patrón que getOrCreateBackupFolderId más abajo. Nunca se toca a mano.
async function getOrCreateMapeoSheetId(sheets, drive) {
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${MAPEO_TELEFONO_FICHA_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) return data.files[0].id;

  const creada = await conReintentos(() => sheets.spreadsheets.create({
    requestBody: { properties: { title: MAPEO_TELEFONO_FICHA_NAME } },
    fields: 'spreadsheetId',
  }));
  const id = creada.data.spreadsheetId;
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: 'A1:D1',
    valueInputOption: 'RAW',
    requestBody: { values: [['telefono', 'dni', 'decision', 'fecha']] },
  }));
  // Recién creada, la hoja vive en "Mi unidad" — se mueve a la carpeta de Pacientes para
  // que quede junto a todo lo demás (mismo criterio que getOrCreateBackupFolderId).
  await conReintentos(() => drive.files.update({ fileId: id, addParents: PACIENTES_FOLDER_ID, fields: 'id' }));
  return id;
}

async function leerMapeos(sheets, mapeoId) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: mapeoId, range: 'A2:D' }));
  return (data.values || [])
    .filter((r) => r[0])
    .map((r) => ({ telefono: r[0] || '', dni: r[1] || '', decision: r[2] || '', fecha: r[3] || '' }));
}

// Upsert por (teléfono, dni): si ya hay una fila para ese par, actualiza decisión/fecha
// en vez de duplicar (por si Ayelen cambia de opinión sobre el mismo par más adelante).
async function guardarMapeo(sheets, mapeoId, { telefono, dni, decision }) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: mapeoId, range: 'A2:D' }));
  const filas = data.values || [];
  const idx = filas.findIndex((r) => r[0] === telefono && r[1] === dni);
  const fecha = new Date().toISOString();
  if (idx === -1) {
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: mapeoId,
      range: 'A:D',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[telefono, dni, decision, fecha]] },
    }));
  } else {
    const filaSheet = idx + 2; // +1 por el encabezado, +1 porque Sheets es 1-index
    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: mapeoId,
      range: `C${filaSheet}:D${filaSheet}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[decision, fecha]] },
    }));
  }
}

async function obtenerMapeos(req, res) {
  const sheets = getPacientesSheetsClient();
  const drive = getPacientesDriveClient();
  const mapeoId = await getOrCreateMapeoSheetId(sheets, drive);
  const mapeos = await leerMapeos(sheets, mapeoId);
  res.status(200).json(mapeos);
}

// ---------- Cumpleaños de hoy (/pacientes y /gestion, ver el pedido) ----------
// Mismo patrón que calcularDeuda() en admin.js: recorrer TODAS las fichas es la
// operación más lenta del panel, así que se lee solo C8 (fechaNacimiento, una celda
// por ficha) en lotes de 25 en paralelo, y se cachea en memoria del proceso 10 minutos
// (el cumpleaños de alguien no cambia en el medio de una sesión de trabajo).
// fechaNacimiento se guarda como texto "D/M/AAAA" (ver pacientes/index.html,
// fn-dia/fn-mes/fn-anio) — acá solo importan día y mes.
let cacheCumple = null; // { valor, ts }
const TTL_CUMPLE_MS = 600000;
async function calcularCumpleanosHoy(forzar) {
  if (!forzar && cacheCumple && Date.now() - cacheCumple.ts < TTL_CUMPLE_MS) return cacheCumple.valor;

  const [, hoyMesStr, hoyDiaStr] = formatArgDay(new Date()).split('-');
  const hoyMes = parseInt(hoyMesStr, 10);
  const hoyDia = parseInt(hoyDiaStr, 10);

  const resultado = [];
  try {
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();
    const archivos = await listarArchivosPacientes(drive);

    const LOTE = 25;
    for (let i = 0; i < archivos.length; i += LOTE) {
      const lote = aProcesar.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: f.id, range: `${SHEET_NAME}!C8` }));
          const fechaNac = String(data.values?.[0]?.[0] || '');
          const [diaStr, mesStr] = fechaNac.split('/');
          const dia = parseInt(diaStr, 10);
          const mes = parseInt(mesStr, 10);
          if (dia !== hoyDia || mes !== hoyMes) return null;
          const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
          return { id: f.id, nombre, apellido, dni };
        } catch (err) {
          console.warn(`[pacientes.js] no se pudo leer fechaNacimiento de ${f.name}:`, err?.message || err);
          return null;
        }
      }));
      resultados.forEach((r) => { if (r) resultado.push(r); });
    }
  } catch (err) {
    console.warn('[pacientes.js] no se pudo calcular cumpleaños de hoy:', err?.message || err);
  }

  cacheCumple = { valor: resultado, ts: Date.now() };
  return resultado;
}

async function cumpleanosHoy(req, res) {
  const lista = await calcularCumpleanosHoy(!!req.query.forzar);
  res.status(200).json(lista);
}

// "Más completo" = más palabras: y a igualdad de palabras, más caracteres. Sin lógica
// más sofisticada que esa, a propósito (ver el pedido).
function completitudNombre(nombreCompleto) {
  const palabras = (nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  return { palabras: palabras.length, longitud: (nombreCompleto || '').trim().length };
}
function esMasCompleto(a, b) {
  const ca = completitudNombre(a);
  const cb = completitudNombre(b);
  if (ca.palabras !== cb.palabras) return ca.palabras > cb.palabras;
  return ca.longitud > cb.longitud;
}

// Acción de "¿Es este paciente?" — Sí/No. Guarda la decisión de forma permanente (por
// teléfono+DNI, así no se vuelve a preguntar lo mismo) y, si es "Sí", corrige el nombre
// del lado que esté incompleto (ficha o turno) con el más completo de los dos. Se llama
// tanto al tocar el botón como, en silencio, cada vez que el mapeo ya guardado resuelve
// un match automático (ver pacientes/index.html) — es idempotente, no rompe nada
// repetirla con los mismos datos.
async function confirmarMatch(req, res) {
  const { eventId, calendarId, telefono, fichaId, dni, decision, turnoTitulo } = req.body;
  if (!fichaId || (decision !== 'si' && decision !== 'no')) {
    return res.status(400).json({ success: false, message: 'Datos incompletos.' });
  }

  try {
    const telNorm = normalizarTelefonoMapeo(telefono);
    const dniNorm = normalizarDni(dni);

    let mapeoGuardado = false;
    if (telNorm && dniNorm) {
      const sheetsMapeo = getPacientesSheetsClient();
      const driveMapeo = getPacientesDriveClient();
      const mapeoId = await getOrCreateMapeoSheetId(sheetsMapeo, driveMapeo);
      await guardarMapeo(sheetsMapeo, mapeoId, { telefono: telNorm, dni: dniNorm, decision });
      mapeoGuardado = true;
    }

    if (decision === 'si' && turnoTitulo) {
      const sheets = getPacientesSheetsClient();
      const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: fichaId, range: `${SHEET_NAME}!C5:C6` }));
      const [nombreFicha = '', apellidoFicha = ''] = (data.values || []).map((r) => r[0] || '');
      const nombreCompletoFicha = `${nombreFicha} ${apellidoFicha}`.trim();
      const turno = (turnoTitulo || '').trim();

      if (turno && esMasCompleto(turno, nombreCompletoFicha)) {
        const partes = turno.split(/\s+/);
        const nuevoNombre = partes.shift() || '';
        const nuevoApellido = partes.join(' ');
        await escribirCampoEnSheet(fichaId, 'nombre', nuevoNombre);
        await escribirCampoEnSheet(fichaId, 'apellido', nuevoApellido);
      } else if (nombreCompletoFicha && esMasCompleto(nombreCompletoFicha, turno) && eventId && calendarId) {
        const calendar = getCalendarClient();
        await conReintentos(() => calendar.events.patch({
          calendarId, eventId, requestBody: { summary: nombreCompletoFicha },
        }));
      }
    }

    res.status(200).json({ success: true, mapeoGuardado });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'confirmar-match', error: err });
    res.status(500).json({ success: false, message: 'No se pudo guardar la confirmación.' });
  }
}

// ---------- Escritura ----------

async function crearPaciente(req, res) {
  const { nombre, apellido, campos = {} } = req.body;
  if (!nombre || !nombre.trim() || !apellido || !apellido.trim()) {
    return res.status(400).json({ success: false, message: 'Nombre y apellido son obligatorios.' });
  }
  const resultado = await crearPacienteInterno({ nombre, apellido, campos });
  res.status(200).json(resultado);
}

// Lógica de creación, separada de crearPaciente (arriba) para que la pueda llamar
// también el flujo de recetas (ver más abajo): si una receta llega de un paciente que
// no tiene ficha todavía, se crea una automáticamente con lo que se pudo leer del PDF
// (ver el pedido, 2026-08-20) reusando este mismo camino, sin duplicar la lógica de
// copiar la plantilla / detectar duplicados por DNI / cargar los campos iniciales.
async function crearPacienteInterno({ nombre, apellido, campos = {} }) {
  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();

  // Detección de duplicados por DNI (ver decisions.md): nunca se crea una segunda ficha
  // con el mismo DNI — se ofrece abrir la existente en su lugar. Red de seguridad
  // server-side además del chequeo que ya hace el cliente contra la lista en memoria.
  const dniNormalizado = normalizarDni(campos.dni);
  if (dniNormalizado) {
    const existente = await buscarPacientePorDni(drive, dniNormalizado);
    if (existente) {
      return {
        success: false,
        duplicado: true,
        id: existente.id,
        nombre: existente.nombre,
        apellido: existente.apellido,
        message: 'Ya existe una ficha con este DNI.',
      };
    }
  }

  // El nombre de archivo usa la misma versión en Title Case que va a quedar en las
  // celdas C5/C6 — si no, la lista de /pacientes (que parsea el nombre del archivo)
  // mostraría algo distinto de lo que muestra la ficha abierta (celdas del Sheet).
  const nombreFinal = nombreArchivo({ nombre: aTituloCase(nombre), apellido: aTituloCase(apellido), dni: campos.dni });
  const copia = await conReintentos(() => drive.files.copy({
    fileId: FICHA_TEMPLATE_ID,
    requestBody: { name: nombreFinal, parents: [PACIENTES_FOLDER_ID] },
  }));
  let id = copia.data.id;

  // Idempotencia ante reintentos (mismo criterio que crearTurno en lib/googleCalendar.js):
  // si drive.files.copy() tira un error transitorio pero en realidad SÍ llegó a copiar el
  // archivo del lado del servidor, conReintentos() reintenta y termina copiando DOS veces.
  // Se detecta acá (buscando de nuevo por DNI, excluyendo la copia recién creada) y se
  // descarta la duplicada, quedándose con la primera que haya quedado registrada.
  if (dniNormalizado) {
    const otraExistente = await buscarPacientePorDni(drive, dniNormalizado, id);
    if (otraExistente) {
      await conReintentos(() => drive.files.update({ fileId: id, requestBody: { trashed: true } }));
      id = otraExistente.id;
      return { success: true, id, nombre: otraExistente.nombre, apellido: otraExistente.apellido };
    }
  }

  const datos = { ...campos, nombre, apellido };
  const campoACelda = (campo) => ({
    range: `${SHEET_NAME}!${CAMPO_CELDA[campo]}`,
    values: [[CAMPOS_MAYUSCULAS.has(campo) ? aTituloCase(datos[campo]) : datos[campo]]],
  });
  const tieneValor = (campo) => datos[campo] != null && String(datos[campo]).trim() !== '';
  // RAW para teléfono/nº de afiliado (ver escribirCampoEnSheet, mismo motivo: no perder
  // un 0 inicial), USER_ENTERED para el resto (fechas y DNI necesitan parseo real).
  const filasCrudas = CAMPOS_ORDENADOS.filter((c) => CAMPOS_TEXTO_CRUDO.has(c) && tieneValor(c)).map(campoACelda);
  const filasParseadas = CAMPOS_ORDENADOS.filter((c) => !CAMPOS_TEXTO_CRUDO.has(c) && tieneValor(c)).map(campoACelda);

  if (filasCrudas.length) {
    await conReintentos(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'RAW', data: filasCrudas },
    }));
  }
  if (filasParseadas.length) {
    await conReintentos(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'USER_ENTERED', data: filasParseadas },
    }));
  }

  // Best-effort, ver lib/pacientesConsolidados.js (nunca tira) — se espera (await) antes
  // de responder porque una función serverless puede congelarse apenas se manda la
  // respuesta, así que un "fire and forget" acá se arriesgaría a cortarse a la mitad.
  await upsertPacienteConsolidado({
    telefono: datos.telefono, nombre, apellido, dni: datos.dni, fichaId: id, origen: 'ficha',
  });

  return { success: true, id, nombre, apellido };
}

async function actualizarCampo(req, res) {
  const { id, campo, valor } = req.body;
  if (!id || !campo || !CAMPO_CELDA[campo]) {
    return res.status(400).json({ success: false, message: 'Campo inválido.' });
  }

  try {
    await escribirCampoEnSheet(id, campo, valor);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'actualizar-campo', { campo, valor });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: `actualizar-campo (${campo}), respaldado`, error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

// RAW para teléfono, nº de afiliado y fecha de nacimiento: con USER_ENTERED, Sheets los
// interpretaría y convertiría — se comería un 0 inicial (ej. un fijo con característica
// "011") o convertiría la fecha a serial de fecha (la celda C8 tiene formato de fecha en
// la plantilla), y al releerla devolvería un formato variable tipo "7/7/2026" sin pad,
// que el select de mes del frontend no podía rellenar (bug "el mes de nacimiento
// aparece borrado", reportado el 2026-08-24 — ver pacientes/index.html, renderFicha).
// No hay ninguna fórmula que dependa de que estas celdas sean numéricas/fecha, así que
// se guardan tal cual se tipearon.
const CAMPOS_TEXTO_CRUDO = new Set(['telefono', 'nAfiliado', 'fechaNacimiento']);

async function escribirCampoEnSheet(id, campo, valor) {
  const sheets = getPacientesSheetsClient();
  const valorFinal = CAMPOS_MAYUSCULAS.has(campo) ? aTituloCase(valor) : valor;
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!${CAMPO_CELDA[campo]}`,
    valueInputOption: CAMPOS_TEXTO_CRUDO.has(campo) ? 'RAW' : 'USER_ENTERED',
    requestBody: { values: [[valorFinal ?? '']] },
  }));

  if (campo === 'nombre' || campo === 'apellido' || campo === 'dni' || campo === 'telefono') {
    // C14 (teléfono) se lee siempre acá, aunque no haya cambiado, porque
    // upsertPacienteConsolidado() necesita la identidad completa de la fila (no solo el
    // campo que se acaba de tocar) para no pisar los otros con vacío por accidente.
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C7` }));
    const [nombre = '', apellido = '', dni = ''] = (data.values || []).map((r) => r[0] || '');
    let telefono = valorFinal;
    if (campo !== 'telefono') {
      const { data: dataTel } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C14` }));
      telefono = dataTel.values?.[0]?.[0] || '';
    }
    if (campo === 'nombre' || campo === 'apellido' || campo === 'dni') {
      const drive = getPacientesDriveClient();
      await conReintentos(() => drive.files.update({ fileId: id, requestBody: { name: nombreArchivo({ nombre, apellido, dni }) } }));
    }
    await upsertPacienteConsolidado({ telefono, nombre, apellido, dni, fichaId: id, origen: 'ficha' });
  }
}

// Traba de seguridad (ver el pedido, 2026-08-20 — endurecimiento tras el incidente de
// Karen Schneider): justo antes de escribir un movimiento/prestación NUEVO en una fila,
// confirma que esa fila realmente está vacía en las 4 columnas relevantes — releída
// fresca del Sheet (no reusa la lectura que sirvió para calcular primeraFilaLibre), para
// acortar al máximo la ventana entre "decidir dónde escribir" y "escribir de verdad". Si
// la fila tiene datos, tira un error claro en vez de dejar que se pise en silencio.
// Pensada como red de seguridad genérica ante CUALQUIER futuro bug de lógica parecido a
// éste — no asume que la única causa posible sea primeraFilaLibre(). Quien llama a esto
// NO debe reintentar ciegamente contra la misma fila: repetiría el mismo pisado.
//
// 2026-08-24: "vacía" ahora se decide con esCeldaConDatoReal() (mismo criterio que
// primeraFilaLibre en lib/pacientesSheet.js), para que la contaminación 'FALSE'/'TRUE'
// string de la validación de casilla mal aplicada no se interprete como datos cargados
// (bug "La fila 2001 ya tiene datos cargados"). Además valida que la fila esté DENTRO
// del rango permitido (18..2000) — una fila fuera de rango nunca es una fila válida para
// escribir, sin importar lo que contenga.
async function confirmarFilaLibre(sheets, id, fila, esPrestacion) {
  if (!Number.isInteger(fila) || fila < MOVIMIENTOS_FILA_INICIO || fila > MOVIMIENTOS_FILA_FIN) {
    throw new Error('No hay filas libres dentro del rango de la ficha. Avisale a Fausto para revisar la ficha.');
  }
  const rango = esPrestacion ? `${SHEET_NAME}!J${fila}:M${fila}` : `${SHEET_NAME}!B${fila}:E${fila}`;
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rango }));
  const [col1, col2, col3, col4] = (data.values && data.values[0]) || [];
  const vacia = !esCeldaConDatoReal(col1) && !esCeldaConDatoReal(col2) && !esCeldaConDatoReal(col3) && !esCeldaConDatoReal(col4);
  if (!vacia) {
    throw new Error(`La fila ${fila} tiene datos cargados y no se puede sobrescribir. Avisale a Fausto para revisar la ficha.`);
  }
}

// ---------- Fusión manual de fichas duplicadas (por DNI, ver decisions.md) ----------
// El sistema NUNCA decide solo cuál ficha mantener ni cómo resolver un dato
// contradictorio entre las dos — todo eso ya viene resuelto por la secretaria desde el
// frontend (comparación campo a campo, "cuál ficha mantener", conflictos resueltos a
// mano). Esta función solo ejecuta la consolidación ya decidida: escribe los campos
// finales en la ficha que se mantiene, migra TODOS los movimientos y prestaciones de la
// ficha que se va a la que queda, y manda la ficha vieja a la papelera de Drive (no se
// borra para siempre — se puede recuperar a mano desde Drive si hace falta).
async function fusionarPacientes(req, res) {
  const { idMantener, idEliminar, campos } = req.body;
  if (!idMantener || !idEliminar || idMantener === idEliminar) {
    return res.status(400).json({ success: false, message: 'Fichas inválidas para fusionar.' });
  }

  const sheets = getPacientesSheetsClient();
  const drive = getPacientesDriveClient();

  // 1. Campos finales (ya resueltos a mano) en la ficha que se mantiene.
  if (campos) {
    for (const campo of CAMPOS_ORDENADOS) {
      if (campos[campo] != null) {
        await escribirCampoEnSheet(idMantener, campo, campos[campo]);
      }
    }
  }

  // 2. Migrar movimientos de la ficha que se va, al final de los que ya tiene la que queda.
  const { data: movData } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: idEliminar, range: rangoMovimientos() }));
  const movimientos = (movData.values || []).filter((row) => row[0] || row[1] || row[2] || row[3]);
  if (movimientos.length) {
    const { data: destinoMov } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: idMantener, range: rangoMovimientos() }));
    let fila = primeraFilaLibre(destinoMov.values || []);
    for (const row of movimientos) {
      const [fecha, tratamiento, debe, haber, , , formaPago] = row;
      await confirmarFilaLibre(sheets, idMantener, fila, false);
      await escribirMovimientoEnFila(idMantener, fila, { fecha, tratamiento, debe, haber, formaPago });
      fila += 1;
    }
  }

  // 3. Migrar prestaciones de obra social, mismo criterio.
  const { data: presData } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: idEliminar, range: rangoPrestacionesObraSocial() }));
  const prestaciones = (presData.values || []).filter((row) => row[0] || row[1] || row[2]);
  if (prestaciones.length) {
    const { data: destinoPres } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: idMantener, range: rangoPrestacionesObraSocial() }));
    let filaP = primeraFilaLibre(destinoPres.values || []);
    for (const row of prestaciones) {
      const [fecha, tratamiento, codigo, autorizado] = row;
      await confirmarFilaLibre(sheets, idMantener, filaP, true);
      await escribirPrestacionEnFila(idMantener, filaP, { fecha, tratamiento, codigo, autorizado: autorizado === true || autorizado === 'TRUE' });
      filaP += 1;
    }
  }

  // 4. La ficha duplicada va a la papelera (reversible desde Drive), nunca borrado permanente.
  await conReintentos(() => drive.files.update({ fileId: idEliminar, requestBody: { trashed: true } }));

  res.status(200).json({ success: true, id: idMantener });
}

async function movimientoAgregar(req, res) {
  const { id, fecha, tratamiento, debe, haber, formaPago } = req.body;
  // Fecha obligatoria para movimientos NUEVOS (ver el pedido, 2026-08-20) — elimina la
  // posibilidad de que exista una fila con datos reales pero sin fecha, que fue
  // justamente el patrón que causó el incidente de Karen Schneider. No aplica a editar
  // (movimientoEditar) ni a los movimientos viejos ya cargados sin fecha, que quedan
  // protegidos por el fix de primeraFilaLibre() sin necesitar migración.
  if (!id || !fecha || !String(fecha).trim()) return res.status(400).json({ success: false, message: 'Falta fecha.' });

  const sheets = getPacientesSheetsClient();
  let fila;
  try {
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoMovimientos() }));
    fila = primeraFilaLibre(data.values || []);
    await confirmarFilaLibre(sheets, id, fila, false);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'movimiento-agregar: traba de seguridad', error: err });
    return res.status(200).json({ success: false, message: err.message });
  }

  try {
    await escribirMovimientoEnFila(id, fila, { fecha, tratamiento, debe, haber, formaPago });
    res.status(200).json({ success: true, fila });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'movimiento-agregar', { fecha, tratamiento, debe, haber, formaPago });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'movimiento-agregar, respaldado', error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function movimientoEditar(req, res) {
  const { id, fila, fecha, tratamiento, debe, haber, formaPago } = req.body;
  if (!id || !fila) return res.status(400).json({ success: false, message: 'Falta fila.' });

  try {
    await escribirMovimientoEnFila(id, fila, { fecha, tratamiento, debe, haber, formaPago });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'movimiento-editar', { fila, fecha, tratamiento, debe, haber, formaPago });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'movimiento-editar, respaldado', error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function escribirMovimientoEnFila(id, fila, { fecha, tratamiento, debe, haber, formaPago }) {
  const sheets = getPacientesSheetsClient();
  await asegurarColumnaFormaPago(id);
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!B${fila}:E${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, aTituloCase(tratamiento) || '', debe || 0, haber || 0]] },
  }));
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!H${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[aMayusculas(formaPago) || '']] },
  }));
}

// Lógica compartida de anulación: relee la fila y, si todavía no está anulada, la marca
// "[ANULADO] ..." (conservando los montos originales en el texto) y pone Debe/Haber en 0
// para que deje de afectar el saldo (las fórmulas de Saldo se recalculan solas, ver
// pacientesSheet.js). Devuelve true si anuló, false si ya estaba anulada (no toca nada).
// La usan movimientoAnular (handler, con respaldo de emergencia) y movimientoAnularInterno
// (recuperación de respaldos, el llamador maneja el error) — refactor 2026-08-24 para no
// duplicar el cuerpo en los dos.
async function anularMovimientoEnSheet(sheets, id, fila) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({
    spreadsheetId: id, range: `${SHEET_NAME}!B${fila}:E${fila}`,
  }));
  const [fecha = '', tratamiento = '', debe = 0, haber = 0] = (data.values && data.values[0]) || [];
  if (/^\[ANULADO\]/.test(tratamiento)) return false; // ya estaba anulado, no hace nada
  const nuevoTexto = `[ANULADO] ${tratamiento} (era: Debe $${debe || 0} / Haber $${haber || 0})`;
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!B${fila}:E${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, nuevoTexto, 0, 0]] },
  }));
  return true;
}

// Nunca se borra un movimiento físicamente: se marca "[ANULADO]" en el texto (con los
// montos originales, para no perder el dato) y se ponen Debe/Haber en 0 para que deje de
// afectar el saldo (las fórmulas de Saldo sí se recalculan solas, ver pacientesSheet.js).
async function movimientoAnular(req, res) {
  const { id, fila } = req.body;
  if (!id || !fila) return res.status(400).json({ success: false, message: 'Falta fila.' });

  try {
    const sheets = getPacientesSheetsClient();
    await anularMovimientoEnSheet(sheets, id, fila);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'movimiento-anular', { fila });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'movimiento-anular, respaldado', error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

// ---------- Estado de prestaciones a obra social ----------
// Tabla aparte (columnas J-M, misma fila de arranque que movimientos) — Obra
// social/Nº de afiliado/Plan viven en C11/C12/C13 (CAMPO_CELDA, vía actualizar-campo),
// L14/L15/L16 son solo fórmulas espejo dentro del propio Sheet, nunca se les escribe acá.
// Sin lógica de saldo — a diferencia de movimientos, "eliminar" borra de verdad la fila
// (no hace falta "anular": no hay ningún total que dependa de estos datos).

async function prestacionAgregar(req, res) {
  const { id, fecha, tratamiento, codigo, autorizado } = req.body;
  if (!id || !fecha || !String(fecha).trim()) return res.status(400).json({ success: false, message: 'Falta fecha.' });

  const sheets = getPacientesSheetsClient();
  let fila;
  try {
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoPrestacionesObraSocial() }));
    fila = primeraFilaLibre(data.values || []);
    await confirmarFilaLibre(sheets, id, fila, true);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'prestacion-agregar: traba de seguridad', error: err });
    return res.status(200).json({ success: false, message: err.message });
  }

  try {
    await escribirPrestacionEnFila(id, fila, { fecha, tratamiento, codigo, autorizado });
    res.status(200).json({ success: true, fila });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'prestacion-agregar', { fecha, tratamiento, codigo, autorizado });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'prestacion-agregar, respaldado', error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function prestacionEditar(req, res) {
  const { id, fila, fecha, tratamiento, codigo, autorizado } = req.body;
  if (!id || !fila) return res.status(400).json({ success: false, message: 'Falta fila.' });

  try {
    await escribirPrestacionEnFila(id, fila, { fecha, tratamiento, codigo, autorizado });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'prestacion-editar', { fila, fecha, tratamiento, codigo, autorizado });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'prestacion-editar, respaldado', error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function prestacionEliminar(req, res) {
  const { id, fila } = req.body;
  if (!id || !fila) return res.status(400).json({ success: false, message: 'Falta fila.' });

  try {
    await escribirPrestacionEnFila(id, fila, { fecha: '', tratamiento: '', codigo: '', autorizado: false });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'prestacion-eliminar', { fila });
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'prestacion-eliminar, respaldado', error: err });
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function escribirPrestacionEnFila(id, fila, { fecha, tratamiento, codigo, autorizado }) {
  const sheets = getPacientesSheetsClient();
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!J${fila}:M${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha || '', aMayusculas(tratamiento) || '', aMayusculas(codigo) || '', !!autorizado]] },
  }));
}

async function asegurarColumnaFormaPago(id) {
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!H17` }));
  if ((data.values || [[]])[0]?.[0] === 'Forma de pago') return;

  const meta = await conReintentos(() => sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' }));
  const sheetId = meta.data.sheets[0].properties.sheetId;

  await conReintentos(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: FORMA_PAGO_COLUMN_INDEX, endIndex: FORMA_PAGO_COLUMN_INDEX + 1 },
            properties: { hiddenByUser: false },
            fields: 'hiddenByUser',
          },
        },
      ],
    },
  }));
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!H17`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Forma de pago']] },
  }));
}

// ---------- Fotos de pacientes (/mobilephotouploaderodfrancovinzon) ----------
// Carpeta propia (no la del paciente — las fichas son un Sheet, no un lugar donde
// meter binarios) con un archivo por foto: nombre "{pacienteId}__{timestamp}.jpg",
// la descripción de la foto va en el campo `description` nativo de Drive (no hace
// falta una hoja de metadata aparte). Se auto-crea la primera vez, mismo patrón que
// getOrCreateBackupFolderId de acá abajo.
const FOTOS_FOLDER_NAME = 'Fotos de pacientes (no tocar)';
const FOTO_MAX_BYTES = 4 * 1024 * 1024; // margen bajo el límite real de Vercel (4.5MB), ver decisions.md

async function getOrCreateFotosFolderId(drive) {
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${FOTOS_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) return data.files[0].id;
  const creada = await conReintentos(() => drive.files.create({
    requestBody: { name: FOTOS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [PACIENTES_FOLDER_ID] },
    fields: 'id',
  }));
  return creada.data.id;
}

async function listarFotos(req, res) {
  const pacienteId = req.query.id;
  if (!pacienteId) return res.status(400).json({ error: 'Falta id.' });
  try {
    const drive = getPacientesDriveClient();
    const folderId = await getOrCreateFotosFolderId(drive);
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${folderId}' in parents and name contains '${pacienteId}__' and trashed = false`,
      fields: 'files(id, name, description, createdTime)',
      orderBy: 'createdTime desc',
    }));
    const fotos = (data.files || [])
      .filter((f) => f.name.startsWith(`${pacienteId}__`)) // "contains" de Drive es difuso, confirmar el prefijo exacto
      .map((f) => ({ id: f.id, descripcion: f.description || '', fecha: f.createdTime }));
    res.status(200).json(fotos);
  } catch (err) {
    console.error(err);
    res.status(200).json([]); // nunca romper la vista de fotos por un error de Drive
  }
}

async function servirFotoImagen(req, res) {
  const fotoId = req.query.fotoId;
  if (!fotoId) return res.status(400).send('Falta fotoId.');
  try {
    const drive = getPacientesDriveClient();
    const { data } = await conReintentos(() => drive.files.get(
      { fileId: fotoId, alt: 'media' },
      { responseType: 'arraybuffer' }
    ));
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.status(200).send(Buffer.from(data));
  } catch (err) {
    console.error(err);
    res.status(404).send('No se pudo cargar la foto.');
  }
}

// `fotoBase64` es un data URL completo ("data:image/jpeg;base64,...") armado del lado
// del cliente después de comprimir la imagen en un <canvas> — nunca se sube el
// archivo original de la cámara tal cual (varios MB, pasaría el límite de 4.5MB de
// Vercel para el body de una función serverless, ver CLAUDE.md/decisions.md).
async function subirFoto(req, res) {
  const { pacienteId, fotoBase64, descripcion } = req.body;
  if (!pacienteId || !fotoBase64) {
    return res.status(400).json({ success: false, message: 'Faltan datos.' });
  }
  try {
    const base64Data = String(fotoBase64).replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > FOTO_MAX_BYTES) {
      return res.status(200).json({ success: false, message: 'La foto es demasiado pesada. Probá de nuevo (se comprime sola, puede ser un problema puntual).' });
    }

    const drive = getPacientesDriveClient();
    const folderId = await getOrCreateFotosFolderId(drive);
    const nombre = `${pacienteId}__${Date.now()}.jpg`;
    const creada = await conReintentos(() => drive.files.create({
      requestBody: {
        name: nombre,
        parents: [folderId],
        description: (descripcion || '').slice(0, 500),
      },
      media: { mimeType: 'image/jpeg', body: bufferToStream(buffer) },
      fields: 'id',
    }));
    res.status(200).json({ success: true, id: creada.data.id });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'subir-foto', error: err });
    res.status(200).json({ success: false, message: 'No se pudo subir la foto. Probá de nuevo.' });
  }
}

// Borrar una foto vieja/repetida (ver el pedido, 2026-08-13) — SIN clave, mismo nivel
// de exposición ya aceptado para toda esta página: el fotoId es un ID de Drive (largo,
// no adivinable), así que la única forma de borrar una foto puntual es ya tenerla
// cargada en pantalla (acá o en /pacientes, que reusa este mismo endpoint). No hay
// papelera propia ni falta hace — son fotos de trabajo, no fichas.
async function eliminarFoto(req, res) {
  const { fotoId } = req.body;
  if (!fotoId) return res.status(400).json({ success: false, message: 'Falta fotoId.' });
  try {
    const drive = getPacientesDriveClient();
    await conReintentos(() => drive.files.delete({ fileId: fotoId }));
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'eliminar-foto', error: err });
    res.status(200).json({ success: false, message: 'No se pudo borrar la foto. Probá de nuevo.' });
  }
}

// ---------- Backup de emergencia (Sheets caído) ----------
// No bloquea al usuario: si escribir en el Sheet falla, el cambio se guarda como JSON en
// una carpeta aparte dentro de "Pacientes" y se reintenta solo la próxima vez que se abre
// esa misma ficha (intentarRecuperarRespaldos, arriba en obtenerFicha). No hay cron en
// este proyecto (sitio estático + serverless, ver CLAUDE.md) — el reintento "oportunista"
// en el próximo acceso es la forma de lograr esto sin sumar infraestructura nueva.
async function getOrCreateBackupFolderId(drive) {
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) return data.files[0].id;
  const creada = await conReintentos(() => drive.files.create({
    requestBody: { name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [PACIENTES_FOLDER_ID] },
    fields: 'id',
  }));
  return creada.data.id;
}

async function respaldarCambioFallido(pacienteId, accion, payload) {
  try {
    const drive = getPacientesDriveClient();
    const folderId = await getOrCreateBackupFolderId(drive);
    const nombre = `${pacienteId}__${Date.now()}.json`;
    await conReintentos(() => drive.files.create({
      requestBody: { name: nombre, parents: [folderId] },
      media: { mimeType: 'application/json', body: JSON.stringify({ pacienteId, accion, payload, creado: new Date().toISOString() }) },
    }));
  } catch (err) {
    // Si hasta el respaldo falla (Drive también caído), no hay más nada que hacer del
    // lado del servidor — el error ya se logueó en el catch de quien llamó a esta función.
    console.error('No se pudo guardar el respaldo de emergencia', err);
  }
}

async function intentarRecuperarRespaldos(sheets, drive, pacienteId) {
  let folderId;
  try {
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
    }));
    if (!data.files || !data.files.length) return; // no hay carpeta de respaldo todavía, nada pendiente
    folderId = data.files[0].id;
  } catch {
    return;
  }

  const { data: pendientes } = await conReintentos(() => drive.files.list({
    q: `'${folderId}' in parents and name contains '${pacienteId}__' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name',
  }));
  if (!pendientes.files || !pendientes.files.length) return;

  for (const archivo of pendientes.files) {
    try {
      const contenido = await conReintentos(() => drive.files.get({ fileId: archivo.id, alt: 'media' }));
      const { accion, payload } = contenido.data;
      if (accion === 'actualizar-campo') {
        await escribirCampoEnSheet(pacienteId, payload.campo, payload.valor);
      } else if (accion === 'movimiento-agregar') {
        const { data: mov } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: pacienteId, range: rangoMovimientos() }));
        const fila = primeraFilaLibre(mov.values || []);
        await confirmarFilaLibre(sheets, pacienteId, fila, false);
        await escribirMovimientoEnFila(pacienteId, fila, payload);
      } else if (accion === 'movimiento-editar') {
        await escribirMovimientoEnFila(pacienteId, payload.fila, payload);
      } else if (accion === 'movimiento-anular') {
        await movimientoAnularInterno(pacienteId, payload.fila);
      } else if (accion === 'prestacion-agregar') {
        const { data: pres } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: pacienteId, range: rangoPrestacionesObraSocial() }));
        const fila = primeraFilaLibre(pres.values || []);
        await confirmarFilaLibre(sheets, pacienteId, fila, true);
        await escribirPrestacionEnFila(pacienteId, fila, payload);
      } else if (accion === 'prestacion-editar') {
        await escribirPrestacionEnFila(pacienteId, payload.fila, payload);
      } else if (accion === 'prestacion-eliminar') {
        await escribirPrestacionEnFila(pacienteId, payload.fila, { fecha: '', tratamiento: '', codigo: '', autorizado: false });
      }
      await conReintentos(() => drive.files.delete({ fileId: archivo.id }));
    } catch (err) {
      console.error('No se pudo recuperar un respaldo pendiente, se reintenta en el próximo acceso', err);
      // Si la traba de seguridad (confirmarFilaLibre) es la que frenó esto, reintentar
      // en el próximo acceso va a fallar exactamente igual para siempre — vale la pena
      // que Fausto se entere en vez de que quede reintentando en silencio.
      await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: `intentarRecuperarRespaldos: ${archivo.name}`, error: err });
    }
  }
}

async function movimientoAnularInterno(id, fila) {
  const sheets = getPacientesSheetsClient();
  await anularMovimientoEnSheet(sheets, id, fila);
}

// ---------- Recetas (capa de presentación sobre una receta ya emitida en MisRX/RCTA,
// ver decisions.md) ----------
// pdf-parse (texto estándar de un PDF) se probó primero y no sirvió: el PDF de MisRX no
// tiene una capa de texto extraíble (confirmado en producción, 2026-08-20 — pdf-parse
// encontraba las 2 páginas pero devolvía ~0 texto real). El OCR nativo de Drive sí
// funciona muy bien acá: subir el PDF convirtiéndolo a Google Doc (mimeType
// application/vnd.google-apps.document + ocrLanguage) hace que Drive le corra OCR solo
// — reusa el mismo cliente OAuth ya autorizado para todo /pacientes, sin sumar una
// librería de OCR pesada a la función serverless. El Google Doc temporal se borra
// apenas se exporta el texto, no queda rastro en Drive.
const RECETA_MAX_BYTES = 4 * 1024 * 1024; // mismo margen que las fotos, ver decisions.md
const RECETAS_FOLDER_NAME = 'Recetas de pacientes (no tocar)';

function tokensNombre(s) {
  return normalizarTexto(s || '').split(/\s+/).filter(Boolean);
}

// Regla del pedido: "si hay una coincidencia clara, asociarla sola; si hay más de una
// posible coincidencia o ninguna, preguntarle a Franco cuál es". El DNI extraído del PDF
// es el criterio más confiable (mismo criterio que usa el resto del proyecto para
// detectar duplicados, ver normalizarDni en pacientesSheet.js) así que se prueba primero
// y gana solo si matchea una única ficha; el nombre es el respaldo cuando no hay DNI
// legible o no matcheó ninguna ficha por DNI.
async function buscarCoincidenciasPaciente(drive, { paciente, dni }) {
  const archivos = await listarArchivosPacientes(drive);
  const candidatos = archivos.map((f) => {
    const { nombre, apellido, dni: dniFicha } = parsearNombreArchivo(f.name);
    return { id: f.id, nombre, apellido, dni: dniFicha };
  });

  const dniNorm = dni ? normalizarDni(dni) : '';
  if (dniNorm) {
    const porDni = candidatos.filter((p) => normalizarDni(p.dni) === dniNorm);
    if (porDni.length === 1) return { automatico: porDni[0], candidatos: [] };
  }

  const tokensReceta = tokensNombre(paciente);
  if (tokensReceta.length) {
    const porNombre = candidatos.filter((p) => {
      const tokensFicha = tokensNombre(`${p.nombre} ${p.apellido}`);
      return tokensReceta.every((t) => tokensFicha.includes(t)) || tokensFicha.every((t) => tokensReceta.includes(t));
    });
    if (porNombre.length === 1) return { automatico: porNombre[0], candidatos: [] };
    if (porNombre.length > 1) return { automatico: null, candidatos: porNombre.slice(0, 10) };
  }

  return { automatico: null, candidatos: [] };
}

// Solo procesa: OCR + parseo + intento de match de paciente. NO guarda nada todavía —
// eso pasa en guardarReceta, después de que Franco confirmó/corrigió los campos en la
// vista previa (ver el pedido: supervisión humana obligatoria, nunca guardar directo).
// Decodifica y valida el PDF entrante — compartido por el flujo de /pacientes
// (procesarRecetaPdf) y el del Atajo de iOS (recibirRecetaShortcut).
function decodificarPdfBase64(pdfBase64) {
  const buffer = Buffer.from(String(pdfBase64).replace(/^data:application\/pdf;base64,/, ''), 'base64');
  if (!buffer.length) throw new Error('El archivo no es un PDF válido.');
  if (buffer.length > RECETA_MAX_BYTES) throw new Error('El PDF es demasiado pesado.');
  return buffer;
}

// OCR (Drive) + parseo + intento de match de paciente — el núcleo común de
// procesarRecetaPdf (llamado desde /pacientes, con la ficha ya abierta) y
// recibirRecetaShortcut (llamado desde el Atajo de iOS, sin ficha de contexto).
async function ocrYParsearReceta(drive, buffer) {
  let docId;
  try {
    const creado = await conReintentos(() => drive.files.create({
      requestBody: { name: `__receta-ocr-temp-${Date.now()}`, mimeType: 'application/vnd.google-apps.document' },
      media: { mimeType: 'application/pdf', body: bufferToStream(buffer) },
      ocrLanguage: 'es',
      fields: 'id',
    }));
    docId = creado.data.id;
    // El OCR de texto (arriba) y la lectura del QR de firma electrónica (acá) leen el
    // mismo PDF por caminos separados — el OCR nunca "ve" el QR como texto (es una
    // imagen), así que ese link solo se puede sacar renderizando la página y
    // decodificando el QR directo del buffer original, ver lib/recetaFirmaQr.js.
    const [exportado, firmaElectronicaUrl] = await Promise.all([
      conReintentos(() => drive.files.export({ fileId: docId, mimeType: 'text/plain' }, { responseType: 'text' })),
      extraerUrlFirmaElectronica(buffer),
    ]);

    const receta = { ...parsearReceta(exportado.data), firmaElectronicaUrl };
    const { automatico, candidatos } = await buscarCoincidenciasPaciente(drive, { paciente: receta.paciente, dni: receta.dni });

    return { receta, camposFaltantes: camposFaltantes(receta), matchAutomatico: automatico, candidatos };
  } finally {
    if (docId) { try { await drive.files.delete({ fileId: docId }); } catch { /* limpieza best-effort */ } }
  }
}

async function procesarRecetaPdf(req, res) {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ success: false, message: 'Falta el PDF.' });

  let buffer;
  try {
    buffer = decodificarPdfBase64(pdfBase64);
  } catch (err) {
    return res.status(200).json({ success: false, message: err.message });
  }

  try {
    const drive = getPacientesDriveClient();
    const resultado = await ocrYParsearReceta(drive, buffer);
    res.status(200).json({ success: true, ...resultado });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'receta-procesar-pdf', error: err });
    res.status(200).json({ success: false, message: 'No se pudo leer el PDF. Probá de nuevo.' });
  }
}

async function getOrCreateRecetasFolderId(drive) {
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${RECETAS_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) return data.files[0].id;
  const creada = await conReintentos(() => drive.files.create({
    requestBody: { name: RECETAS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [PACIENTES_FOLDER_ID] },
    fields: 'id',
  }));
  return creada.data.id;
}

async function listarRecetas(req, res) {
  const pacienteId = req.query.id;
  if (!pacienteId) return res.status(400).json({ error: 'Falta id.' });
  try {
    const drive = getPacientesDriveClient();
    const folderId = await getOrCreateRecetasFolderId(drive);
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${folderId}' in parents and name contains '${pacienteId}__' and trashed = false`,
      fields: 'files(id, name, description, createdTime)',
      orderBy: 'createdTime desc',
    }));
    const recetas = (data.files || [])
      .filter((f) => f.name.startsWith(`${pacienteId}__`)) // "contains" de Drive es difuso, confirmar el prefijo exacto
      .map((f) => ({ id: f.id, descripcion: f.description || '', fecha: f.createdTime }));
    res.status(200).json(recetas);
  } catch (err) {
    console.error(err);
    res.status(200).json([]); // nunca romper la vista de recetas por un error de Drive
  }
}

async function servirRecetaPdf(req, res) {
  const recetaId = req.query.recetaId;
  if (!recetaId) return res.status(400).send('Falta recetaId.');
  try {
    const drive = getPacientesDriveClient();
    const { data } = await conReintentos(() => drive.files.get(
      { fileId: recetaId, alt: 'media' },
      { responseType: 'arraybuffer' }
    ));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.status(200).send(Buffer.from(data));
  } catch (err) {
    console.error(err);
    res.status(404).send('No se pudo cargar la receta.');
  }
}

// Genera el PDF final con la marca del consultorio y lo guarda en el historial de la
// ficha — recién acá queda "confirmada" la receta (después de que Franco la revisó en
// la vista previa). `receta` viene con los campos ya editados/confirmados del lado del
// cliente, no necesariamente igual a lo que devolvió procesarRecetaPdf.
//
// `pacienteId` viene seteado cuando se llama desde una ficha ya abierta (/pacientes).
// `crearNuevo` viene en su lugar cuando se llama desde el flujo del Atajo de iOS y no se
// encontró ninguna ficha parecida (ver el pedido, 2026-08-20): se crea una ficha nueva
// con lo que se pudo leer del PDF (nombre/apellido/dni) antes de guardar la receta ahí.
// `codigoProceso`, si viene, borra el borrador temporal de Drive una vez guardado.
async function guardarReceta(req, res) {
  const { pacienteId: pacienteIdBody, crearNuevo, receta, codigoProceso } = req.body;
  if ((!pacienteIdBody && !crearNuevo) || !receta) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  try {
    const sheets = getPacientesSheetsClient();
    const drive = getPacientesDriveClient();

    let pacienteId = pacienteIdBody;
    let fichaCreada = null;
    if (!pacienteId && crearNuevo) {
      const resultadoCreacion = await crearPacienteInterno({
        nombre: crearNuevo.nombre || '',
        apellido: crearNuevo.apellido || '',
        campos: { dni: crearNuevo.dni || '' },
      });
      if (!resultadoCreacion.success && !resultadoCreacion.duplicado) {
        return res.status(200).json({ success: false, message: resultadoCreacion.message || 'No se pudo crear la ficha del paciente.' });
      }
      pacienteId = resultadoCreacion.id;
      fichaCreada = { nombre: resultadoCreacion.nombre, apellido: resultadoCreacion.apellido, yaExistia: !!resultadoCreacion.duplicado };
    }

    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: pacienteId, range: `${SHEET_NAME}!C5:C15` }));
    const c = (data.values || []).map((r) => (r[0] != null ? String(r[0]) : ''));
    while (c.length < 4) c.push('');
    const [nombre, apellido, dni, fechaNacimiento] = c;

    const pdfBuffer = await generarPdfReceta({ paciente: { nombre, apellido, dni, fechaNacimiento }, receta });

    const folderId = await getOrCreateRecetasFolderId(drive);
    const descripcion = [receta.fechaReceta, (receta.medicamentos || []).map((m) => m.descripcion).filter(Boolean).join('; ')]
      .filter(Boolean).join(' — ').slice(0, 500);
    const creada = await conReintentos(() => drive.files.create({
      requestBody: {
        name: `${pacienteId}__${Date.now()}.pdf`,
        parents: [folderId],
        description: descripcion,
      },
      media: { mimeType: 'application/pdf', body: bufferToStream(pdfBuffer) },
      fields: 'id',
    }));

    if (codigoProceso) await borrarRecetaProceso(drive, codigoProceso);

    res.status(200).json({ success: true, id: creada.data.id, pacienteId, fichaCreada });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'receta-guardar', error: err });
    res.status(200).json({ success: false, message: 'No se pudo guardar la receta. Probá de nuevo.' });
  }
}

// ---------- Recetas "en proceso" (borradores para el Atajo de iOS, ver el pedido,
// 2026-08-20) ----------
// iOS/Safari no soporta Web Share Target (confirmado por el usuario — limitación real
// de Apple, no hay forma de que nuestra app aparezca en el menú de Compartir nativo).
// En su lugar, un Atajo de iOS manda el PDF acá por POST y recibe una URL de vuelta —
// como esa URL la abre Safari en una pestaña nueva sin ningún estado compartido con
// esta función serverless, el resultado del OCR/parseo se guarda unos minutos en Drive
// (mismo criterio "carpeta (no tocar)" que el resto del proyecto) para que esa página
// lo pueda leer por su cuenta. Se borra apenas se guarda la receta final, y cualquier
// borrador de más de 48hs que haya quedado huérfano (Franco no llegó a confirmarlo) se
// limpia solo, oportunista, la próxima vez que se crea uno nuevo — mismo patrón que la
// carpeta de respaldos de emergencia (ver getOrCreateBackupFolderId).
const RECETAS_PROCESO_FOLDER_NAME = 'Recetas en proceso (no tocar)';
const RECETA_PROCESO_TTL_MS = 48 * 60 * 60 * 1000;

async function getOrCreateRecetasProcesoFolderId(drive) {
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${RECETAS_PROCESO_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) return data.files[0].id;
  const creada = await conReintentos(() => drive.files.create({
    requestBody: { name: RECETAS_PROCESO_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [PACIENTES_FOLDER_ID] },
    fields: 'id',
  }));
  return creada.data.id;
}

async function limpiarRecetasProcesoVencidas(drive, folderId) {
  try {
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, createdTime)',
    }));
    const vencidos = (data.files || []).filter((f) => Date.now() - new Date(f.createdTime).getTime() > RECETA_PROCESO_TTL_MS);
    await Promise.allSettled(vencidos.map((f) => drive.files.delete({ fileId: f.id })));
  } catch {
    // limpieza best-effort, nunca debe romper el flujo principal
  }
}

async function borrarRecetaProceso(drive, codigo) {
  try {
    const folderId = await getOrCreateRecetasProcesoFolderId(drive);
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${folderId}' in parents and name = '${codigo}.json' and trashed = false`,
      fields: 'files(id)',
    }));
    if (data.files && data.files.length) await drive.files.delete({ fileId: data.files[0].id });
  } catch {
    // limpieza best-effort
  }
}

// Endpoint que llama el Atajo de iOS: recibe el PDF, hace el mismo OCR+parseo+match que
// procesarRecetaPdf, y en vez de devolver el resultado directo (no hay a quién
// devolvérselo dentro de la app — el Atajo solo puede abrir una URL) lo guarda como
// borrador y devuelve la URL de la vista previa para que el Atajo la abra en Safari.
async function recibirRecetaShortcut(req, res) {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ success: false, message: 'Falta el PDF.' });

  let buffer;
  try {
    buffer = decodificarPdfBase64(pdfBase64);
  } catch (err) {
    return res.status(200).json({ success: false, message: err.message });
  }

  try {
    const drive = getPacientesDriveClient();
    const resultado = await ocrYParsearReceta(drive, buffer);

    const folderId = await getOrCreateRecetasProcesoFolderId(drive);
    limpiarRecetasProcesoVencidas(drive, folderId); // no se espera, es limpieza oportunista
    const codigo = crypto.randomBytes(5).toString('hex');
    await conReintentos(() => drive.files.create({
      requestBody: { name: `${codigo}.json`, parents: [folderId] },
      media: { mimeType: 'application/json', body: bufferToStream(Buffer.from(JSON.stringify(resultado))) },
      fields: 'id',
    }));

    res.status(200).json({ success: true, url: `https://od-francovinzon.vercel.app/mobilephotouploaderodfrancovinzon/receta/?codigo=${codigo}` });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/pacientes.js', detalle: 'receta-recibir-shortcut', error: err });
    res.status(200).json({ success: false, message: 'No se pudo leer el PDF. Probá de nuevo.' });
  }
}

async function obtenerRecetaProceso(req, res) {
  const codigo = req.query.codigo;
  if (!codigo || !/^[a-f0-9]{10}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido.' });
  try {
    const drive = getPacientesDriveClient();
    const folderId = await getOrCreateRecetasProcesoFolderId(drive);
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${folderId}' in parents and name = '${codigo}.json' and trashed = false`,
      fields: 'files(id)',
    }));
    if (!data.files || !data.files.length) return res.status(404).json({ error: 'No se encontró esa receta (puede que ya haya sido guardada, o que hayan pasado más de 48hs).' });
    const exportado = await conReintentos(() => drive.files.get({ fileId: data.files[0].id, alt: 'media' }, { responseType: 'text' }));
    const contenido = typeof exportado.data === 'string' ? JSON.parse(exportado.data) : exportado.data;
    res.status(200).json({ success: true, codigo, ...contenido });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo cargar la receta.' });
  }
}


// ---------- SISTEMA CENTRALIZADO DE PACIENTES: editar datos centrales (2026-08-25) ----------
// POST accion='actualizar-paciente-central' { key, dni?, telefono?, campo, valor }.
// 1) Actualiza la planilla consolidada (registro central, identificador DNI).
// 2) Si el paciente tiene ficha, sincroniza el campo en la ficha (para los campos que la
//    ficha guarda: nombre/apellido/dni/telefono — el email aún no tiene celda en la ficha).
// 3) Si cambió teléfono/email, actualiza SOLO los turnos FUTUROS del paciente en Calendar
//    (pocos por paciente; nunca los históricos — sincronización cuidada, Fase 5).
const CAMPOS_PACIENTE_CENTRAL = ['nombre', 'apellido', 'dni', 'telefono', 'email'];
async function actualizarPacienteCentral(req, res) {
  const { key, dni, telefono, campo, valor } = req.body;
  if (!claveValida(key)) return res.status(401).json({ success: false, message: 'No autorizado.' });
  if (!CAMPOS_PACIENTE_CENTRAL.includes(campo)) {
    return res.status(400).json({ success: false, message: 'Campo inválido.' });
  }
  try {
    const filas = await listarPacientesConsolidados();
    const paciente = dni
      ? filas.find((f) => f.dni && normalizarDni(f.dni) === normalizarDni(dni))
      : filas.find((f) => f.telefono && normalizarTelefonoMapeo(f.telefono) === normalizarTelefonoMapeo(telefono));
    if (!paciente) return res.status(200).json({ success: false, message: 'Paciente no encontrado.' });

    // 1. Registro central.
    await actualizarPacienteConsolidado({ dni: paciente.dni, telefono: paciente.telefono, campos: { [campo]: valor } });

    // 2. Ficha (si existe) — el autosave de la ficha también sincroniza la planilla, no
    // se pisa nada: la ficha es la fuente de verdad para sus propios campos.
    if (paciente.fichaId && ['nombre', 'apellido', 'dni', 'telefono'].includes(campo)) {
      await escribirCampoEnSheet(paciente.fichaId, campo, valor);
    }

    // 3. Turnos futuros del paciente (teléfono/email).
    if (['telefono', 'email'].includes(campo) && String(valor || '').trim()) {
      await sincronizarTurnosFuturosPaciente(paciente, campo, valor);
    }

    res.status(200).json({ success: true, message: 'Datos del paciente actualizados.' });
  } catch (err) {
    console.error(err);
    res.status(200).json({ success: false, message: 'No se pudieron actualizar los datos.' });
  }
}

// Busca los turnos FUTUROS del paciente (por DNI exacto en la description, o por título
// si el evento no tiene DNI) y reemplaza la línea del campo en su description. Lotes
// chicos con pausa (cuota de escritura de Calendar). Nunca toca turnos pasados.
async function sincronizarTurnosFuturosPaciente(paciente, campo, valor) {
  try {
    const calendar = getCalendarClient();
    const ahora = new Date();
    const desde = ahora;
    const hasta = new Date(ahora.getTime() + 120 * 24 * 60 * 60000); // 120 días
    const dniNorm = normalizarDni(paciente.dni);
    const nombreCompleto = `${paciente.nombre} ${paciente.apellido}`.trim();
    const etiqueta = campo === 'telefono' ? 'Teléfono' : 'Email';
    const valorFinal = campo === 'telefono' ? telefonoParaWhatsApp(valor) || valor : valor;

    const eventos = [];
    for (const calendarId of [CALENDAR_ID, SOBRETURNOS_CALENDAR_ID]) {
      let pageToken;
      do {
        const { data } = await conReintentos(() => calendar.events.list({
          calendarId, timeMin: desde.toISOString(), timeMax: hasta.toISOString(),
          singleEvents: true, maxResults: 2500, pageToken,
        }));
        eventos.push(...(data.items || []).map((ev) => ({ ev, calendarId })));
        pageToken = data.nextPageToken;
      } while (pageToken);
    }

    const pendientes = eventos.filter(({ ev }) => {
      const evDni = normalizarDni(extraerDni(ev.description));
      if (evDni && dniNorm) return evDni === dniNorm;
      return !evDni && (ev.summary || '').trim() === nombreCompleto;
    });

    const LOTE = 4;
    for (let i = 0; i < pendientes.length; i += LOTE) {
      const lote = pendientes.slice(i, i + LOTE);
      await Promise.all(lote.map(async ({ ev, calendarId }) => {
        const desc = ev.description || '';
        const nueva = /Tel[eé]fono:\s*[^\n]*/.test(desc) || /Email:\s*[^\n]*/.test(desc)
          ? desc.replace(new RegExp(`${etiqueta}:\\s*[^\\n]*`, 'i'), `${etiqueta}: ${valorFinal}`)
          : `${desc.replace(/\s+$/, '')}\n${etiqueta}: ${valorFinal}`;
        await conReintentos(() => calendar.events.patch({ calendarId, eventId: ev.id, requestBody: { description: nueva } }));
      }));
      if (lote.length === LOTE) await new Promise((r) => setTimeout(r, 400));
    }
  } catch (err) {
    console.warn('[pacientes.js] no se pudieron sincronizar los turnos futuros:', err?.message || err);
  }
}

// UTILITARIO TEMPORAL DE DIAGNÓSTICO (2026-08-25) — SOLO LECTURA, no escribe nada.
async function diagnosticoConsolidados(req, res) {
  const secreto = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secreto || auth !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();
    const { data: archivo } = await conReintentos(() => drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${PACIENTES_CONSOLIDADOS_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id, name)',
    }));
    if (!archivo.files || !archivo.files.length) {
      return res.status(200).json({ planillaExiste: false });
    }
    const id = archivo.files[0].id;
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'A1:H50' }));
    const filas = data.values || [];
    const conDatos = filas.filter((r) => r[0] || r[1] || r[2] || r[3]);
    res.status(200).json({
      planillaExiste: true, planillaId: id,
      encabezado: filas[0] || [],
      filasTotalesEnRango: filas.length,
      filasConDatos: conDatos.length,
      primerasFilas: conDatos.slice(0, 5),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || String(err) });
  }
}

