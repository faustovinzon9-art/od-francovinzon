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
  getPacientesSheetsClient, getPacientesDriveClient, getPacientesAuthClient, buildAuthUrl, exchangeCodeForTokens,
} from '../../lib/googleOAuthPacientes.js';
import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, normalizarTexto, extraerTelefono,
  extraerDni, isValidGestionKey, getHorariosLibresDia, formatArgDay, formatArgTime, toArgDate,
} from '../../lib/googleCalendar.js';
import {
  PACIENTES_FOLDER_ID, FICHA_TEMPLATE_ID, BACKUP_FOLDER_NAME, SHEET_NAME,
  FORMA_PAGO_COLUMN_INDEX, CAMPO_CELDA, CAMPOS_ORDENADOS, rangoMovimientos,
  rangoPrestacionesObraSocial, primeraFilaLibre, nombreArchivo, parsearNombreArchivo,
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
import { upsertPacienteConsolidado, reemplazarTodasLasFilas } from '../../lib/pacientesConsolidados.js';

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
    // UTILITARIO TEMPORAL (2026-08-14, ver el pedido) — poblar la planilla "Pacientes
    // consolidados" de una sola vez con todo lo que ya existe (fichas + historial de
    // turnos), para que el autocompletado de /gestion tenga datos desde ya en vez de ir
    // acumulando solo con turnos/fichas nuevas de acá en más. Sin GESTION_KEY por el
    // mismo motivo que el backfill de DNI anterior (no hay forma de correrlo con clave a
    // mano en este entorno) — se saca del proyecto apenas se confirma el resultado.
    if (req.method === 'GET' && req.query.modo === 'backfill-consolidado-q7m3') {
      return await backfillConsolidado(req, res);
    }

    // UTILITARIOS TEMPORALES DE INVESTIGACIÓN (2026-08-20, ver el pedido — caso Karen
    // Schneider, sospecha de saldo/movimientos corrompidos). Solo lectura: no escriben
    // nada en ninguna ficha. Sin GESTION_KEY por el mismo motivo que el backfill de
    // arriba (no hay forma de correrlos con clave a mano en este entorno) — protegidos
    // únicamente por el string largo del modo, mismo criterio que auditoria-integridad-h4k9
    // (ya sacada del proyecto) usó antes para el caso Guillermo Montañana. Se sacan del
    // proyecto apenas se confirma el resultado.
    if (req.method === 'GET' && req.query.modo === 'investigar-historial-k9p2') {
      return await investigarHistorial(req, res);
    }
    if (req.method === 'GET' && req.query.modo === 'auditar-saldos-k9p2') {
      return await auditarSaldos(req, res);
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

    if (req.method === 'POST') {
      if (!claveValida(req.body.key)) return res.status(401).json({ error: 'unauthorized' });
      if (req.body.accion === 'crear') return await crearPaciente(req, res);
      if (req.body.accion === 'actualizar-campo') return await actualizarCampo(req, res);
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

// ---------- UTILITARIO TEMPORAL: backfill de "Pacientes consolidados" (2026-08-14) ----------
// Arma TODAS las filas en memoria (fichas + historial de turnos, ficha gana por
// teléfono) y las escribe de una sola vez con reemplazarTodasLasFilas() — evita el
// read-por-fila de upsertPacienteConsolidado(), que con cientos/miles de registros
// hubiera sido lentísimo (O(n²)) para un backfill de una sola vez.
const BACKFILL_CONSOLIDADO_ANIOS = 3;
async function backfillConsolidado(req, res) {
  try {
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();
    const archivos = await listarArchivosPacientes(drive);

    const porTelefono = new Map(); // telefono normalizado -> fila
    let fichasFallidas = 0;

    const LOTE = 25;
    for (let i = 0; i < archivos.length; i += LOTE) {
      const lote = archivos.slice(i, i + LOTE);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
            spreadsheetId: f.id,
            ranges: [`${SHEET_NAME}!C5:C7`, `${SHEET_NAME}!C14`],
          }));
          const [nombre = '', apellido = '', dni = ''] = (data.valueRanges?.[0]?.values || []).map((r) => r[0] || '');
          const telefono = data.valueRanges?.[1]?.values?.[0]?.[0] || '';
          return { id: f.id, nombre, apellido, dni, telefono };
        } catch (err) {
          console.warn(`[pacientes.js] backfill consolidado: no se pudo leer ${f.name}:`, err?.message || err);
          return null;
        }
      }));
      resultados.forEach((r) => {
        if (!r) { fichasFallidas++; return; }
        const telNorm = normalizarTelefonoMapeo(r.telefono);
        if (!telNorm) return; // sin teléfono no hay con qué matchear en el autocompletado
        porTelefono.set(telNorm, {
          telefono: r.telefono, nombre: r.nombre, apellido: r.apellido, dni: r.dni,
          fichaId: r.id, origen: 'ficha', actualizado: new Date().toISOString(),
        });
      });
    }
    const totalFichas = porTelefono.size;

    const calendar = getCalendarClient();
    const ahora = new Date();
    const desde = new Date(Date.UTC(ahora.getUTCFullYear() - BACKFILL_CONSOLIDADO_ANIOS, ahora.getUTCMonth(), ahora.getUTCDate()));
    let eventos = [];
    for (const calendarId of [CALENDAR_ID, SOBRETURNOS_CALENDAR_ID]) {
      let pageToken;
      do {
        const { data } = await conReintentos(() => calendar.events.list({
          calendarId, timeMin: desde.toISOString(), timeMax: ahora.toISOString(),
          singleEvents: true, maxResults: 2500, pageToken,
        }));
        eventos = eventos.concat(data.items || []);
        pageToken = data.nextPageToken;
      } while (pageToken);
    }

    let turnosAgregados = 0;
    eventos.forEach((ev) => {
      if ((ev.description || '').includes(BLOCK_MARKER)) return;
      const telNorm = normalizarTelefonoMapeo(extraerTelefono(ev.description));
      if (!telNorm || porTelefono.has(telNorm)) return; // ya cubierto por una ficha
      const partesNombre = (ev.summary || '').trim().split(/\s+/);
      const nombre = partesNombre.shift() || '';
      const apellido = partesNombre.join(' ');
      porTelefono.set(telNorm, {
        telefono: extraerTelefono(ev.description), nombre, apellido, dni: extraerDni(ev.description),
        fichaId: '', origen: 'turno', actualizado: new Date().toISOString(),
      });
      turnosAgregados++;
    });

    const totalEscrito = await reemplazarTodasLasFilas([...porTelefono.values()]);

    res.status(200).json({ totalFichas, turnosAgregados, totalEscrito, fichasFallidas, archivosRevisados: archivos.length, eventosRevisados: eventos.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || String(err) });
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
      const lote = archivos.slice(i, i + LOTE);
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

  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();

  // Detección de duplicados por DNI (ver decisions.md): nunca se crea una segunda ficha
  // con el mismo DNI — se ofrece abrir la existente en su lugar. Red de seguridad
  // server-side además del chequeo que ya hace el cliente contra la lista en memoria.
  const dniNormalizado = normalizarDni(campos.dni);
  if (dniNormalizado) {
    const existente = await buscarPacientePorDni(drive, dniNormalizado);
    if (existente) {
      return res.status(200).json({
        success: false,
        duplicado: true,
        id: existente.id,
        nombre: existente.nombre,
        apellido: existente.apellido,
        message: 'Ya existe una ficha con este DNI.',
      });
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
      return res.status(200).json({ success: true, id, nombre: otraExistente.nombre, apellido: otraExistente.apellido });
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

  res.status(200).json({ success: true, id, nombre, apellido });
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

// RAW para teléfono y nº de afiliado: con USER_ENTERED, Sheets los interpretaría como
// número y se comería un 0 inicial (ej. un fijo con característica "011"). No hay
// ninguna fórmula que dependa de que estas dos celdas sean numéricas, así que no hace
// falta el parseo — se guardan tal cual se tipearon.
const CAMPOS_TEXTO_CRUDO = new Set(['telefono', 'nAfiliado']);

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
  if (!id || !fecha) return res.status(400).json({ success: false, message: 'Falta fecha.' });

  try {
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoMovimientos() }));
    const fila = primeraFilaLibre(data.values || []);
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

