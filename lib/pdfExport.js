// Generación de PDFs para las exportaciones de /admin (sección "Datos de pacientes" y
// "Horarios y agenda" del pedido) — pdfkit es la única dependencia nueva de todo este
// panel: no hay forma razonable de armar un PDF real sin una librería (a diferencia de
// los emails de Resend, que sí se pudieron resolver con un fetch directo).
//
// Estética: mismos colores que el resto del sitio (navy/gold/muted, ver :root de
// gestion/index.html) y el isologo real del consultorio. pdfkit no trae la tipografía
// Fraunces (necesitaría empaquetar un .ttf aparte, no vale la pena para esto) — se usa
// Times-Bold para títulos como aproximación serif con las 14 fuentes base de PDF, sin
// sumar otro archivo/dependencia.
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';

const NAVY = '#1E3A5F';
const GOLD = '#D4A24C';
const MUTED = '#8A8578';
const LINE = '#E9E4D8';
const TEXT = '#2A2A2A';

function nuevoDoc() {
  return new PDFDocument({ margin: 40, size: 'A4' });
}

function bufferizar(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// El logo vive en /assets (estático, servido por Vercel) — una función serverless no
// tiene ese archivo bundleado para leerlo del disco, así que se trae por HTTP en el
// momento. Nunca rompe la generación del PDF si falla (sin internet, dominio caído,
// etc.): el título con el nombre del consultorio ya identifica de qué es el documento
// igual, el logo es un plus visual, no un dato necesario.
//
// logo-horizontal.png (no isologo.png) a propósito — es el isologo + "Franco Vinzón
// Odontólogo" ya tipografiado en Fraunces real (mismo archivo que usa el sidebar de
// /gestion), así no hay que aproximar la tipografía de marca con una de las 14
// fuentes base de PDF (ver el bug real encontrado en producción, 2026-08-13: el
// logo solo -isologo.png- + texto en Times-Bold no se reconocía como la marca real).
let logoBufferCache = null;
async function obtenerLogoBuffer() {
  if (logoBufferCache) return logoBufferCache;
  try {
    const resp = await fetch('https://od-francovinzon.vercel.app/assets/logo-horizontal.png');
    if (!resp.ok) return null;
    logoBufferCache = Buffer.from(await resp.arrayBuffer());
    return logoBufferCache;
  } catch {
    return null;
  }
}

// Todo el texto usa .text(str) sin coordenadas explícitas, mismo patrón ya probado
// en el resto de este archivo — pdfkit lo ubica en el margen izquierdo y avanza el
// cursor solo, sin riesgo de superposición.
async function dibujarEncabezadoMarca(doc, titulo, subtitulo) {
  const logo = await obtenerLogoBuffer();
  if (logo) {
    try {
      doc.image(logo, doc.page.margins.left, doc.y, { width: 200 });
      doc.y += 62;
    } catch {
      // PNG corrupto/no soportado por pdfkit en algún caso raro — seguir sin logo.
      doc.font('Times-Bold').fontSize(17).fillColor(NAVY).text('Franco Vinzón Odontólogo');
    }
  } else {
    doc.font('Times-Bold').fontSize(17).fillColor(NAVY).text('Franco Vinzón Odontólogo');
  }
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Ameghino 410, Concepción del Uruguay, Entre Ríos');
  doc.moveDown(0.6);

  const lineaY = doc.y;
  doc.moveTo(doc.page.margins.left, lineaY).lineTo(doc.page.width - doc.page.margins.right, lineaY).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.y = lineaY + 14;

  doc.font('Times-Bold').fontSize(16).fillColor(NAVY).text(titulo);
  if (subtitulo) doc.font('Helvetica').fontSize(11).fillColor(TEXT).text(subtitulo);
  doc.fillColor(TEXT);
  doc.moveDown(1);
}

// Altura real que necesita una fila (el máximo entre sus celdas, con el ancho ya
// aplicado) — el bug real encontrado en producción (2026-08-13, texto superpuesto en
// el estado de cuenta) era usar una altura fija sin importar cuánto texto entraba en
// cada celda: un "Tratamiento" largo se envolvía a 2-3 líneas pero la fila siguiente
// arrancaba en la misma posición Y de siempre, superponiendo todo lo que venía después.
function alturaFila(doc, valores, anchoColumna, padding) {
  const alturas = valores.map((v) => doc.heightOfString(String(v ?? ''), { width: anchoColumna - padding * 2 }));
  return Math.max(14, ...alturas) + padding * 2;
}

function dibujarTabla(doc, { columnas, filas, anchoColumna }) {
  const startX = doc.page.margins.left;
  const padding = 5;
  let y = doc.y;

  function dibujarEncabezadoTabla() {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY);
    const altura = alturaFila(doc, columnas, anchoColumna, padding);
    columnas.forEach((col, i) => {
      doc.text(col, startX + i * anchoColumna + padding, y + padding, { width: anchoColumna - padding * 2 });
    });
    y += altura;
    doc.moveTo(startX, y).lineTo(startX + anchoColumna * columnas.length, y).strokeColor(GOLD).lineWidth(1).stroke();
    doc.fillColor(TEXT);
  }

  dibujarEncabezadoTabla();

  doc.font('Helvetica').fontSize(9).fillColor(TEXT);
  filas.forEach((fila) => {
    const altura = alturaFila(doc, fila, anchoColumna, padding);
    if (y + altura > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      dibujarEncabezadoTabla();
      doc.font('Helvetica').fontSize(9).fillColor(TEXT);
    }
    fila.forEach((celda, i) => {
      doc.text(String(celda ?? ''), startX + i * anchoColumna + padding, y + padding, { width: anchoColumna - padding * 2 });
    });
    y += altura;
    doc.moveTo(startX, y).lineTo(startX + anchoColumna * columnas.length, y).strokeColor(LINE).lineWidth(0.5).stroke();
  });
  doc.y = y + 10;
}

