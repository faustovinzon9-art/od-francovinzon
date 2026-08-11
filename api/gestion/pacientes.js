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
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, normalizarTexto, extraerTelefono,
  isValidGestionKey,
} from '../../lib/googleCalendar.js';
import {
  PACIENTES_FOLDER_ID, FICHA_TEMPLATE_ID, BACKUP_FOLDER_NAME, SHEET_NAME,
  FORMA_PAGO_COLUMN_INDEX, CAMPO_CELDA, CAMPOS_ORDENADOS, rangoMovimientos,
  rangoPrestacionesObraSocial, primeraFilaLibre, nombreArchivo, parsearNombreArchivo,
} from '../../lib/pacientesSheet.js';

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

    if (req.method === 'GET') {
      if (!isValidGestionKey(req.query.key)) return res.status(401).json({ error: 'unauthorized' });
      if (req.query.modo === 'listar') return await listar(req, res);
      if (req.query.modo === 'ficha') return await obtenerFicha(req, res);
      if (req.query.modo === 'modified') return await obtenerModified(req, res);
      if (req.query.modo === 'telefono-turnos') return await telefonoDesdeTurnos(req, res);
      return res.status(400).json({ error: 'modo inválido' });
    }

    if (req.method === 'POST') {
      if (!isValidGestionKey(req.body.key)) return res.status(401).json({ error: 'unauthorized' });
      if (req.body.accion === 'crear') return await crearPaciente(req, res);
      if (req.body.accion === 'actualizar-campo') return await actualizarCampo(req, res);
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
    res.status(500).json({ error: 'Error inesperado.' });
  }
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

async function listar(req, res) {
  const drive = getPacientesDriveClient();
  const { data } = await drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
    orderBy: 'name',
  });

  const pacientes = (data.files || [])
    .filter((f) => f.id !== FICHA_TEMPLATE_ID && !/^⭐/.test(f.name))
    .map((f) => {
      const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
      return { id: f.id, nombre, apellido, dni };
    })
    .sort((a, b) => `${a.nombre} ${a.apellido}`.localeCompare(`${b.nombre} ${b.apellido}`, 'es'));

  res.status(200).json(pacientes);
}

async function obtenerFicha(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id.' });

  const sheets = getPacientesSheetsClient();
  const drive = getPacientesDriveClient();

  await intentarRecuperarRespaldos(sheets, drive, id);

  const [campos, financiero, movRaw, presRaw, meta] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C15` }),
    // Columna E también: "AL DÍA"/"DEBE $X" vive en una celda combinada E9:F10 — el
    // valor solo está en la celda ancla E9, F9 devuelve vacío (ver decisions.md).
    sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!E6:F11` }),
    sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoMovimientos() }),
    sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoPrestacionesObraSocial() }),
    drive.files.get({ fileId: id, fields: 'modifiedTime, name' }),
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
      tratamiento: row[1] || '',
      codigo: row[2] || '',
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

async function obtenerModified(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id.' });
  const drive = getPacientesDriveClient();
  const { data } = await drive.files.get({ fileId: id, fields: 'modifiedTime' });
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
    calendar.events.list({ calendarId: CALENDAR_ID, q, maxResults: 2500, singleEvents: true }),
    calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, q, maxResults: 2500, singleEvents: true }),
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

// ---------- Escritura ----------

async function crearPaciente(req, res) {
  const { nombre, apellido, campos = {} } = req.body;
  if (!nombre || !nombre.trim() || !apellido || !apellido.trim()) {
    return res.status(400).json({ success: false, message: 'Nombre y apellido son obligatorios.' });
  }

  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();

  const nombreFinal = nombreArchivo({ nombre, apellido, dni: campos.dni });
  const copia = await drive.files.copy({
    fileId: FICHA_TEMPLATE_ID,
    requestBody: { name: nombreFinal, parents: [PACIENTES_FOLDER_ID] },
  });
  const id = copia.data.id;

  const datos = { ...campos, nombre, apellido };
  const campoACelda = (campo) => ({ range: `${SHEET_NAME}!${CAMPO_CELDA[campo]}`, values: [[datos[campo]]] });
  const tieneValor = (campo) => datos[campo] != null && String(datos[campo]).trim() !== '';
  // RAW para teléfono/nº de afiliado (ver escribirCampoEnSheet, mismo motivo: no perder
  // un 0 inicial), USER_ENTERED para el resto (fechas y DNI necesitan parseo real).
  const filasCrudas = CAMPOS_ORDENADOS.filter((c) => CAMPOS_TEXTO_CRUDO.has(c) && tieneValor(c)).map(campoACelda);
  const filasParseadas = CAMPOS_ORDENADOS.filter((c) => !CAMPOS_TEXTO_CRUDO.has(c) && tieneValor(c)).map(campoACelda);

  if (filasCrudas.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'RAW', data: filasCrudas },
    });
  }
  if (filasParseadas.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'USER_ENTERED', data: filasParseadas },
    });
  }

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
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!${CAMPO_CELDA[campo]}`,
    valueInputOption: CAMPOS_TEXTO_CRUDO.has(campo) ? 'RAW' : 'USER_ENTERED',
    requestBody: { values: [[valor ?? '']] },
  });

  if (campo === 'nombre' || campo === 'apellido' || campo === 'dni') {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C7` });
    const [nombre = '', apellido = '', dni = ''] = (data.values || []).map((r) => r[0] || '');
    const drive = getPacientesDriveClient();
    await drive.files.update({ fileId: id, requestBody: { name: nombreArchivo({ nombre, apellido, dni }) } });
  }
}

