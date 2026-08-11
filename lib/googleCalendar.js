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

// Busca "Motivo: ..." en cualquier parte del texto — mismo criterio que
// extraerTelefono (etiqueta en cualquier posición, no una línea fija). Usado al
// convertir un sobreturno en turno común (ver api/reservar.js, moverPropio) para
// no perder el motivo original al recrear el evento en el otro calendario.
export function extraerMotivo(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/Motivo:\s*([^\n]+)/i);
  const motivo = match ? match[1].trim() : '';
  return motivo && motivo !== '-' ? motivo : '';
}

export function extraerEsNuevoPaciente(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/Paciente nuevo:\s*(S[ií]|No)/i);
  return !!match && /^s/i.test(match[1]);
}

// Busca "Teléfono verificado: Sí", la marca que dejan reservar.js/crear-turno.js/
// agregar-telefono.js cuando el número vino del selector de país (intl-tel-input),
// ya validado y en formato E.164 real — no adivinado. Los eventos que no tienen esta
// línea (todo lo cargado antes de este cambio, incluido el rescate de teléfonos
// sueltos) se tratan como "pendiente de revisión manual" en /gestion.
export function extraerTelefonoVerificado(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  return /Tel[eé]fono verificado:\s*S[ií]/i.test(sinTags);
}

// Normaliza para comparar nombres sin importar mayúsculas ni acentos.
export function normalizarTexto(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Toma el número que devuelve intl-tel-input ya validado en formato E.164
// ("+543442403984", "+59899123456", etc.) y lo deja listo para wa.me: solo dígitos,
// sin "+". Para Argentina hace falta un paso extra — ver nota abajo.
//
// Comprobado empíricamente (2026-08-06, ver decisions.md): intl-tel-input/libphonenumber
// arma el E.164 de un celular argentino SIN el "9" (ej. "+543442403984"), porque el "9"
// no es parte del estándar E.164 sino una convención propia de Argentina para el
// enrutamiento de llamadas/mensajes a celulares — y es justo lo que WhatsApp necesita
// en el número de wa.me. Por eso se agrega acá a mano. El chequeo de "el dígito
// siguiente a 54 ya es un 9" hace que esto sea inofensivo (no duplica el 9) aun si
// el número prellenado por autocompletado ya lo traía (setNumber('+549...') lo
// conserva tal cual en el front).
export function telefonoParaWhatsApp(e164) {
  let digitos = (e164 || '').replace(/\D/g, '');
  if (!digitos) return null;

  if (digitos.startsWith('54') && digitos[2] !== '9') {
    digitos = '549' + digitos.slice(2);
  }

  if (digitos.length < 8 || digitos.length > 15) return null;
  return digitos;
}

// --- Legado: teléfonos cargados antes del selector de país (adivinaba Argentina) ---
// Se mantiene SOLO para mostrar un WhatsApp "mejor esfuerzo" en turnos viejos que no
// tienen "Teléfono verificado: Sí" (ver extraerTelefonoVerificado). No se usa más para
// guardar teléfonos nuevos — eso ahora es telefonoParaWhatsApp(), a partir del E.164
// real que entrega intl-tel-input.
//
// Limpia y normaliza un teléfono al formato que espera wa.me. Devuelve null si,
// después de normalizar, no tiene pinta de número real.
export function normalizarTelefonoWhatsApp(raw) {
  let digitos = (raw || '').replace(/\D/g, '');
  if (!digitos) return null;

  // Ojo: un número argentino local de 10 dígitos puede arrancar con "34"
  // (área 342, 3442, etc.), que coincide con el código de país de España.
  // Por eso el chequeo de "ya tiene código" exige además un largo total
  // que un número local de acá nunca tiene.
  const yaConCodigo =
    (digitos.startsWith('54') && digitos.length >= 12 && digitos.length <= 13) ||
    (digitos.startsWith('598') && digitos.length >= 11 && digitos.length <= 12);

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

// ---------- Disponibilidad y creación de turnos ----------
// Compartido por api/disponibilidad.js (paciente, público) y api/chat.js (chatbot
// público, function-calling de Gemini) — misma lógica en los dos caminos, para no
// tener dos formas distintas de calcular "qué horarios quedan libres" o de crear el
// evento. api/reservar.js usa crearTurno() con el mismo criterio.

// Devuelve { "1": bool, "2": bool, ... } por día del mes: true si queda algún slot
// libre según WEEKLY_SCHEDULE y lo ya ocupado en CALENDAR_ID.
export async function getDisponibilidadMes(calendar, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = toArgDate(`${year}-${pad2(month)}-01`, '00:00');
  const lastDayStr = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
  const monthEnd = new Date(toArgDate(lastDayStr, '00:00').getTime() + 24 * 60 * 60000);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: monthStart.toISOString(),
    timeMax: monthEnd.toISOString(),
    singleEvents: true,
    maxResults: 2500,
  });

  const eventsByDay = {};
  (data.items || []).forEach((ev) => {
    const { start, end } = eventBounds(ev);
    const k1 = formatArgDay(start);
    (eventsByDay[k1] ||= []).push({ start, end });
    const k2 = formatArgDay(end);
    if (k2 !== k1) (eventsByDay[k2] ||= []).push({ start, end });
  });

  const now = new Date();
  const result = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    const ranges = WEEKLY_SCHEDULE[dayOfWeek] || [];

    if (ranges.length === 0) { result[d] = false; continue; }

    const dayEvents = eventsByDay[dateStr] || [];
    let hasFree = false;

    for (const range of ranges) {
      if (hasFree) break;
      let current = toArgDate(dateStr, range[0]);
      const end = toArgDate(dateStr, range[1]);
      while (current < end && !hasFree) {
        const slotEnd = new Date(current.getTime() + SLOT_MINUTES * 60000);
        if (slotEnd <= end && current > now) {
          const overlaps = dayEvents.some((ev) => current < ev.end && slotEnd > ev.start);
          if (!overlaps) hasFree = true;
        }
        current = slotEnd;
      }
    }
    result[d] = hasFree;
  }
  return result;
}