// Tabla genérica (usada por la exportación de turnos).
export async function generarPdfTabla({ titulo, columnas, filas }) {
  const doc = nuevoDoc();
  await dibujarEncabezadoMarca(doc, titulo);
  const anchoColumna = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / columnas.length;
  dibujarTabla(doc, { columnas, filas, anchoColumna });
  return bufferizar(doc);
}

// Ficha de paciente: datos + (opcional) estado financiero + movimientos, con o sin
// forma de pago. `soloFinanciero` arma el "estado de cuenta" pedido para cuando un
// paciente reclama que ya pagó — sin mostrar método de pago, solo fecha/tratamiento/
// debe/haber/saldo (ver el pedido, sección 5).
export async function generarPdfFicha({ campos, financiero, movimientos, mostrarFormaPago, soloFinanciero }) {
  const doc = nuevoDoc();
  const nombreCompleto = `${campos.nombre || ''} ${campos.apellido || ''}`.trim();

  await dibujarEncabezadoMarca(doc, soloFinanciero ? 'Estado de cuenta' : 'Ficha de paciente', nombreCompleto);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Generado el ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  doc.fillColor(TEXT);
  doc.moveDown(1);

  if (!soloFinanciero) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Datos');
    doc.font('Helvetica').fontSize(10).fillColor(TEXT);
    const filasCampos = [
      ['DNI', campos.dni], ['Fecha de nacimiento', campos.fechaNacimiento],
      ['Domicilio', campos.domicilio], ['Localidad', campos.localidad],
      ['Obra social', campos.obraSocial], ['N° de afiliado', campos.nAfiliado], ['Plan', campos.plan],
      ['Teléfono', campos.telefono], ['Plan de tratamiento', campos.planTratamiento],
    ];
    filasCampos.forEach(([label, valor]) => {
      if (valor) doc.text(`${label}: ${valor}`);
    });
    doc.moveDown(1);
  }

  if (financiero) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Estado financiero');
    doc.font('Helvetica').fontSize(10).fillColor(TEXT)
      .text(`Total: ${financiero.total}    Pagado: ${financiero.pagado}    Saldo: ${financiero.saldo}`);
    doc.moveDown(1);
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Movimientos');
  doc.fillColor(TEXT);
  doc.moveDown(0.3);

  const columnas = mostrarFormaPago
    ? ['Fecha', 'Tratamiento', 'Debe', 'Haber', 'Saldo', 'Forma de pago']
    : ['Fecha', 'Tratamiento', 'Debe', 'Haber', 'Saldo'];
  const anchoColumna = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / columnas.length;
  const filas = movimientos.map((m) => (
    mostrarFormaPago
      ? [m.fecha, m.tratamiento, m.debe, m.haber, m.saldo, m.formaPago]
      : [m.fecha, m.tratamiento, m.debe, m.haber, m.saldo]
  ));
  dibujarTabla(doc, { columnas, filas, anchoColumna });

  return bufferizar(doc);
}