// Nunca se borra un movimiento físicamente: se marca "[ANULADO]" en el texto (con los
// montos originales, para no perder el dato) y se ponen Debe/Haber en 0 para que deje de
// afectar el saldo (las fórmulas de Saldo sí se recalculan solas, ver pacientesSheet.js).
async function movimientoAnular(req, res) {
  const { id, fila } = req.body;
  if (!id || !fila) return res.status(400).json({ success: false, message: 'Falta fila.' });

  try {
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({
      spreadsheetId: id, range: `${SHEET_NAME}!B${fila}:E${fila}`,
    }));
    const [fecha = '', tratamiento = '', debe = 0, haber = 0] = (data.values && data.values[0]) || [];
    if (/^\[ANULADO\]/.test(tratamiento)) {
      return res.status(200).json({ success: true }); // ya estaba anulado, no hace nada
    }
    const nuevoTexto = `[ANULADO] ${tratamiento} (era: Debe $${debe || 0} / Haber $${haber || 0})`;
    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${SHEET_NAME}!B${fila}:E${fila}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[fecha, nuevoTexto, 0, 0]] },
    }));
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
  if (!id || !fecha) return res.status(400).json({ success: false, message: 'Falta fecha.' });

  try {
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoPrestacionesObraSocial() }));
    const fila = primeraFilaLibre(data.values || []);
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
        await escribirMovimientoEnFila(pacienteId, fila, payload);
      } else if (accion === 'movimiento-editar') {
        await escribirMovimientoEnFila(pacienteId, payload.fila, payload);
      } else if (accion === 'movimiento-anular') {
        await movimientoAnularInterno(pacienteId, payload.fila);
      } else if (accion === 'prestacion-agregar') {
        const { data: pres } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: pacienteId, range: rangoPrestacionesObraSocial() }));
        const fila = primeraFilaLibre(pres.values || []);
        await escribirPrestacionEnFila(pacienteId, fila, payload);
      } else if (accion === 'prestacion-editar') {
        await escribirPrestacionEnFila(pacienteId, payload.fila, payload);
      } else if (accion === 'prestacion-eliminar') {
        await escribirPrestacionEnFila(pacienteId, payload.fila, { fecha: '', tratamiento: '', codigo: '', autorizado: false });
      }
      await conReintentos(() => drive.files.delete({ fileId: archivo.id }));
    } catch (err) {
      console.error('No se pudo recuperar un respaldo pendiente, se reintenta en el próximo acceso', err);
    }
  }
}

