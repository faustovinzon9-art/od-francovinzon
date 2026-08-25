// Constantes y helpers puros para leer/escribir la ficha de un paciente, sobre la
// estructura real de la plantilla "FICHA NO MODIFICAR" (inspeccionada a mano en Drive
// antes de programar — ver decisions.md para el detalle completo del layout).
//
// Layout de la hoja (siempre "Hoja 1"):
//   C2:F3  título (fórmula, no tocar)
//   B5:C15 campos del paciente, etiqueta en B, valor en C (ver CAMPO_CELDA)
//   E5:F11 estado financiero — TOTAL/PAGADO/SALDO/AL DÍA/DÍAS SIN PAGO, todo fórmulas
//   B17:H17 encabezados de movimientos: Fecha, Tratamiento, Debe, Haber, Saldo, (G vacía
//     de separador con el bloque de obra social), Forma de pago (columna H, agregada por
//     este módulo — existía oculta y vacía en la plantilla, ver decisions.md)
//   B18 en adelante: filas de movimientos. Saldo (columna F) es SIEMPRE fórmula
//     =SUMA($D$18:D{fila})-SUMA($E$18:E{fila}) — nunca se escribe a mano, y como cada
//     fila sabe recalcularse sola desde la fila 18, alcanza con escribir Debe/Haber para
//     que todos los saldos posteriores queden correctos sin tocarlos.
//   J12:M13 "ESTADO DE PRESTACIONES A OBRA SOCIAL" — título del bloque.
//   L14/L15/L16 son fórmulas (=C11/=C12/=C13, Obra social/Nº de afiliado/Plan) — NUNCA
//     se escriben directo, son solo un espejo de lectura de los mismos campos de la
//     sección principal. Para escribirlos se usa CAMPO_CELDA (C11/C12/C13) como siempre.
//   J17:M17 encabezados de la tabla de prestaciones: Fecha, Tratamiento, Código,
//     Autorizado (checkbox). J18 en adelante: filas de datos, mismo arranque en la fila
//     18 que la tabla de movimientos (columnas independientes, sin relación entre sí).
export const PACIENTES_FOLDER_ID = '1Da7r5C9fc2Nr-zu7GTOAm0_dE0YbmJBm';
export const FICHA_TEMPLATE_ID = '1z23r0pBe0L09YncsBJQd-hUgFttylzFjMY0P-DDE4h4';
export const BACKUP_FOLDER_NAME = '_Respaldo del sistema (no tocar)';
export const SHEET_NAME = 'Hoja 1';
export const FORMA_PAGO_COLUMN_INDEX = 7; // columna H, 0-based (A=0)
// Hoja chica y propia (no la ficha de nadie) dentro de PACIENTES_FOLDER_ID que guarda,
// para cada combinación teléfono+DNI ya resuelta a mano en "¿Es este paciente?", si es
// un match confirmado ("si") o descartado ("no") — para no volver a preguntar lo mismo.
// Se crea sola la primera vez que hace falta (ver getOrCreateMapeoSheetId en
// api/gestion/pacientes.js), mismo patrón que la carpeta de respaldo (BACKUP_FOLDER_NAME).
export const MAPEO_TELEFONO_FICHA_NAME = 'Mapeo teléfono-ficha (no tocar)';

export const CAMPO_CELDA = {
  nombre: 'C5',
  apellido: 'C6',
  dni: 'C7',
  fechaNacimiento: 'C8',
  domicilio: 'C9',
  localidad: 'C10',
  obraSocial: 'C11',
  nAfiliado: 'C12',
  plan: 'C13',
  telefono: 'C14',
  planTratamiento: 'C15',
};

export const CAMPOS_ORDENADOS = [
  'nombre', 'apellido', 'dni', 'fechaNacimiento', 'domicilio', 'localidad',
  'obraSocial', 'nAfiliado', 'plan', 'telefono', 'planTratamiento',
];