// QR/códigos de barra de la receta (ver el pedido, 2026-08-20: "la receta linda tiene
// que ser igual de funcional" que la original de MisRX/RCTA). Los códigos de barra
// (Recetario y Nro Afiliado) son una codificación estándar de un texto que ya se lee
// perfecto por OCR, así que se generan de cero con ese mismo texto — un Code128 con el
// mismo contenido decodifica exactamente igual, no hace falta copiar ninguna imagen. El
// QR de "Firma Electrónica" es distinto: codifica un link único e irrepetible por
// receta (ver lib/recetaFirmaQr.js — confirmado escaneando una receta real:
// "https://misrx.com.ar/receta?token=..."), imposible de derivar de ningún campo de
// texto, así que ese SÍ se lee del PDF original al procesarlo y acá se vuelve a dibujar
// con el mismo link exacto (receta.firmaElectronicaUrl) para que escanearlo lleve al
// mismo lugar que la receta real. Nunca rompe la generación del PDF si algo falla
// (mismo criterio que el logo, ver obtenerLogoBuffer).
async function generarCodigoBuffer({ bcid, text, scale, height }) {
  try {
    return await bwipjs.toBuffer({ bcid, text, scale: scale || 3, height: height || 10, includetext: false });
  } catch {
    return null;
  }
}

