// Reintentos automáticos ante fallas transitorias de la API de Google (Calendar,
// Sheets, Drive) — para que un timeout o un 5xx pasajero no le muestre un error al
// paciente/secretaria si el segundo o tercer intento hubiera andado bien. Nunca
// reintenta errores "de verdad" (401, 403, 400, 404, etc.) — esos se propagan de
// inmediato, tal como antes.
//
// envolverConReintentos() es la pieza que se usa en la práctica: toma un cliente de
// googleapis (calendar/sheets/drive) y devuelve un Proxy que hace que CUALQUIER método
// (a cualquier profundidad: calendar.events.insert, sheets.spreadsheets.values.get,
// drive.files.copy, etc.) pase automáticamente por conReintentos() — así no hace falta
// tocar cada llamada individual en cada endpoint, alcanza con envolver el cliente una
// sola vez en el punto donde se crea (getCalendarClient/getSheetsClient/getDriveClient
// en este archivo, getPacientesSheetsClient/getPacientesDriveClient en
// lib/googleOAuthPacientes.js).

const CODIGOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);

function esErrorTransitorio(err) {
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);
  if (CODIGOS_REINTENTABLES.has(status)) return true;

  const codigoRed = err?.code;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(codigoRed)) return true;

  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up')) return true;

  return false;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fn: función sin argumentos que devuelve una Promise (ej. () => calendar.events.insert({...})).
export async function conReintentos(fn, { intentos = 3, esperaBaseMs = 350 } = {}) {
  let ultimoError;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;
      const esUltimoIntento = intento === intentos;
      if (esUltimoIntento || !esErrorTransitorio(err)) throw err;
      console.warn(`[retry] intento ${intento}/${intentos} falló (transitorio), reintentando…`, err?.message || err);
      await esperar(esperaBaseMs * intento); // backoff simple: 350ms, 700ms
    }
  }
  throw ultimoError; // inalcanzable en la práctica, solo para que TS/lectores no se confundan
}

export function envolverConReintentos(objetoApi, opts) {
  if (typeof objetoApi !== 'object' || objetoApi === null) return objetoApi;
  return new Proxy(objetoApi, {
    get(target, prop, receiver) {
      const valor = Reflect.get(target, prop, receiver);
      if (typeof valor === 'function') {
        return (...args) => conReintentos(() => valor.apply(target, args), opts);
      }
      if (typeof valor === 'object' && valor !== null) {
        return envolverConReintentos(valor, opts);
      }
      return valor;
    },
  });
}
