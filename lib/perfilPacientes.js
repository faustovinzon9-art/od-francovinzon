// Perfil ANÓNIMO de pacientes (2026-09-24) — export de /admin para el trabajo de
// Buyer Persona de la facu. Todo lo de este archivo son funciones puras (sin Google,
// sin red) para poder probarlas con datos simulados; la lectura de fichas/Calendar vive
// en api/gestion/admin.js (exportPerfilPacientes) y le pasa acá SOLO campos no
// identificables.
//
// Reglas de privacidad (no aflojar sin pedido explícito):
//   - Nunca entra acá nombre, apellido, DNI, teléfono, domicilio, email ni Nº de afiliado.
//     El lector de admin.js directamente no los pide a la API.
//   - Los textos libres escritos por el paciente o la secretaria (motivo del turno, plan
//     de tratamiento) NUNCA salen tal cual: solo su categoría.
//   - Localidades y obras sociales con menos de MINIMO_GRUPO pacientes se agrupan en
//     "Otras", para que un valor raro no apunte a una persona puntual.
//   - La salida son solo conteos y porcentajes, nunca filas por paciente.

export const MINIMO_GRUPO = 3;

const quitarTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = (s) => quitarTildes(s).toLowerCase().replace(/\s+/g, ' ').trim();
const tituloCase = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  .replace(/(^|\s)(\p{L})/gu, (m, esp, l) => esp + l.toUpperCase())
  .replace(/\s(Del|De|La|Las|Los|Y)\s/g, (m) => m.toLowerCase());

// ---------- Edad ----------

// Fecha canónica de la ficha: "DD/MM/AAAA" (ver migración del 2026-08-24). Acepta
// también D/M/AAAA y guiones. Devuelve null si no es una fecha real o da una edad absurda.
export function edadDesdeFecha(fechaStr, hoy = new Date()) {
  const m = String(fechaStr || '').trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const [dia, mes, anio] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  let edad = hoy.getFullYear() - anio;
  if (hoy.getMonth() + 1 < mes || (hoy.getMonth() + 1 === mes && hoy.getDate() < dia)) edad--;
  return edad >= 0 && edad <= 105 ? edad : null;
}

export const FRANJAS_ETARIAS = [
  [0, 12, '0–12 (niños)'],
  [13, 17, '13–17 (adolescentes)'],
  [18, 25, '18–25'],
  [26, 35, '26–35'],
  [36, 45, '36–45'],
  [46, 55, '46–55'],
  [56, 65, '56–65'],
  [66, 200, '66 o más'],
];
export function franjaEtaria(edad) {
  if (edad == null) return 'Sin dato';
  const f = FRANJAS_ETARIAS.find(([min, max]) => edad >= min && edad <= max);
  return f ? f[2] : 'Sin dato';
}

// ---------- Financiación ----------

const RE_PARTICULAR = /^(particular(es)?|part\.?|no|no tiene|ninguna?|sin (obra social|os|cobertura)|-+|n\/?a|s\/?os)$/;
export function clasificarFinanciacion(obraSocial) {
  const k = clave(obraSocial);
  if (!k) return 'Sin dato';
  if (RE_PARTICULAR.test(k)) return 'Particular';
  return 'Obra social / prepaga';
}
export function nombreObraSocial(obraSocial) {
  const k = clave(obraSocial);
  if (!k || RE_PARTICULAR.test(k)) return null;
  return String(obraSocial).trim().replace(/\s+/g, ' ').toUpperCase();
}

// ---------- Localidad ----------