export const MOVIMIENTOS_FILA_INICIO = 18;
export const MOVIMIENTOS_FILA_FIN = 2000; // mismo límite que usan las fórmulas de la plantilla

export function rangoMovimientos() {
  return `${SHEET_NAME}!B${MOVIMIENTOS_FILA_INICIO}:H${MOVIMIENTOS_FILA_FIN}`;
}

export function rangoPrestacionesObraSocial() {
  return `${SHEET_NAME}!J${MOVIMIENTOS_FILA_INICIO}:M${MOVIMIENTOS_FILA_FIN}`;
}

// Una celda cuenta como "con dato real" solo si tiene contenido que no sea:
//   - vacío ('' / null / undefined)
//   - un checkbox desmarcado (false) — el checkbox "Autorizado" de la plantilla está
//     aplicado a todo el rango, así que las filas sin marcar devuelven FALSE
//   - el string 'FALSE'/'TRUE' que deja la validación de casilla aplicada por error a
//     columnas de texto (contaminación documentada — ver celdaTextoLimpia en
//     api/gestion/pacientes.js). Un true (checkbox marcado) SÍ es un dato real.
// Este es el criterio ÚNICO de "fila vacía" que usan primeraFilaLibre() y
// confirmarFilaLibre() en api/gestion/pacientes.js, para que la contaminación no
// bloquee el alta de movimientos/prestaciones (bug "La fila 2001 ya tiene datos
// cargados", reportado el 2026-08-24).
export function esCeldaConDatoReal(valor) {
  if (valor === true) return true;                        // checkbox marcado = dato real
  if (valor === false || valor == null) return false;     // checkbox desmarcado / celda vacía
  const s = String(valor).trim();
  if (s === '') return false;
  if (s === 'TRUE' || s === 'FALSE') return false;        // contaminación de validación de casilla
  return true;
}

// BUG CRÍTICO encontrado y arreglado el 2026-08-20 (caso Karen Schneider — ver
// decisions.md): esta función definía "fila libre" mirando SOLO la primera columna
// (fecha, tanto para movimientos como para prestaciones — se reusa para las dos, ver
// los call sites). Una fila con datos reales pero esa primera columna vacía (ej. un
// "Saldo inicial" cargado sin fecha puntual) quedaba marcada como libre, y el próximo
// movimiento/prestación nuevo la SOBREESCRIBÍA en vez de agregarse al final — se perdió
// así un movimiento real de $1.430.000 de una paciente. Ahora una fila solo cuenta como
// libre si las 4 columnas relevantes (para movimientos: fecha/tratamiento/debe/haber;
// para prestaciones: fecha/tratamiento/código/autorizado) están TODAS vacías — mismo
// criterio ya usado para filtrar filas "con contenido" en api/gestion/pacientes.js
// (obtenerFicha).
//
// CORRECCIÓN adicional 2026-08-24 (bug "La fila 2001 ya tiene datos cargados", ver
// esCeldaConDatoReal arriba): "vacía" ahora se decide con esCeldaConDatoReal(), así las
// filas contaminadas con 'FALSE'/'TRUE' (string) de la validación de casilla mal
// aplicada no se cuentan como ocupadas. Además, si ninguna fila del rango está libre,
// devuelve null en vez de MOVIMIENTOS_FILA_INICIO + filas.length — ese cálculo podía
// devolver 2001, una fila FUERA del rango (18..2000) donde la traba de seguridad
// (confirmarFilaLibre) después tiraba "La fila 2001 ya tiene datos cargados" y el alta
// de prestaciones/movimientos quedaba bloqueado para siempre en fichas contaminadas.
// Los call sites manejan null con un mensaje claro (ver api/gestion/pacientes.js).
export function primeraFilaLibre(filas) {
  for (let i = 0; i < filas.length; i++) {
    const [col1, col2, col3, col4] = filas[i] || [];
    const vacia = !esCeldaConDatoReal(col1) && !esCeldaConDatoReal(col2) && !esCeldaConDatoReal(col3) && !esCeldaConDatoReal(col4);
    if (vacia) return MOVIMIENTOS_FILA_INICIO + i;
  }
  return null; // sin fila libre dentro del rango — nunca devolver una fila fuera de él
}