async function movimientoAgregar(req, res) {
  const { id, fecha, tratamiento, debe, haber, formaPago } = req.body;
  if (!id || !fecha) return res.status(400).json({ success: false, message: 'Falta fecha.' });

  try {
    const sheets = getPacientesSheetsClient();
    await asegurarColumnaFormaPago(id);

    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoMovimientos() });
    const fila = primeraFilaLibre(data.values || []);

    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${SHEET_NAME}!B${fila}:D${fila}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[fecha, tratamiento || '', debe || 0]] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${SHEET_NAME}!E${fila}:E${fila}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[haber || 0]] },
    });
    if (formaPago) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range: `${SHEET_NAME}!H${fila}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[formaPago]] },
      });
    }

    res.status(200).json({ success: true, fila });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'movimiento-agregar', { fecha, tratamiento, debe, haber, formaPago });
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
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function escribirMovimientoEnFila(id, fila, { fecha, tratamiento, debe, haber, formaPago }) {
  const sheets = getPacientesSheetsClient();
  await asegurarColumnaFormaPago(id);
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!B${fila}:E${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, tratamiento || '', debe || 0, haber || 0]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!H${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[formaPago || '']] },
  });
}

// Nunca se borra un movimiento físicamente: se marca "[ANULADO]" en el texto (con los
// montos originales, para no perder el dato) y se ponen Debe/Haber en 0 para que deje de
// afectar el saldo (las fórmulas de Saldo sí se recalculan solas, ver pacientesSheet.js).
async function movimientoAnular(req, res) {
  const { id, fila } = req.body;
  if (!id || !fila) return res.status(400).json({ success: false, message: 'Falta fila.' });

  try {
    const sheets = getPacientesSheetsClient();
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: id, range: `${SHEET_NAME}!B${fila}:E${fila}`,
    });
    const [fecha = '', tratamiento = '', debe = 0, haber = 0] = (data.values && data.values[0]) || [];
    if (/^\[ANULADO\]/.test(tratamiento)) {
      return res.status(200).json({ success: true }); // ya estaba anulado, no hace nada
    }
    const nuevoTexto = `[ANULADO] ${tratamiento} (era: Debe $${debe || 0} / Haber $${haber || 0})`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${SHEET_NAME}!B${fila}:E${fila}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[fecha, nuevoTexto, 0, 0]] },
    });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'movimiento-anular', { fila });
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
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: rangoPrestacionesObraSocial() });
    const fila = primeraFilaLibre(data.values || []);
    await escribirPrestacionEnFila(id, fila, { fecha, tratamiento, codigo, autorizado });
    res.status(200).json({ success: true, fila });
  } catch (err) {
    console.error(err);
    await respaldarCambioFallido(id, 'prestacion-agregar', { fecha, tratamiento, codigo, autorizado });
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
    res.status(200).json({ success: true, pendiente: true });
  }
}

async function escribirPrestacionEnFila(id, fila, { fecha, tratamiento, codigo, autorizado }) {
  const sheets = getPacientesSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!J${fila}:M${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha || '', tratamiento || '', codigo || '', !!autorizado]] },
  });
}

async function asegurarColumnaFormaPago(id) {
  const sheets = getPacientesSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!H17` });
  if ((data.values || [[]])[0]?.[0] === 'Forma de pago') return;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
  const sheetId = meta.data.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
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
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!H17`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Forma de pago']] },
  });
}

// ---------- Backup de emergencia (Sheets caído) ----------
// No bloquea al usuario: si escribir en el Sheet falla, el cambio se guarda como JSON en
// una carpeta aparte dentro de "Pacientes" y se reintenta solo la próxima vez que se abre
// esa misma ficha (intentarRecuperarRespaldos, arriba en obtenerFicha). No hay cron en
// este proyecto (sitio estático + serverless, ver CLAUDE.md) — el reintento "oportunista"
// en el próximo acceso es la forma de lograr esto sin sumar infraestructura nueva.
async function getOrCreateBackupFolderId(drive) {
  const { data } = await drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
  });
  if (data.files && data.files.length) return data.files[0].id;
  const creada = await drive.files.create({
    requestBody: { name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [PACIENTES_FOLDER_ID] },
    fields: 'id',
  });
  return creada.data.id;
}

async function respaldarCambioFallido(pacienteId, accion, payload) {
  try {
    const drive = getPacientesDriveClient();
    const folderId = await getOrCreateBackupFolderId(drive);
    const nombre = `${pacienteId}__${Date.now()}.json`;
    await drive.files.create({
      requestBody: { name: nombre, parents: [folderId] },
      media: { mimeType: 'application/json', body: JSON.stringify({ pacienteId, accion, payload, creado: new Date().toISOString() }) },
    });
  } catch (err) {
    // Si hasta el respaldo falla (Drive también caído), no hay más nada que hacer del
    // lado del servidor — el error ya se logueó en el catch de quien llamó a esta función.
    console.error('No se pudo guardar el respaldo de emergencia', err);
  }
}

async function intentarRecuperarRespaldos(sheets, drive, pacienteId) {
  let folderId;
  try {
    const { data } = await drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
    });
    if (!data.files || !data.files.length) return; // no hay carpeta de respaldo todavía, nada pendiente
    folderId = data.files[0].id;
  } catch {
    return;
  }

  const { data: pendientes } = await drive.files.list({
    q: `'${folderId}' in parents and name contains '${pacienteId}__' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name',
  });
  if (!pendientes.files || !pendientes.files.length) return;

  for (const archivo of pendientes.files) {
    try {
      const contenido = await drive.files.get({ fileId: archivo.id, alt: 'media' });
      const { accion, payload } = contenido.data;
      if (accion === 'actualizar-campo') {
        await escribirCampoEnSheet(pacienteId, payload.campo, payload.valor);
      } else if (accion === 'movimiento-agregar') {
        const { data: mov } = await sheets.spreadsheets.values.get({ spreadsheetId: pacienteId, range: rangoMovimientos() });
        const fila = primeraFilaLibre(mov.values || []);
        await escribirMovimientoEnFila(pacienteId, fila, payload);
      } else if (accion === 'movimiento-editar') {
        await escribirMovimientoEnFila(pacienteId, payload.fila, payload);
      } else if (accion === 'movimiento-anular') {
        await movimientoAnularInterno(pacienteId, payload.fila);
      } else if (accion === 'prestacion-agregar') {
        const { data: pres } = await sheets.spreadsheets.values.get({ spreadsheetId: pacienteId, range: rangoPrestacionesObraSocial() });
        const fila = primeraFilaLibre(pres.values || []);
        await escribirPrestacionEnFila(pacienteId, fila, payload);
      } else if (accion === 'prestacion-editar') {
        await escribirPrestacionEnFila(pacienteId, payload.fila, payload);
      } else if (accion === 'prestacion-eliminar') {
        await escribirPrestacionEnFila(pacienteId, payload.fila, { fecha: '', tratamiento: '', codigo: '', autorizado: false });
      }
      await drive.files.delete({ fileId: archivo.id });
    } catch (err) {
      console.error('No se pudo recuperar un respaldo pendiente, se reintenta en el próximo acceso', err);
    }
  }
}

async function movimientoAnularInterno(id, fila) {
  const sheets = getPacientesSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!B${fila}:E${fila}` });
  const [fecha = '', tratamiento = '', debe = 0, haber = 0] = (data.values || [[]])[0];
  if (/^\[ANULADO\]/.test(tratamiento)) return;
  const nuevoTexto = `[ANULADO] ${tratamiento} (era: Debe $${debe || 0} / Haber $${haber || 0})`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_NAME}!B${fila}:E${fila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, nuevoTexto, 0, 0]] },
  });
}