async function movimientoAnularInterno(id, fila) {
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!B${fila}:E${fila}` }));
  const [fecha = '', tratamiento = '', debe = 0, haber = 0] = (data.values || [[]])[0];
  if (/^\[ANULADO\]/.test(tratamiento)) return;
  const nuevoTexto = `[ANULADO] ${tratamiento} (era: Debe $${debe || 0} / Haber $${haber || 0})`;
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!B${fila}:E${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, nuevoTexto, 0, 0]] },
  }));
}

// ---------- Investigación 2026-08-20: recuperación de historial vía revisiones ----------
// Caso Karen Schneider — saldo no coincidía con los movimientos esperados. Reconstruye
// el estado de una ficha en revisiones anteriores de Drive, exportando cada revisión
// como CSV (la ficha es un Sheet de una sola pestaña, "Hoja 1" — ver
// lib/pacientesSheet.js — así que el CSV de la revisión trae TODO el contenido relevante
// sin necesitar parsear xlsx/ods). Parser CSV propio porque no hay ninguna librería de
// planillas en package.json y esto es un utilitario temporal, no vale la pena sumar una
// dependencia nueva para esto solo.
function parsearCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let dentroDeComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroDeComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else { dentroDeComillas = false; }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      dentroDeComillas = true;
    } else if (c === ',') {
      fila.push(campo); campo = '';
    } else if (c === '\r') {
      // se ignora, \n hace el salto de fila (maneja \r\n y \n solo)
    } else if (c === '\n') {
      fila.push(campo); campo = '';
      filas.push(fila); fila = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

// Índices 0-based dentro del array de filas del CSV (fila del Sheet N -> índice N-1) —
// ver el layout completo documentado en lib/pacientesSheet.js.
const CSV_FILA_NOMBRE = 4; // C5
const CSV_FILA_APELLIDO = 5; // C6
const CSV_FILA_DNI = 6; // C7
const CSV_FILA_SALDO = 7; // F8 (fila 8, columna F)
const CSV_COL_SALDO = 5;
const CSV_FILA_MOV_INICIO = 17; // fila 18 en adelante
const CSV_COL_FECHA = 1;
const CSV_COL_TRATAMIENTO = 2;
const CSV_COL_DEBE = 3;
const CSV_COL_HABER = 4;
const CSV_COL_SALDO_FILA = 5;
const CSV_COL_FORMA_PAGO = 7;

function movimientosDesdeFilasCSV(filas) {
  return filas.slice(CSV_FILA_MOV_INICIO)
    .map((row, i) => ({
      fila: 18 + i,
      fecha: row[CSV_COL_FECHA] || '',
      tratamiento: row[CSV_COL_TRATAMIENTO] || '',
      debe: row[CSV_COL_DEBE] || '',
      haber: row[CSV_COL_HABER] || '',
      saldoFormula: row[CSV_COL_SALDO_FILA] || '',
      formaPago: row[CSV_COL_FORMA_PAGO] || '',
    }))
    .filter((m) => m.fecha || m.tratamiento || m.debe || m.haber);
}

async function exportarRevisionComoCSV(authClient, drive, fileId, revisionId) {
  const { data: revDetalle } = await conReintentos(() => drive.revisions.get({
    fileId, revisionId, fields: 'exportLinks',
  }));
  const csvUrl = revDetalle.exportLinks && revDetalle.exportLinks['text/csv'];
  if (!csvUrl) return { error: 'sin exportLinks (revisión sin contenido exportable)' };
  const { token } = await authClient.getAccessToken();
  const resp = await fetch(csvUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return { error: `export respondió ${resp.status}` };
  const texto = await resp.text();
  return { filas: parsearCSV(texto) };
}

// GET ?modo=investigar-historial-k9p2&nombre=... — busca ficha(s) por nombre (mismo
// criterio normalizarTexto que el resto del proyecto), lista TODAS sus revisiones de
// Drive, y reconstruye nombre/dni/saldo/movimientos de cada una de las últimas N (evita
// pegarle a la API de Drive cientos de veces si una ficha tiene un historial enorme de
// revisiones). Devuelve también el estado actual para comparar.
async function investigarHistorial(req, res) {
  const nombreQuery = normalizarTexto(req.query.nombre || '');
  if (!nombreQuery) return res.status(400).json({ error: 'Falta nombre.' });

  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();
  const authClient = getPacientesAuthClient();

  const archivos = await listarArchivosPacientes(drive);
  const candidatos = archivos.filter((f) => normalizarTexto(f.name).includes(nombreQuery));
  if (!candidatos.length) return res.status(404).json({ error: 'No se encontró ninguna ficha con ese nombre.', buscado: req.query.nombre });

  const MAX_REVISIONES_A_ANALIZAR = Number(req.query.max) || 40;
  const resultado = [];

  for (const archivo of candidatos) {
    const id = archivo.id;
    const [campos, financiero, movRaw] = await Promise.all([
      conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C7` })),
      conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!E6:F11` })),
      conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoMovimientos() })),
    ]);
    const [nombre = '', apellido = '', dni = ''] = (campos.data.values || []).map((r) => r[0] || '');
    const saldoActual = financiero.data.values?.[2]?.[1] || '';
    const movimientosActuales = (movRaw.data.values || [])
      .map((row, i) => ({ fila: 18 + i, fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '' }))
      .filter((m) => m.fecha || m.tratamiento || m.debe || m.haber);

    const entrada = { id, nombreArchivo: archivo.name, nombre, apellido, dni, saldoActual, movimientosActuales };

    try {
      const { data } = await conReintentos(() => drive.revisions.list({
        fileId: id,
        fields: 'revisions(id, modifiedTime, lastModifyingUser(displayName, emailAddress), size)',
        pageSize: 1000,
      }));
      const revisiones = data.revisions || [];
      entrada.totalRevisiones = revisiones.length;
      const aAnalizar = revisiones.slice(-MAX_REVISIONES_A_ANALIZAR);
      entrada.revisionesAnalizadas = aAnalizar.length;
      entrada.snapshots = [];
      for (const rev of aAnalizar) {
        const exportado = await exportarRevisionComoCSV(authClient, drive, id, rev.id);
        if (exportado.error) {
          entrada.snapshots.push({ revisionId: rev.id, modifiedTime: rev.modifiedTime, error: exportado.error });
          continue;
        }
        const { filas } = exportado;
        entrada.snapshots.push({
          revisionId: rev.id,
          modifiedTime: rev.modifiedTime,
          autor: rev.lastModifyingUser?.displayName || rev.lastModifyingUser?.emailAddress || '',
          nombre: filas[CSV_FILA_NOMBRE]?.[2] || '',
          apellido: filas[CSV_FILA_APELLIDO]?.[2] || '',
          saldo: filas[CSV_FILA_SALDO]?.[CSV_COL_SALDO] || '',
          movimientos: movimientosDesdeFilasCSV(filas),
        });
      }
    } catch (err) {
      entrada.errorRevisiones = err.message;
    }

    resultado.push(entrada);
  }

  res.status(200).json({ resultado });
}

// GET ?modo=auditar-saldos-k9p2 — audita TODAS las fichas: compara el saldo que
// muestra la fórmula de la planilla contra la suma real (Debe-Haber) de los
// movimientos vivos (no anulados) leídos por la app. Un desfasaje acá es la señal más
// directa de datos corrompidos/duplicados — no depende de revisiones de Drive, es sobre
// el estado ACTUAL de cada ficha.
function parsearMontoArgentinoLocal(texto) {
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '');
  const sinMiles = limpio.replace(/\./g, '');
  return parseFloat(sinMiles.replace(',', '.')) || 0;
}

async function auditarSaldos(req, res) {
  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();
  const archivos = await listarArchivosPacientes(drive);

  const sospechosos = [];
  const errores = [];
  for (const archivo of archivos) {
    try {
      const [financiero, movRaw] = await Promise.all([
        conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: archivo.id, range: `${SHEET_NAME}!E6:F11` })),
        conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: archivo.id, range: rangoMovimientos() })),
      ]);
      const saldoTexto = financiero.data.values?.[2]?.[1] || '';
      const saldoFormula = parsearMontoArgentinoLocal(saldoTexto);

      const movimientos = (movRaw.data.values || [])
        .map((row) => ({ tratamiento: row[1] || '', debe: row[2], haber: row[3] }))
        .filter((m) => !/^\[ANULADO\]/.test(m.tratamiento));
      const sumaDebe = movimientos.reduce((acc, m) => acc + parsearMontoArgentinoLocal(m.debe), 0);
      const sumaHaber = movimientos.reduce((acc, m) => acc + parsearMontoArgentinoLocal(m.haber), 0);
      const saldoCalculado = sumaDebe - sumaHaber;

      // Margen de $1 por redondeo de parseo, no por tolerancia real al error.
      if (Math.abs(saldoFormula - saldoCalculado) > 1) {
        sospechosos.push({
          id: archivo.id,
          nombreArchivo: archivo.name,
          saldoFormula,
          saldoCalculado,
          diferencia: saldoFormula - saldoCalculado,
          cantidadMovimientos: movimientos.length,
        });
      }
    } catch (err) {
      errores.push({ id: archivo.id, nombreArchivo: archivo.name, error: err.message });
    }
  }

  res.status(200).json({ archivosRevisados: archivos.length, sospechosos, errores });
}