// "Nombre Apellido - 12345678 - Ficha" (con DNI) o "Nombre Apellido - Ficha" (sin DNI
// todavía, se agrega el segmento cuando se carga el DNI más adelante).
export function nombreArchivo({ nombre, apellido, dni }) {
  const base = `${nombre} ${apellido}`.trim();
  return dni && String(dni).trim() ? `${base} - ${dni} - Ficha` : `${base} - Ficha`;
}

export function parsearNombreArchivo(fileName) {
  const sinSufijo = fileName.replace(/\s*-\s*Ficha\s*$/i, '').trim();
  const partes = sinSufijo.split(' - ');
  const nombreCompleto = partes[0] || '';
  const dni = partes[1] || '';
  const espacio = nombreCompleto.lastIndexOf(' ');
  return {
    nombreCompleto,
    dni,
    nombre: espacio === -1 ? nombreCompleto : nombreCompleto.slice(0, espacio),
    apellido: espacio === -1 ? '' : nombreCompleto.slice(espacio + 1),
  };
}

// Solo dígitos, para comparar DNIs sin que puntos/espacios/guiones generen falsos
// negativos ("12.345.678" vs "12345678"). Único criterio de duplicado (ver decisions.md
// — nombre/apellido iguales NO cuentan solos, dan demasiados falsos positivos).
export function normalizarDni(dni) {
  return (dni || '').replace(/\D/g, '');
}

// Últimos 10 dígitos — mismo criterio que normalizarTelefonoComparacion() del cliente
// (pacientes/index.html), para que un número guardado con o sin código de país (549...)
// siga matcheando igual contra la hoja de mapeo teléfono-ficha.
export function normalizarTelefonoMapeo(tel) {
  return (tel || '').replace(/\D/g, '').slice(-10);
}

// Campos que se guardan siempre en mayúsculas, sin importar cómo los tipeen (ver
// decisions.md). DNI/Nº de afiliado/teléfono quedan afuera a propósito: son campos
// numéricos/de identificación, no texto legible que gane algo viéndose en mayúscula.
export const CAMPOS_MAYUSCULAS = new Set([
  'nombre', 'apellido', 'domicilio', 'localidad', 'obraSocial', 'plan', 'planTratamiento',
]);

export function aMayusculas(valor) {
  return valor == null ? valor : String(valor).toUpperCase();
}

// Title Case para los campos de texto legible de la ficha (nombre, apellido,
// localidad, domicilio, obra social, plan, tratamiento) — primera letra de cada
// palabra en mayúscula, el resto en minúscula (ej. "juan carlos pérez" -> "Juan Carlos
// Pérez"). Sin lógica especial para conectores ("de", "del", "la"): con que quede
// razonable alcanza, sin sobre-ingeniería (ej. "San Jose De La Costa" es aceptable
// aunque el "De"/"La" queden en mayúscula). Reemplaza a aMayusculas() SOLO para estos
// campos de ficha — movimientos/prestaciones siguen en mayúscula total, sin cambios.
export function aTituloCase(valor) {
  if (valor == null) return valor;
  // Cualquier letra que sigue a un no-letra (espacio, paréntesis, guion, inicio de
  // string) arranca palabra — no solo espacio, para que "(pueblo belgrano)" -> "(Pueblo
  // Belgrano)" y "maria-jose" -> "Maria-Jose" en vez de quedar con la primera letra
  // después del separador en minúscula.
  return String(valor)
    .toLowerCase()
    .replace(/(^|[^\p{L}])(\p{L})/gu, (_, sep, letra) => sep + letra.toUpperCase());
}
