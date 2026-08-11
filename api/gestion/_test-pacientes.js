// Script de un solo uso para confirmar que la cuenta de servicio puede copiar/editar
// archivos dentro de la carpeta "Pacientes" (compartida como Editor, Drive personal sin
// Workspace). Crea una copia de prueba del template, escribe y lee un valor, prueba
// unhide de columna, y borra la copia. Se saca del proyecto apenas confirma el resultado
// (mismo patrón que otros scripts de migración de este repo, ver CLAUDE.md).
import { getSheetsClient, getDriveClient } from '../../lib/googleCalendar.js';

const PACIENTES_FOLDER_ID = '1Da7r5C9fc2Nr-zu7GTOAm0_dE0YbmJBm';
const FICHA_TEMPLATE_ID = '1z23r0pBe0L09YncsBJQd-hUgFttylzFjMY0P-DDE4h4';

export default async function handler(req, res) {
  if (req.query.confirm !== 'si') {
    return res.status(400).json({ error: 'Agregá ?confirm=si' });
  }

  const pasos = [];
  let copiaId = null;

  try {
    const drive = getDriveClient();
    const sheets = getSheetsClient();

    const copia = await drive.files.copy({
      fileId: FICHA_TEMPLATE_ID,
      requestBody: { name: 'TEST BORRAR - prueba de acceso', parents: [PACIENTES_FOLDER_ID] },
    });
    copiaId = copia.data.id;
    pasos.push({ paso: 'copiar', ok: true, id: copiaId });

    const meta = await sheets.spreadsheets.get({ spreadsheetId: copiaId });
    const sheetId = meta.data.sheets[0].properties.sheetId;
    pasos.push({ paso: 'leer metadata', ok: true, sheetId });

    await sheets.spreadsheets.values.update({
      spreadsheetId: copiaId,
      range: 'Hoja 1!C5:C7',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Juan'], ['Pérez'], ['12345678']] },
    });
    pasos.push({ paso: 'escribir nombre/apellido/dni', ok: true });

    const titulo = await sheets.spreadsheets.values.get({
      spreadsheetId: copiaId,
      range: 'C2',
    });
    pasos.push({ paso: 'leer título calculado', ok: true, valor: titulo.data.values?.[0]?.[0] });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: copiaId,
      requestBody: {
        requests: [{
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 },
            properties: { hiddenByUser: false },
            fields: 'hiddenByUser',
          },
        }],
      },
    });
    pasos.push({ paso: 'unhide columna H', ok: true });

    await drive.files.delete({ fileId: copiaId });
    pasos.push({ paso: 'borrar copia de prueba', ok: true });

    res.status(200).json({ success: true, pasos });
  } catch (err) {
    console.error(err);
    pasos.push({ paso: 'error', ok: false, mensaje: err.message });
    // Intenta limpiar la copia de prueba igual si algo falló después de crearla.
    if (copiaId) {
      try {
        const drive = getDriveClient();
        await drive.files.delete({ fileId: copiaId });
        pasos.push({ paso: 'limpieza tras error', ok: true });
      } catch (err2) {
        pasos.push({ paso: 'limpieza tras error', ok: false, mensaje: err2.message });
      }
    }
    res.status(500).json({ success: false, pasos });
  }
}
