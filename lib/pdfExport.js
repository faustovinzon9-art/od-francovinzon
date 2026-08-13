// Generación de PDFs para las exportaciones de /admin (sección "Datos de pacientes" y
// "Horarios y agenda" del pedido) — pdfkit es la única dependencia nueva de todo este
// panel: no hay forma razonable de armar un PDF real sin una librería (a diferencia de
// los emails de Resend, que sí se pudieron resolver con un fetch directo). Sin estilos
// elaborados a propósito — texto simple, tablas simples, mismo criterio de "no
// sobre-ingenierizar" del resto del pedido.
import PDFDocument from 'pdfkit';

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

function dibujarTabla(doc, { columnas, filas, anchoColumna }) {
  const startX = doc.page.margins.left;
  let y = doc.y;
  const rowHeight = 20;

  doc.font('Helvetica-Bold').fontSize(9);
  columnas.forEach((col, i) => {
    doc.text(col, startX + i * anchoColumna, y, { width: anchoColumna, ellipsis: true });
  });
  y += rowHeight;
  doc.moveTo(startX, y - 4).lineTo(startX + anchoColumna * columnas.length, y - 4).strokeColor('#999').stroke();

  doc.font('Helvetica').fontSize(9);
  filas.forEach((fila) => {
    if (y > doc.page.height - doc.page.margins.bottom - rowHeight) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    fila.forEach((celda, i) => {
      doc.text(String(celda ?? ''), startX + i * anchoColumna, y, { width: anchoColumna, ellipsis: true });
    });
    y += rowHeight;
  });
  doc.y = y;
}

// Tabla genérica (usada por la exportación de turnos).
export async function generarPdfTabla({ titulo, columnas, filas }) {
  const doc = nuevoDoc();
  doc.font('Helvetica-Bold').fontSize(16).text(titulo, { align: 'left' });
  doc.moveDown(1);
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

  doc.font('Helvetica-Bold').fontSize(18).text(soloFinanciero ? 'Estado de cuenta' : 'Ficha de paciente', { align: 'left' });
  doc.font('Helvetica').fontSize(11).text(nombreCompleto);
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#666').text(`Generado el ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  doc.fillColor('#000');
  doc.moveDown(1);

  if (!soloFinanciero) {
    doc.font('Helvetica-Bold').fontSize(12).text('Datos');
    doc.font('Helvetica').fontSize(10);
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
    doc.font('Helvetica-Bold').fontSize(12).text('Estado financiero');
    doc.font('Helvetica').fontSize(10).text(`Total: ${financiero.total}    Pagado: ${financiero.pagado}    Saldo: ${financiero.saldo}`);
    doc.moveDown(1);
  }

  doc.font('Helvetica-Bold').fontSize(12).text('Movimientos');
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