// La secretaria escribe la localidad a mano: "C. del Uruguay", "CdelU", "Concepcion del
// uruguay"... todas son la misma. El resto solo se normaliza en mayúsculas/tildes.
export function normalizarLocalidad(localidad) {
  const k = clave(localidad);
  if (!k) return null;
  const compacta = k.replace(/[^a-z]/g, '');
  if (/^c(onc(epcion)?)?(d(el?)?)?u(ruguay|y)?$/.test(compacta) || compacta === 'concepcion') return 'Concepción del Uruguay';
  return tituloCase(quitarTildes(localidad));
}
// Cómo mostrar una localidad agrupada: la versión CON tildes si alguna ficha la escribió
// así ("Colón"), aunque el agrupado se haga sin tildes ("Colon" y "Colón" = la misma).
function mostrarLocalidad(localidad) {
  const k = normalizarLocalidad(localidad);
  if (k === 'Concepción del Uruguay') return k;
  return tituloCase(localidad);
}

// ---------- Tratamientos / motivos ----------

// Mismas familias que el catálogo real del consultorio (ver /admin → Listas y el TPI).
// El orden importa: se queda con la PRIMERA que matchea (lo más específico primero).
export const CATEGORIAS_TRATAMIENTO = [
  ['Implantes', /implant/],
  ['Ortodoncia', /ortod|bracket|alinead|invisal|aparat|arco|brakets?/],
  ['Odontopediatría', /pediatr|sellador|biopulp|fluor|nin[oa]s?\b/],
  ['Endodoncia', /endodon|conducto|pulpect|pulpot/],
  ['Blanqueamiento', /blanque/],
  ['Prótesis y carillas', /protesis|corona|perno|puente|removible|dentadura|carilla|disilicato|zirconi|incrustac/],
  ['Placa / bruxismo', /placa|bruxis|relajac|miorelaj/],
  ['Limpieza y periodoncia', /limpieza|profilax|tartrect|destartr|sarro|periodon|raspaje|curetaje|encias?/],
  ['Operatoria / arreglos (caries)', /caries|restaur|obturac|arregl|composite|resina|amalgama|reconstruc|rot[oa]|rompi|fractur|parti[oó]|se me cayo|empaste/],
  ['Cirugía / extracciones', /extracc|exodon|cirug|muela de juicio|tercer(os)? molar|sacar/],
  ['Urgencia / dolor', /urgenc|dolor|duel|flemon|absces|inflam|hinchad/],
  ['Consulta / control / diagnóstico', /consulta|control|revisi|diagnost|radiograf|\brx\b|escaneo|panoramic|presupuest|evaluac|chequeo|primera vez/],
];
export function categoriaTratamiento(texto) {
  const k = clave(texto);
  if (!k || k === '-') return null;
  const c = CATEGORIAS_TRATAMIENTO.find(([, re]) => re.test(k));
  return c ? c[0] : 'Otros';
}

// Fila de movimientos que es solo un cobro, no una prestación.
const RE_PAGO = /^(pago|entrega|sena|abono|a cuenta|saldo|cobro|transferencia|efectivo|cuota)\b/;
export function esSoloPago(tratamiento) {
  return RE_PAGO.test(clave(tratamiento));
}

export function montoArgentino(texto) {
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '').replace(/\./g, '');
  return parseFloat(limpio.replace(',', '.')) || 0;
}

