// Feriados argentinos — fuente: api.argentinadatos.com (la MISMA API que ya usa el
// dashboard de /admin para el dólar blue: gratis, sin key, sin registro — requisito $0
// del proyecto). Respuesta: [{ fecha: "YYYY-MM-DD", tipo: "inamovible"|"trasladable"|
// "puente"|"no laborable", nombre }].
//
// Cache en memoria del proceso (24h): los feriados cambian una vez por año, no tiene
// sentido releer. Fallback seguro: si la API no responde, devuelve lista vacía y no
// reintenta por 24h — un feriado es informativo, nunca puede tumbar el panel ni la
// agenda.
const FERIADOS_CACHE = new Map(); // year -> { ts, data }
const FERIADOS_CACHE_MS = 24 * 60 * 60 * 1000;

export async function obtenerFeriadosAnio(year) {
  const cache = FERIADOS_CACHE.get(year);
  if (cache && Date.now() - cache.ts < FERIADOS_CACHE_MS) return cache.data;
  try {
    const res = await fetch(`https://api.argentinadatos.com/v1/feriados/${year}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const lista = Array.isArray(data) ? data : [];
    FERIADOS_CACHE.set(year, { ts: Date.now(), data: lista });
    return lista;
  } catch (err) {
    console.error('[feriados] no se pudieron obtener feriados:', err?.message || err);
    FERIADOS_CACHE.set(year, { ts: Date.now(), data: [] });
    return [];
  }
}

// Devuelve { fecha, tipo, nombre } | null si dateStr ("YYYY-MM-DD") es feriado.
export async function esFeriado(dateStr) {
  const year = Number(String(dateStr || '').slice(0, 4));
  if (!year) return null;
  const feriados = await obtenerFeriadosAnio(year);
  return feriados.find((f) => f.fecha === dateStr) || null;
}
