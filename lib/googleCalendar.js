import { google } from 'googleapis';

export const CALENDAR_ID = 'odontologofrancovinzon@gmail.com';
export const SOBRETURNOS_CALENDAR_ID = 'v5cmrbcmh56qfdnvqvd7b7oa9s@group.calendar.google.com';
export const TIME_ZONE = 'America/Argentina/Buenos_Aires';
export const SLOT_MINUTES = 30;
export const SOBRETURNO_MINUTES = 15;
export const CLINIC_ADDRESS = 'Ameghino 410, E3260 Concepción del Uruguay, Entre Ríos, Argentina';
export const BLOCK_MARKER = 'BLOQUEO_AUTOMATICO_TURNOS';

export function isValidGestionKey(key) {
  return !!key && !!process.env.GESTION_KEY && key === process.env.GESTION_KEY;
}

// 0=Domingo ... 6=Sábado. Cada rango es [horaInicio, horaFin] en "HH:mm" 24hs.
export const WEEKLY_SCHEDULE = {
  0: [],
  1: [['08:00', '15:00']],
  2: [['08:00', '12:00'], ['15:00', '19:00']],
  3: [['08:00', '15:00']],
  4: [['08:00', '15:00']],
  5: [['08:00', '12:00']],
  6: [],
};

// Argentina no tiene horario de verano: es siempre UTC-3 fijo.
// Por eso alcanza con construir el string ISO con el offset "-03:00" explícito;
// esto da la hora correcta sin importar en qué zona horaria corra el servidor de Vercel.
export function toArgDate(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00-03:00`);
}

export function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Formatea una fecha (instante absoluto) como "HH:mm" en hora Argentina.
export function formatArgTime(date) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

// Formatea una fecha como "yyyy-MM-dd" en hora Argentina.
export function formatArgDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Devuelve {start, end} como Date reales para cualquier evento de Calendar API,
// tanto eventos con hora (dateTime) como eventos de todo el día (date, sin hora).
export function eventBounds(ev) {
  if (ev.start.dateTime) {
    return { start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime) };
  }
  return { start: toArgDate(ev.start.date, '00:00'), end: toArgDate(ev.end.date, '00:00') };
}

// Saca tags HTML (eventos viejos de Apps Script) y busca "Teléfono: ..." en cualquier
// parte del texto, sin asumir que es la primera línea.
export function extraerTelefono(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/Tel[eé]fono:\s*([^\n]+)/i);
  const tel = match ? match[1].trim() : '';
  return tel && tel !== '-' ? tel : '';
}

export function extraerEsNuevoPaciente(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/Paciente nuevo:\s*(S[ií]|No)/i);
  return !!match && /^s/i.test(match[1]);
}

// Normaliza para comparar nombres sin importar mayúsculas ni acentos.
export function normalizarTexto(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const PREFIJOS_PAIS = ['54', '598', '595', '56', '55', '591', '51', '57', '52', '34', '1'];

// Limpia y normaliza un teléfono al formato que espera wa.me. Devuelve null si,
// después de normalizar, no tiene pinta de número real.
export function normalizarTelefonoWhatsApp(raw) {
  let digitos = (raw || '').replace(/\D/g, '');
  if (!digitos) return null;

  const yaConCodigo = PREFIJOS_PAIS.some((p) => digitos.startsWith(p));

  if (!yaConCodigo) {
    if (digitos.startsWith('0')) digitos = digitos.slice(1);
    // Saca el "15" (prefijo de celular argentino) si aparece justo después
    // del código de área (se prueban los largos de área típicos).
    for (const largoArea of [4, 3, 2]) {
      if (digitos.slice(largoArea, largoArea + 2) === '15') {
        digitos = digitos.slice(0, largoArea) + digitos.slice(largoArea + 2);
        break;
      }
    }
    digitos = '549' + digitos;
  }

  if (digitos.length < 10 || digitos.length > 15) return null;
  return digitos;
}

export function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}