// Receta médica/odontológica: capa de presentación sobre una receta YA emitida
// legalmente desde MisRX/RCTA (ver decisions.md) — todos los datos vienen de lo
// extraído/confirmado de ese PDF original, no se inventa ni completa nada acá.
// El "medicamento" se imprime como bloque de texto verbatim (no separado en
// nombre genérico/forma/dosis por regex) a propósito: separar esos campos con
// una expresión regular corre el riesgo de recortar mal el nombre genérico
// (obligatorio por ley) de un texto con formato variable entre recetas; mostrar
// el bloque completo tal cual lo emitió MisRX/RCTA garantiza que esté siempre.
export async function generarPdfReceta({ paciente, receta }) {
  const doc = nuevoDoc();
  const nombreCompleto = `${paciente.nombre || ''} ${paciente.apellido || ''}`.trim();

  await dibujarEncabezadoMarca(doc, 'Receta', nombreCompleto);

  doc.font('Helvetica').fontSize(10).fillColor(TEXT);
  const filasPaciente = [
    ['Paciente', nombreCompleto || receta.paciente],
    ['DNI', paciente.dni || receta.dni],
    ['Fecha de nacimiento', paciente.fechaNacimiento || receta.fechaNacimiento],
  ];
  filasPaciente.forEach(([label, valor]) => {
    if (valor) doc.text(`${label}: ${valor}`);
  });
  doc.moveDown(1);

  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Medicación');
  doc.fillColor(TEXT);
  doc.moveDown(0.3);
  (receta.medicamentos || []).forEach((m, i) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT)
      .text(`${i + 1}. ${String(m.descripcion || '').replace(/\s*\r?\n\s*/g, ' ')}`);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    if (m.cantidad) doc.text(`   Cantidad: ${m.cantidad}`);
    if (m.diagnostico) doc.text(`   Diagnóstico: ${m.diagnostico}`);
    doc.fillColor(TEXT);
    doc.moveDown(0.4);
  });

  if (receta.posologia) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Posología / Notas');
    doc.font('Helvetica').fontSize(10).fillColor(TEXT).text(receta.posologia);
    doc.moveDown(1);
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Profesional');
  doc.font('Helvetica').fontSize(10).fillColor(TEXT);
  const prof = receta.profesional || {};
  [
    ['Nombre', prof.nombre], ['Matrícula', prof.matricula], ['Profesión', prof.profesion],
  ].forEach(([label, valor]) => {
    if (valor) doc.text(`${label}: ${valor}`);
  });
  doc.moveDown(1.4);

  // Identificación electrónica: Recetario + Nro Afiliado en código de barras (izquierda)
  // y el QR de Firma Electrónica (derecha) — mismo agrupamiento que la receta original.
  // El QR reemplaza a la firma y sello del profesional (así lo dice la propia receta:
  // "la firma electrónica sustituye legalmente a la firma ológrafa"), así que solo se
  // deja el espacio en blanco para firmar a mano si por algún motivo no se pudo leer el
  // QR real del PDF original — nunca se inventa un QR falso.
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Identificación electrónica');
  doc.fillColor(TEXT);
  doc.moveDown(0.4);

  const filaCodigosY = doc.y;
  const [recetarioBuf, afiliadoBuf, qrBuf] = await Promise.all([
    receta.cuir ? generarCodigoBuffer({ bcid: 'code128', text: receta.cuir, scale: 2, height: 10 }) : null,
    receta.nroAfiliado ? generarCodigoBuffer({ bcid: 'code128', text: receta.nroAfiliado, scale: 2, height: 10 }) : null,
    receta.firmaElectronicaUrl ? generarCodigoBuffer({ bcid: 'qrcode', text: receta.firmaElectronicaUrl, scale: 3 }) : null,
  ]);

  const colIzqX = doc.page.margins.left;
  let yIzq = filaCodigosY;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('Recetario', colIzqX, yIzq);
  yIzq += 12;
  if (recetarioBuf) { try { doc.image(recetarioBuf, colIzqX, yIzq, { width: 140, height: 32 }); } catch { /* seguir sin barra */ } }
  yIzq += 34;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(receta.cuir || '—', colIzqX, yIzq);
  yIzq += 14;

  if (receta.nroAfiliado) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('Nro Afiliado', colIzqX, yIzq);
    yIzq += 12;
    if (afiliadoBuf) { try { doc.image(afiliadoBuf, colIzqX, yIzq, { width: 140, height: 32 }); } catch { /* seguir sin barra */ } }
    yIzq += 34;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(receta.nroAfiliado, colIzqX, yIzq);
    yIzq += 14;
  }

  const colDerX = doc.page.width - doc.page.margins.right - 110;
  let yDer;
  if (qrBuf) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('Firma Electrónica', colDerX, filaCodigosY, { width: 110 });
    yDer = filaCodigosY + 12;
    try { doc.image(qrBuf, colDerX, yDer, { width: 80, height: 80 }); } catch { /* seguir sin QR */ }
    yDer += 84;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text('La firma electrónica sustituye legalmente a la firma ológrafa.', colDerX, yDer, { width: 110 });
    yDer = doc.y;
  } else {
    const lineaFirmaY = filaCodigosY + 50;
    doc.moveTo(colDerX, lineaFirmaY).lineTo(colDerX + 110, lineaFirmaY).strokeColor(LINE).lineWidth(1).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Firma y sello', colDerX, lineaFirmaY + 4, { width: 110 });
    yDer = doc.y;
  }

  doc.y = Math.max(yIzq, yDer) + 14;

  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('', doc.page.margins.left, doc.y);
  if (receta.cuir) doc.text(`Receta electrónica original válida — Código/recetario: ${receta.cuir}`);
  if (receta.fechaReceta) doc.text(`Emitida originalmente el ${receta.fechaReceta} vía receta electrónica.`);
  doc.text('Documento de presentación generado a partir de una receta electrónica ya emitida — no reemplaza la validación oficial del código/CUIR indicado arriba.');
  doc.fillColor(TEXT);

  return bufferizar(doc);
}