// Devuelve array de horarios libres ("HH:mm") para un día puntual.
export async function getHorariosLibresDia(calendar, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayOfWeek = new Date(y, m - 1, d).getDay();
  const ranges = WEEKLY_SCHEDULE[dayOfWeek] || [];
  if (ranges.length === 0) return [];

  const allSlots = [];
  ranges.forEach((range) => {
    let current = toArgDate(dateStr, range[0]);
    const end = toArgDate(dateStr, range[1]);
    while (current < end) {
      const slotEnd = new Date(current.getTime() + SLOT_MINUTES * 60000);
      if (slotEnd <= end) allSlots.push({ start: new Date(current), end: slotEnd });
      current = slotEnd;
    }
  });

  const dayStart = toArgDate(dateStr, '00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
  });

  const events = (data.items || []).map(eventBounds);
  const now = new Date();

  const free = allSlots.filter(
    (slot) => slot.start > now && !events.some((ev) => slot.start < ev.end && slot.end > ev.start)
  );

  return free.map((slot) => formatArgTime(slot.start));
}

// Crea un turno de paciente en CALENDAR_ID, re-chequeando que el slot siga libre justo
// antes de crear (mismo criterio anti-carrera que ya usaba reservar.js). "telefono"
// debe venir en E.164 (selector de país en el formulario clásico, o ya validado por
// el chatbot antes de llamar a esto). "origen" solo cambia la última línea de la
// descripción, para poder distinguir turnos creados por chat de los del formulario.
export async function crearTurno(calendar, { date, time, nombre, apellido, telefono, motivo, esNuevo, origen }) {
  if (!telefono || !telefono.trim()) {
    return { success: false, message: 'El teléfono es obligatorio.' };
  }
  const telNormalizado = telefonoParaWhatsApp(telefono);
  if (!telNormalizado) {
    return { success: false, message: 'Ese teléfono no parece válido. Revisalo e intentá de nuevo.' };
  }

  const start = toArgDate(date, time);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60000);

  const { data: existing } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
  });

  const stillFree = !(existing.items || []).some((ev) => {
    const { start: evStart, end: evEnd } = eventBounds(ev);
    return start < evEnd && end > evStart;
  });

  if (!stillFree) {
    return { success: false, message: 'Justo se ocupó ese horario. Por favor elegí otro disponible.' };
  }

  const title = `${nombre} ${apellido || ''}`.trim();
  const description =
    `Teléfono: ${telNormalizado}\n` +
    'Teléfono verificado: Sí\n' +
    `Motivo: ${motivo || '-'}\n` +
    `Paciente nuevo: ${esNuevo ? 'Sí' : 'No'}\n` +
    (origen === 'chat'
      ? 'Reservado desde el asistente por chat (hora Argentina fija, sin depender del dispositivo del paciente).'
      : origen === 'conversion-sobreturno'
        ? 'Convertido de sobreturno a turno común (el paciente eligió un horario común desde la página del QR).'
        : 'Reservado desde el formulario propio (hora Argentina fija, sin depender del dispositivo del paciente).');

  const eventBody = {
    summary: title,
    location: CLINIC_ADDRESS,
    description,
    start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
  };

  const { data: created } = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody });

  return {
    success: true,
    message: `Turno confirmado para el ${date} a las ${time} hs (hora Argentina).`,
    eventId: created.id,
  };
}

// Misma cuenta de servicio para todo (Calendar, Sheets, Drive) — un solo JWT con
// los tres scopes, en vez de credenciales separadas por producto.
function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

export function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

export function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

export function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuth() });
}