function fechaSheetAIso(fechaStr) {
  const m = String(fechaStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// ---------- Armado de la tabla ----------

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function contar(mapa, k, n = 1) { mapa.set(k, (mapa.get(k) || 0) + n); }

// Agrupa en "Otras…" todo lo que tenga menos de `minimo` (anonimato).
function suprimirChicos(mapa, etiquetaOtros, minimo) {
  const out = new Map();
  mapa.forEach((n, k) => contar(out, n >= minimo ? k : etiquetaOtros, n));
  return out;
}

/**
 * @param {object} p
 * @param {Array<{fechaNacimiento, localidad, obraSocial, planTratamiento,
 *   movimientos: Array<{fecha, tratamiento, debe, haber, formaPago}>}>} p.fichas
 * @param {Array<{inicio: {dia: number, hora: number, fechaISO: string}, tipo,
 *   esNuevo: boolean, cargadoManual: boolean, motivo: string}>} p.turnos
 * @param {Array<{visitas: number, turnosPasados: number, turnosAsistidos: number}>} p.consolidados
 * @returns {{ filas: Array<[string,string,string,number,number|null]>, resumen: object }}
 *   filas = [sección, categoría, detalle, cantidad, porcentaje dentro de la sección]
 */
export function construirPerfil({ fichas = [], turnos = [], consolidados = [], hoy = new Date(), minimo = MINIMO_GRUPO, meta = {} }) {
  const filas = [];
  const seccion = (nombre, mapa, { orden, detalle = () => '', nota } = {}) => {
    const entradas = [...mapa.entries()];
    if (orden) entradas.sort((a, b) => orden.indexOf(a[0]) - orden.indexOf(b[0]));
    else entradas.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'es'));
    const total = entradas.reduce((acc, [, n]) => acc + n, 0);
    entradas.forEach(([k, n]) => filas.push([nombre, String(k), detalle(k), n, total ? Math.round((n / total) * 1000) / 10 : null]));
    if (nota) filas.push([nombre, '(nota)', nota, '', null]);
  };
  const cruce = (nombre, mapa, ordenFilas) => {
    // mapa: "fila||columna" -> n. Porcentaje = dentro de cada fila (ej. dentro de cada franja).
    const totalPorFila = new Map();
    mapa.forEach((n, k) => contar(totalPorFila, k.split('||')[0], n));
    [...mapa.entries()]
      .sort((a, b) => {
        const [fa, ca] = a[0].split('||'); const [fb, cb] = b[0].split('||');
        return (ordenFilas ? ordenFilas.indexOf(fa) - ordenFilas.indexOf(fb) : fa.localeCompare(fb)) || b[1] - a[1] || ca.localeCompare(cb);
      })
      .forEach(([k, n]) => {
        const [f, c] = k.split('||');
        const t = totalPorFila.get(f);
        filas.push([nombre, f, c, n, t ? Math.round((n / t) * 1000) / 10 : null]);
      });
  };
  const ordenFranjas = [...FRANJAS_ETARIAS.map((f) => f[2]), 'Sin dato'];

  // ---- Fichas ----
  const porFranja = new Map(), porFinanciacion = new Map(), porObraSocial = new Map(), porLocalidad = new Map();
  const tratRegistros = new Map(), tratPacientes = new Map(), tratTexto = new Map(), formaPago = new Map();
  const planTrat = new Map(), anioPrimeraVisita = new Map(), prestacionesPorPaciente = new Map();
  const franjaXfin = new Map(), franjaXtrat = new Map();
  const edades = [];
  const nombreLocalidad = new Map();

  fichas.forEach((f) => {
    const edad = edadDesdeFecha(f.fechaNacimiento, hoy);
    const franja = franjaEtaria(edad);
    if (edad != null) edades.push(edad);
    contar(porFranja, franja);

    const fin = clasificarFinanciacion(f.obraSocial);
    contar(porFinanciacion, fin);
    contar(franjaXfin, `${franja}||${fin}`);
    const os = nombreObraSocial(f.obraSocial);
    if (os) contar(porObraSocial, os);

    const loc = normalizarLocalidad(f.localidad) || 'Sin dato';
    contar(porLocalidad, loc);
    if (loc !== 'Sin dato') {
      const visible = mostrarLocalidad(f.localidad);
      if (!nombreLocalidad.has(loc) || (/[^\x00-\x7F]/.test(visible) && !/[^\x00-\x7F]/.test(nombreLocalidad.get(loc)))) nombreLocalidad.set(loc, visible);
    }

    const catPlan = categoriaTratamiento(f.planTratamiento);
    if (catPlan) contar(planTrat, catPlan);

    const catsDelPaciente = new Set();
    let prestaciones = 0;
    let primera = null;
    (f.movimientos || []).forEach((m) => {
      const trat = String(m.tratamiento || '').trim();
      if (/^\[ANULADO\]/i.test(trat)) return;
      const iso = fechaSheetAIso(m.fecha);
      if (iso && (!primera || iso < primera)) primera = iso;
      if (montoArgentino(m.haber) > 0 && m.formaPago) contar(formaPago, tituloCase(m.formaPago));
      if (!trat || esSoloPago(trat)) return;
      const cat = categoriaTratamiento(trat);
      if (!cat) return;
      prestaciones++;
      contar(tratRegistros, cat);
      catsDelPaciente.add(cat);
      contar(tratTexto, tituloCase(quitarTildes(trat)));
    });
    catsDelPaciente.forEach((c) => { contar(tratPacientes, c); contar(franjaXtrat, `${franja}||${c}`); });
    if (primera) contar(anioPrimeraVisita, primera.slice(0, 4));
    contar(prestacionesPorPaciente,
      prestaciones === 0 ? '0 (sin prestaciones cargadas)' : prestaciones === 1 ? '1' : prestaciones <= 3 ? '2–3' : prestaciones <= 9 ? '4–9' : '10 o más');
  });

  const nFichas = fichas.length;
  filas.push(['Resumen', 'Fichas de pacientes analizadas', '', nFichas, null]);
  if (meta.fichasFallidas) filas.push(['Resumen', 'Fichas que no se pudieron leer', '', meta.fichasFallidas, null]);
  filas.push(['Resumen', 'Turnos analizados (Calendar)', meta.rangoTurnos || '', turnos.length, null]);
  filas.push(['Resumen', 'Pacientes en planilla consolidada', 'incluye los que solo sacaron turno, sin ficha', consolidados.length, null]);
  if (edades.length) {
    const ord = [...edades].sort((a, b) => a - b);
    const mediana = ord.length % 2 ? ord[(ord.length - 1) / 2] : (ord[ord.length / 2 - 1] + ord[ord.length / 2]) / 2;
    filas.push(['Resumen', 'Edad promedio (años)', `sobre ${edades.length} fichas con fecha de nacimiento`, Math.round((edades.reduce((a, b) => a + b, 0) / edades.length) * 10) / 10, null]);
    filas.push(['Resumen', 'Edad mediana (años)', 'la mitad de los pacientes tiene menos que esto', mediana, null]);
  }
  filas.push(['Resumen', 'Grupos chicos agrupados en "Otras"', `localidades y obras sociales con menos de ${minimo} pacientes`, minimo, null]);

  seccion('Edad (franja)', porFranja, { orden: ordenFranjas });
  seccion('Financiación', porFinanciacion, {
    orden: ['Particular', 'Obra social / prepaga', 'Sin dato'],
    nota: '"Sin dato" = campo Obra social vacío en la ficha (puede ser particular no cargado)',
  });
  seccion('Obra social / prepaga (nombre)', suprimirChicos(porObraSocial, 'Otras obras sociales', minimo));
  const porLocalidadVisible = new Map();
  porLocalidad.forEach((n, k) => contar(porLocalidadVisible, nombreLocalidad.get(k) || k, n));
  seccion('Localidad', suprimirChicos(porLocalidadVisible, 'Otras localidades', minimo));
  seccion('Tratamientos — cantidad de prestaciones', tratRegistros);
  seccion('Tratamientos — pacientes que lo hicieron al menos una vez', tratPacientes, {
    nota: 'un mismo paciente puede estar en varias categorías, los % no suman 100 sobre pacientes',
  });
  seccion('Tratamientos — nombres más frecuentes (texto de la ficha)',
    new Map([...tratTexto.entries()].filter(([, n]) => n >= minimo).sort((a, b) => b[1] - a[1]).slice(0, 30)));
  seccion('Plan de tratamiento (categoría)', planTrat);
  seccion('Prestaciones cargadas por paciente', prestacionesPorPaciente, { orden: ['0 (sin prestaciones cargadas)', '1', '2–3', '4–9', '10 o más'] });
  seccion('Año de la primera visita registrada', anioPrimeraVisita, { orden: [...anioPrimeraVisita.keys()].sort() });
  seccion('Forma de pago (cobros)', formaPago);
  cruce('Cruce: franja etaria × financiación', franjaXfin, ordenFranjas);
  cruce('Cruce: franja etaria × tratamiento (pacientes)', franjaXtrat, ordenFranjas);

  // ---- Turnos (Calendar) ----
  const porDia = new Map(), porHora = new Map(), porFranjaHoraria = new Map(), diaXfranja = new Map();
  const porMes = new Map(), nuevos = new Map(), origen = new Map(), tipo = new Map(), motivos = new Map();
  turnos.forEach((t) => {
    const dia = DIAS_SEMANA[t.inicio.dia];
    const franjaH = t.inicio.hora < 13 ? 'Mañana (antes de 13 h)' : t.inicio.hora < 17 ? 'Tarde temprano (13–17 h)' : 'Tarde (17 h o más)';
    contar(porDia, dia);
    contar(porHora, `${String(t.inicio.hora).padStart(2, '0')}:00`);
    contar(porFranjaHoraria, franjaH);
    contar(diaXfranja, `${dia}||${franjaH}`);
    contar(porMes, t.inicio.fechaISO.slice(0, 7));
    contar(nuevos, t.esNuevo ? 'Paciente nuevo' : 'Paciente que ya venía');
    contar(origen, t.cargadoManual ? 'Cargado por la secretaria (teléfono/WhatsApp/presencial)' : 'Reservado online por el paciente');
    contar(tipo, t.tipo === 'sobreturno' ? 'Sobreturno' : 'Turno normal');
    contar(motivos, categoriaTratamiento(t.motivo) || 'Sin motivo escrito');
  });
  const ordenDias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  seccion('Turnos por día de la semana', porDia, { orden: ordenDias });
  seccion('Turnos por hora de inicio', porHora, { orden: [...porHora.keys()].sort() });
  seccion('Turnos por franja horaria', porFranjaHoraria, { orden: ['Mañana (antes de 13 h)', 'Tarde temprano (13–17 h)', 'Tarde (17 h o más)'] });
  cruce('Cruce: día × franja horaria', diaXfranja, ordenDias);
  seccion('Turnos por mes', porMes, { orden: [...porMes.keys()].sort() });
  seccion('Turnos: paciente nuevo vs. que ya venía', nuevos, { nota: 'marcado en el turno ("Paciente nuevo: Sí/No"); turnos viejos sin la marca cuentan como "ya venía"' });
  seccion('Turnos: canal de reserva', origen);
  seccion('Turnos: tipo', tipo);
  seccion('Motivo de consulta escrito al reservar (categoría)', motivos, { nota: 'solo categorías, nunca el texto; el motivo es opcional y casi siempre lo completa quien reserva online' });

  // ---- Fidelidad (planilla consolidada) ----
  const visitas = new Map();
  let pasados = 0, asistidos = 0;
  consolidados.forEach((c) => {
    const v = c.visitas || 0;
    contar(visitas, v === 0 ? '0 (sin visitas registradas aún)' : v === 1 ? '1 visita' : v <= 3 ? '2–3 visitas' : v <= 9 ? '4–9 visitas' : '10 o más visitas');
    pasados += c.turnosPasados || 0;
    asistidos += c.turnosAsistidos || 0;
  });
  seccion('Visitas por paciente', visitas, { orden: ['0 (sin visitas registradas aún)', '1 visita', '2–3 visitas', '4–9 visitas', '10 o más visitas'] });
  if (pasados) filas.push(['Asistencia', 'Turnos pasados con asistencia registrada', `${asistidos} de ${pasados}`, asistidos, Math.round((asistidos / pasados) * 1000) / 10]);

  return { filas };
}

// CSV pensado para Excel/Sheets en español: separador ";" y coma decimal.
export function perfilACsv(filas) {
  const esc = (v) => {
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return ['Sección;Categoría;Detalle;Cantidad;Porcentaje en la sección', ...filas.map((f) => f.map(esc).join(';'))].join('\n');
}
