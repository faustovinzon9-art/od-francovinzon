// Extrae campos estructurados del texto OCR de una receta MisRX/RCTA (ver
// decisions.md — capa de presentación sobre una receta YA emitida, no un
// generador de recetas legales). El texto de entrada viene de la página
// "original" seguida de su "Duplicado" (misma info repetida) — como se busca
// siempre la PRIMERA ocurrencia de cada etiqueta, se lee de la página
// original, nunca del duplicado.
//
// Regla dura: nunca inventar ni completar un campo que no esté literalmente en
// el texto. Si una etiqueta no aparece, el campo queda `null` — quien llama
// debe mostrarlo en blanco y marcado para corrección manual, nunca asumir un
// valor.
//
// Por qué línea por línea y no un regex multilínea: el texto que devuelve el
// OCR de Drive viene con saltos de línea \r\n, y varias etiquetas son
// substring una de otra ("Afiliado:" dentro de "Nro Afiliado:") — un regex
// tipo /Afiliado:\s*(.+)/ matchea por accidente el "Afiliado:" que está
// pegado adentro de "Nro Afiliado:" y devuelve el número de afiliado en vez
// del nombre del paciente (bug real, encontrado probando con el PDF real de
// muestra). Comparar el PREFIJO exacto de cada línea evita esta clase entera
// de error.
function lineas(texto) {
  return String(texto || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim());
}

function valorEnMismaLinea(lns, etiqueta) {
  const linea = lns.find((l) => l.startsWith(etiqueta));
  if (!linea) return null;
  const valor = linea.slice(etiqueta.length).trim();
  return valor || null;
}

function valorEnLineaSiguiente(lns, etiqueta, { soloDigitos } = {}) {
  const idx = lns.findIndex((l) => l === etiqueta || l.startsWith(etiqueta));
  if (idx === -1) return null;
  // La propia línea de la etiqueta puede traer el valor pegado (variante sin
  // salto de línea) — si no, buscar la primera línea no vacía después,
  // salteando ruido de OCR como el bloque de barras "||||" del código de barras.
  const pegado = lns[idx].slice(etiqueta.length).trim();
  if (pegado) return pegado;
  for (let i = idx + 1; i < lns.length && i < idx + 5; i++) {
    const l = lns[i];
    if (!l) continue;
    if (soloDigitos && !/^\d{4,}$/.test(l)) continue;
    return l;
  }
  return null;
}

export function parsearReceta(textoOcr) {
  const lns = lineas(textoOcr);

  const idxRp = lns.findIndex((l) => l === 'RP/');
  const idxFirmado = lns.findIndex((l, i) => i > idxRp && l.startsWith('Firmado electrónicamente por:'));
  const bloqueRp = idxRp !== -1 && idxFirmado !== -1 ? lns.slice(idxRp + 1, idxFirmado).join('\n') : null;
  const medicamentos = bloqueRp
    ? bloqueRp
        .split(/\n?•\s*/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const cantidadM = item.match(/Cantidad:\s*(\d+)/);
          const diagnosticoM = item.match(/Diagnóstico:\s*(.+)/);
          const descripcion = item.split(/\s*Cantidad:/)[0].replace(/\n/g, ' ').trim() || null;
          return {
            descripcion,
            cantidad: cantidadM ? cantidadM[1].trim() : null,
            diagnostico: diagnosticoM ? diagnosticoM[1].trim() : null,
          };
        })
    : [];

  return {
    fechaReceta: valorEnMismaLinea(lns, 'Fecha Receta:'),
    cuir: valorEnLineaSiguiente(lns, 'Recetario:', { soloDigitos: true }),
    nroAfiliado: valorEnLineaSiguiente(lns, 'Nro Afiliado:'),
    obraSocial: valorEnMismaLinea(lns, 'OS:'),
    paciente: valorEnMismaLinea(lns, 'Afiliado:'),
    dni: valorEnMismaLinea(lns, 'D.N.I.:'),
    cuil: valorEnMismaLinea(lns, 'CUIL:'),
    sexo: valorEnMismaLinea(lns, 'Sexo:'),
    fechaNacimiento: valorEnMismaLinea(lns, 'Fecha Nacimiento:'),
    medicamentos,
    profesional: {
      nombre: valorEnMismaLinea(lns, 'Dr/a:'),
      refeps: valorEnMismaLinea(lns, 'REFEPS:'),
      matricula: valorEnMismaLinea(lns, 'Matricula:'),
      profesion: valorEnMismaLinea(lns, 'Profesión:'),
      direccion: valorEnMismaLinea(lns, 'Dirección:'),
    },
    posologia: valorEnLineaSiguiente(lns, 'Posología / Notas:'),
    emitida: valorEnMismaLinea(lns, 'Emitida:'),
  };
}

// Campos que, si faltan, ameritan avisar en la vista previa que hay que
// completar/corregir a mano antes de compartir (el paciente y el CUIR son los
// más críticos: sin CUIR no queda trazable la receta electrónica original).
export function camposFaltantes(receta) {
  const faltan = [];
  if (!receta.cuir) faltan.push('cuir');
  if (!receta.paciente) faltan.push('paciente');
  if (!receta.dni) faltan.push('dni');
  if (!receta.medicamentos || receta.medicamentos.length === 0) faltan.push('medicamentos');
  if (!receta.profesional?.nombre) faltan.push('profesional.nombre');
  if (!receta.profesional?.matricula) faltan.push('profesional.matricula');
  return faltan;
}
