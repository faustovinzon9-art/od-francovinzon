// Export COMPLETO de pacientes (2026-09-24) — botón "Exportar todos los datos" de /admin.
// A diferencia de lib/perfilPacientes.js (anónimo, solo totales), acá SÍ van los datos
// personales: una fila por paciente con todos los campos de la ficha, más una hoja de
// movimientos y otra de prestaciones a obra social. Solo accesible con ADMIN_KEY.
//
// Funciones puras (sin Google): armarHojas() arma las tablas a partir de lo que lee
// api/gestion/admin.js (exportPacientesCompleto), y crearXlsx()/crearMarkdown() las
// convierten en archivo. El .xlsx se arma a mano (OOXML mínimo + zip con fflate) para no
// sumar una librería pesada de Excel a la función serverless.
import { zipSync, strToU8 } from 'fflate';

// ---------- Helpers de datos ----------

const quitarTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

export function montoArgentino(texto) {
  if (typeof texto === 'number') return texto;
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '').replace(/\./g, '');
  if (!limpio) return null;
  const n = parseFloat(limpio.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// "D/M/AAAA" -> { iso: 'AAAA-MM-DD', texto: 'DD/MM/AAAA' } o null.
export function parsearFecha(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const [d, mo, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return { iso: `${a}-${pad(mo)}-${pad(d)}`, texto: `${pad(d)}/${pad(mo)}/${a}` };
}

export function edad(fechaNacimiento, hoy = new Date()) {
  const f = parsearFecha(fechaNacimiento);
  if (!f) return null;
  const [a, mo, d] = f.iso.split('-').map(Number);
  let e = hoy.getFullYear() - a;
  if (hoy.getMonth() + 1 < mo || (hoy.getMonth() + 1 === mo && hoy.getDate() < d)) e--;
  return e >= 0 && e <= 110 ? e : null;
}

const RE_PAGO = /^(pago|entrega|sena|abono|a cuenta|saldo|cobro|transferencia|efectivo|cuota)\b/;
const esSoloPago = (t) => RE_PAGO.test(quitarTildes(t).toLowerCase().trim());
const tituloCase = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  .replace(/(^|\s)(\p{L})/gu, (m, esp, l) => esp + l.toUpperCase());
const ordenNombre = (a, b) => `${a.apellido} ${a.nombre}`.localeCompare(`${b.apellido} ${b.nombre}`, 'es', { sensitivity: 'base' });

// ---------- Armado de las tablas ----------
// Cada hoja: { nombre, columnas: [{ titulo, tipo, ancho }], filas: [[...valores]] }
// tipo: 'texto' | 'numero' | 'moneda' | 'fecha' (valor = { iso, texto }) | 'porcentaje' (0..1) | 'link'

/**
 * @param {object} p
 * @param {Array} p.fichas  [{ id, campos: {nombre, apellido, dni, fechaNacimiento, domicilio, localidad,
 *   obraSocial, nAfiliado, plan, telefono, planTratamiento}, financiero: {total, pagado, saldo, estado},
 *   movimientos: [{fecha, tratamiento, debe, haber, saldo, formaPago}], prestaciones: [{fecha, tratamiento, codigo, autorizado}] }]
 * @param {Array} p.consolidados  filas de la planilla "Pacientes consolidados"
 */
export function armarHojas({ fichas = [], consolidados = [], hoy = new Date() }) {
  const consolidadoPorFicha = new Map(consolidados.filter((c) => c.fichaId).map((c) => [c.fichaId, c]));

  const pacientes = [];
  const movimientos = [];
  const prestaciones = [];

  fichas.forEach((f) => {
    const c = f.campos || {};
    const cons = consolidadoPorFicha.get(f.id) || {};
    const movsValidos = (f.movimientos || []).filter((m) => m.fecha || m.tratamiento || m.debe || m.haber);
    const tratamientos = [];
    let cantPrestaciones = 0;
    let primera = null, ultima = null;
    movsValidos.forEach((m) => {
      const anulado = /^\[ANULADO\]/i.test(m.tratamiento || '');
      const fecha = parsearFecha(m.fecha);
      movimientos.push({
        orden: `${c.apellido} ${c.nombre}`, fechaIso: fecha?.iso || '',
        fila: [c.apellido, c.nombre, c.dni, fecha || m.fecha, m.tratamiento, montoArgentino(m.debe), montoArgentino(m.haber), montoArgentino(m.saldo), m.formaPago, anulado ? 'Sí' : ''],
      });
      if (anulado) return;
      if (fecha) {
        if (!primera || fecha.iso < primera.iso) primera = fecha;
        if (!ultima || fecha.iso > ultima.iso) ultima = fecha;
      }
      const t = String(m.tratamiento || '').trim();
      if (t && !esSoloPago(t)) {
        cantPrestaciones++;
        const nombreT = tituloCase(t);
        if (!tratamientos.includes(nombreT)) tratamientos.push(nombreT);
      }
    });
    (f.prestaciones || []).filter((p) => p.fecha || p.tratamiento || p.codigo).forEach((p) => {
      const fecha = parsearFecha(p.fecha);
      prestaciones.push({
        orden: `${c.apellido} ${c.nombre}`, fechaIso: fecha?.iso || '',
        fila: [c.apellido, c.nombre, c.dni, c.obraSocial, fecha || p.fecha, p.tratamiento, p.codigo, p.autorizado ? 'Sí' : 'No'],
      });
    });

    const pasados = cons.turnosPasados || 0;
    pacientes.push({
      apellido: c.apellido || '', nombre: c.nombre || '',
      fila: [
        c.apellido, c.nombre, c.dni, parsearFecha(c.fechaNacimiento) || c.fechaNacimiento, edad(c.fechaNacimiento, hoy),
        c.telefono || cons.telefono || '', cons.email || '', c.domicilio, c.localidad, c.obraSocial, c.nAfiliado, c.plan,
        c.planTratamiento, montoArgentino(f.financiero?.total), montoArgentino(f.financiero?.pagado), montoArgentino(f.financiero?.saldo),
        f.financiero?.estado || '', cantPrestaciones, tratamientos.join(' · '), primera, ultima,
        cons.visitas ?? null, pasados || null, pasados ? cons.turnosAsistidos || 0 : null, pasados ? (cons.turnosAsistidos || 0) / pasados : null,
        'Sí', f.id ? `https://docs.google.com/spreadsheets/d/${f.id}/edit` : '',
      ],
    });
  });

  // Pacientes que solo sacaron turno (están en la planilla consolidada pero sin ficha).
  consolidados.filter((c) => !c.fichaId).forEach((c) => {
    const pasados = c.turnosPasados || 0;
    pacientes.push({
      apellido: c.apellido || '', nombre: c.nombre || '',
      fila: [
        c.apellido, c.nombre, c.dni, null, null, c.telefono, c.email, '', '', '', '', '', '', null, null, null, '', null, '',
        null, c.ultimaVisita ? parsearFecha(c.ultimaVisita.split('-').reverse().join('/')) : null,
        c.visitas ?? null, pasados || null, pasados ? c.turnosAsistidos || 0 : null, pasados ? (c.turnosAsistidos || 0) / pasados : null,
        'No (solo turno)', '',
      ],
    });
  });

  pacientes.sort(ordenNombre);
  const porPacienteYFecha = (a, b) => a.orden.localeCompare(b.orden, 'es', { sensitivity: 'base' }) || a.fechaIso.localeCompare(b.fechaIso);
  movimientos.sort(porPacienteYFecha);
  prestaciones.sort(porPacienteYFecha);

  const col = (titulo, tipo = 'texto', ancho = 16) => ({ titulo, tipo, ancho });
  return [
    {
      nombre: 'Pacientes',
      columnas: [
        col('Apellido', 'texto', 18), col('Nombre', 'texto', 18), col('DNI', 'texto', 12), col('Fecha de nacimiento', 'fecha', 19),
        col('Edad', 'numero', 7), col('Teléfono', 'texto', 17), col('Email', 'texto', 26), col('Domicilio', 'texto', 26),
        col('Localidad', 'texto', 20), col('Obra social', 'texto', 16), col('Nº de afiliado', 'texto', 16), col('Plan', 'texto', 12),
        col('Plan de tratamiento', 'texto', 30), col('Total', 'moneda', 14), col('Pagado', 'moneda', 14), col('Saldo', 'moneda', 14),
        col('Estado de cuenta', 'texto', 16), col('Prestaciones', 'numero', 11), col('Tratamientos realizados', 'texto', 45),
        col('Primera visita', 'fecha', 14), col('Última visita', 'fecha', 14), col('Visitas', 'numero', 8),
        col('Turnos pasados', 'numero', 15), col('Turnos asistidos', 'numero', 16), col('% asistencia', 'porcentaje', 13),
        col('Tiene ficha', 'texto', 14), col('Link a la ficha', 'link', 20),
      ],
      filas: pacientes.map((p) => p.fila),
    },
    {
      nombre: 'Movimientos',
      columnas: [
        col('Apellido', 'texto', 18), col('Nombre', 'texto', 18), col('DNI', 'texto', 12), col('Fecha', 'fecha', 12),
        col('Tratamiento', 'texto', 34), col('Debe', 'moneda', 14), col('Haber', 'moneda', 14), col('Saldo', 'moneda', 14),
        col('Forma de pago', 'texto', 15), col('Anulado', 'texto', 9),
      ],
      filas: movimientos.map((m) => m.fila),
    },
    {
      nombre: 'Prestaciones obra social',
      columnas: [
        col('Apellido', 'texto', 18), col('Nombre', 'texto', 18), col('DNI', 'texto', 12), col('Obra social', 'texto', 16),
        col('Fecha', 'fecha', 12), col('Tratamiento', 'texto', 34), col('Código', 'texto', 12), col('Autorizado', 'texto', 11),
      ],
      filas: prestaciones.map((p) => p.fila),
    },
  ];
}

// ---------- .xlsx ----------

const XML_INVALIDO = /[^\x09\x0A\x0D\x20-퟿-�]/g;
const xmlEsc = (s) => String(s).replace(XML_INVALIDO, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function letraColumna(n) { // 0 -> A
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function serialExcel(iso) { // días desde 1899-12-30
  const [a, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

// Estilos (índices de cellXfs): 0 normal, 1 encabezado, 2 fecha, 3 moneda, 4 porcentaje, 5 entero, 6 link
const ESTILO = { encabezado: 1, fecha: 2, moneda: 3, porcentaje: 4, numero: 5, link: 6 };

function celda(ref, valor, tipo) {
  if (valor == null || valor === '') return '';
  if (tipo === 'fecha' && typeof valor === 'object' && valor.iso) return `<c r="${ref}" s="${ESTILO.fecha}"><v>${serialExcel(valor.iso)}</v></c>`;
  if ((tipo === 'moneda' || tipo === 'numero' || tipo === 'porcentaje') && typeof valor === 'number' && Number.isFinite(valor)) {
    return `<c r="${ref}" s="${ESTILO[tipo]}"><v>${valor}</v></c>`;
  }
  if (tipo === 'link' && /^https?:\/\//.test(valor)) {
    const url = xmlEsc(valor);
    return `<c r="${ref}" s="${ESTILO.link}"><f>HYPERLINK("${url}","Abrir ficha")</f><v>Abrir ficha</v></c>`;
  }
  const texto = typeof valor === 'object' && valor.texto ? valor.texto : String(valor);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(texto)}</t></is></c>`;
}

function hojaXml({ columnas, filas }) {
  const ultimaCol = letraColumna(columnas.length - 1);
  const cols = columnas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho}" customWidth="1"/>`).join('');
  const encabezado = `<row r="1">${columnas.map((c, i) => `<c r="${letraColumna(i)}1" t="inlineStr" s="${ESTILO.encabezado}"><is><t>${xmlEsc(c.titulo)}</t></is></c>`).join('')}</row>`;
  const cuerpo = filas.map((fila, r) => `<row r="${r + 2}">${columnas.map((c, i) => celda(`${letraColumna(i)}${r + 2}`, fila[i], c.tipo)).join('')}</row>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols}</cols><sheetData>${encabezado}${cuerpo}</sheetData>`
    + `<autoFilter ref="A1:${ultimaCol}${Math.max(filas.length + 1, 2)}"/>`
    + '</worksheet>';
}

const nombreHojaSeguro = (s) => String(s).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);

export function crearXlsx(hojas) {
  const archivos = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + hojas.map((h, i) => `<sheet name="${xmlEsc(nombreHojaSeguro(h.nombre))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets><definedNames>'
      + hojas.map((h, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(nombreHojaSeguro(h.nombre))}'!$A$1:$${letraColumna(h.columnas.length - 1)}$${Math.max(h.filas.length + 1, 2)}</definedName>`).join('')
      + '</definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot; #,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>'
      + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF1155CC"/><name val="Calibri"/></font></fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F4F4F"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="7">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
      + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>',
  };
  hojas.forEach((h, i) => { archivos[`xl/worksheets/sheet${i + 1}.xml`] = hojaXml(h); });
  const entradas = {};
  Object.entries(archivos).forEach(([k, v]) => { entradas[k] = strToU8(v); });
  return zipSync(entradas, { level: 6 });
}

// ---------- .md ----------

function valorMd(valor, tipo) {
  if (valor == null || valor === '') return '';
  if (typeof valor === 'object' && valor.texto) return valor.texto;
  if (tipo === 'moneda' && typeof valor === 'number') return '$ ' + valor.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (tipo === 'porcentaje' && typeof valor === 'number') return `${Math.round(valor * 100)}%`;
  if (tipo === 'link') return `[Abrir ficha](${valor})`;
  return String(valor).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function crearMarkdown(hojas, { generado = '' } = {}) {
  const partes = [
    '# Pacientes — Consultorio Odontológico Franco Vinzón',
    '',
    `Exportado desde /admin${generado ? ` el ${generado}` : ''}.`,
    '',
    '> **Confidencial:** contiene datos personales y de salud de pacientes. No compartir ni subir a lugares públicos.',
    '',
    hojas.map((h) => `- ${h.nombre}: ${h.filas.length} filas`).join('\n'),
  ];
  hojas.forEach((h) => {
    partes.push('', `## ${h.nombre} (${h.filas.length})`, '');
    if (!h.filas.length) { partes.push('_Sin datos._'); return; }
    partes.push(`| ${h.columnas.map((c) => c.titulo).join(' | ')} |`);
    partes.push(`| ${h.columnas.map((c) => (['moneda', 'numero', 'porcentaje'].includes(c.tipo) ? '---:' : '---')).join(' | ')} |`);
    h.filas.forEach((f) => partes.push(`| ${h.columnas.map((c, i) => valorMd(f[i], c.tipo)).join(' | ')} |`));
  });
  return partes.join('\n') + '\n';
}
