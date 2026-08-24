import { google } from 'googleapis';
// NUNCA envolver el cliente entero en un Proxy para esto — ver el incidente documentado
// más abajo (getCalendarClient) y en decisions.md. conReintentos() se usa puntual, call
// site por call site: `await conReintentos(() => calendar.events.list({...}))`.
import { conReintentos } from './retry.js';
import { aTituloCase } from './pacientesSheet.js';
import { upsertPacienteConsolidado } from './pacientesConsolidados.js';

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

// Busca "DNI: ..." en la description — campo opcional agregado al formulario público
// de /turnos (ver turnos/index.html). Turnos viejos y los cargados desde /gestion no
// tienen esta línea, así que devuelve '' en ese caso (usado por el cruce de fichas
// en pacientes/index.html como primer nivel de confianza cuando sí está).
export function extraerDni(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/DNI:\s*([^\n]+)/i);
  const dni = match ? match[1].trim() : '';
  return dni && dni !== '-' ? dni : '';
}

// Email opcional (ver el pedido: solo se pide en /turnos si no hay uno ya guardado
// para ese DNI+teléfono) — mismo patrón que extraerDni.
export function extraerEmail(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/Email:\s*([^\n]+)/i);
  const email = match ? match[1].trim() : '';
  return email && email !== '-' ? email : '';
}

// Busca "Código corto: ..." en la description — el código de 6 caracteres que resuelve
// el link corto /t/CODIGO (ver api/reservar.js). Turnos creados antes de este cambio no
// lo tienen todavía: se generan "al vuelo" recién la primera vez que hace falta (ver
// asegurarCodigoCorto), no hay ninguna migración masiva.
export function extraerCodigoCorto(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  const match = sinTags.match(/C[oó]digo corto:\s*([^\n]+)/i);
  const codigo = match ? match[1].trim() : '';
  return codigo && codigo !== '-' ? codigo : '';
}

// Alfabeto sin caracteres ambiguos (0/O, 1/I/L) — pensado para que sea legible si
// alguna vez hay que leerlo/dictarlo en vez de tocarlo. 6 caracteres de un alfabeto de
// 32 dan ~1.073 millones de combinaciones — de sobra para el volumen de este
// consultorio, no hace falta chequear colisión contra los códigos ya usados.
const ALFABETO_CODIGO_CORTO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generarCodigoCorto() {
  let codigo = '';
  for (let i = 0; i < 6; i++) {
    codigo += ALFABETO_CODIGO_CORTO[Math.floor(Math.random() * ALFABETO_CODIGO_CORTO.length)];
  }
  return codigo;
}

// Idempotente: si el evento ya tiene un código corto en la description, lo devuelve tal
// cual (sin escribir nada). Si no, genera uno nuevo, lo agrega a la description
// (mismo patrón "Etiqueta: valor" que el resto de los campos) y lo guarda antes de
// devolverlo. Se usa tanto al reenviar el WhatsApp/reimprimir el ticket de un turno
// viejo (api/gestion/evento.js) como al aterrizar en /turno vía el link largo
// (api/reservar.js) — un solo lugar para no duplicar esta lógica.
export async function asegurarCodigoCorto(calendar, calendarId, eventId, descripcionActual) {
  const existente = extraerCodigoCorto(descripcionActual);
  if (existente) return existente;
  const codigo = generarCodigoCorto();
  const limpia = (descripcionActual || '').replace(/\s+$/, '');
  const nuevaDescripcion = limpia ? `${limpia}\nCódigo corto: ${codigo}` : `Código corto: ${codigo}`;
  await conReintentos(() => calendar.events.patch({ calendarId, eventId, requestBody: { description: nuevaDescripcion } }));
  return codigo;
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

// Busca "Confirmado: Sí" — el paciente tocó "Confirmo el turno" en /turno, o Ayelen lo
// marcó a mano desde /gestion (ver api/reservar.js accion 'confirmar' y
// api/gestion/evento.js accion 'confirmar'). Eventos sin esta línea (todo lo creado
// antes de este cambio, o un turno que nadie confirmó todavía) son "Sin confirmar" por
// default — mismo criterio de default seguro que el resto de las líneas de la
// description (ver decisions.md).
export function extraerConfirmado(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  return /Confirmado:\s*S[ií]/i.test(sinTags);
}

// Agrega o reemplaza la línea "Confirmado: Sí/No" de una description — usado tanto por
// la acción pública 'confirmar' de api/reservar.js (el paciente, desde /turno) como por
// el toggle manual de api/gestion/evento.js (Ayelen, desde /gestion). Mismo patrón de
// agregar-o-reemplazar ya usado para "Teléfono verificado" en agregar-telefono.js.
export function escribirConfirmado(description, confirmado) {
  const actual = description || '';
  const valor = confirmado ? 'Sí' : 'No';
  if (/Confirmado:\s*[^\n]*/i.test(actual)) {
    return actual.replace(/Confirmado:\s*[^\n]*/i, `Confirmado: ${valor}`);
  }
  const limpia = actual.replace(/\s+$/, '');
  return limpia ? `${limpia}\nConfirmado: ${valor}` : `Confirmado: ${valor}`;
}

// "Confirmación solicitada: Sí" (ver el pedido, 2026-08-14) — se agrega cuando Ayelen
// manda el WhatsApp de "Pedido de confirmación" desde /gestion, sin importar cuánto
// falte para el turno. El botón "Confirmo el turno" en /turno normalmente solo aparece
// cerca de la fecha (ver VENTANA_CONFIRMAR_MS en turno/index.html) — esta marca es la
// excepción explícita: si Ayelen ya pidió confirmación, tiene que poder confirmarse
// aunque falten varios días. Distinta línea de "Confirmado" (esa es la respuesta del
// paciente; esta es que se le pidió).
export function extraerConfirmacionSolicitada(description) {
  const sinTags = (description || '').replace(/<[^>]*>/g, ' ');
  return /Confirmaci[oó]n solicitada:\s*S[ií]/i.test(sinTags);
}

export function escribirConfirmacionSolicitada(description) {
  const actual = description || '';
  if (/Confirmaci[oó]n solicitada:\s*[^\n]*/i.test(actual)) {
    return actual.replace(/Confirmaci[oó]n solicitada:\s*[^\n]*/i, 'Confirmación solicitada: Sí');
  }
  const limpia = actual.replace(/\s+$/, '');
  return limpia ? `${limpia}\nConfirmación solicitada: Sí` : 'Confirmación solicitada: Sí';
}

// Normaliza para comparar nombres sin importar mayúsculas ni acentos.
export function normalizarTexto(str) {
  // Colapsa espacios de mas y recorta puntas (bug real, 2026-08-13: un espacio colgado
  // en el campo Nombre o Apellido de /gestion, al combinarlos, dejaba un doble espacio
  // que rompia el .includes() del matching contra el titulo del turno en Calendar -
  // el autocompletado de telefono/DNI dejaba de encontrar coincidencias reales).
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
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
// libre según WEEKLY_SCHEDULE y lo ya ocupado en CALENDAR_ID. `schedule`/`slotMinutes`
// son opcionales (default = los de siempre) — los pasa /admin cuando Fausto configuró
// un horario propio desde el panel (lib/adminConfig.js), sin cambiar nada para quien
// no los pasa.
export async function getDisponibilidadMes(calendar, year, month, schedule = WEEKLY_SCHEDULE, slotMinutes = SLOT_MINUTES) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = toArgDate(`${year}-${pad2(month)}-01`, '00:00');
  const lastDayStr = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
  const monthEnd = new Date(toArgDate(lastDayStr, '00:00').getTime() + 24 * 60 * 60000);

  const { data } = await conReintentos(() => calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: monthStart.toISOString(),
    timeMax: monthEnd.toISOString(),
    singleEvents: true,
    maxResults: 2500,
  }));

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
    const ranges = schedule[dayOfWeek] || [];

    if (ranges.length === 0) { result[d] = false; continue; }

    const dayEvents = eventsByDay[dateStr] || [];
    let hasFree = false;

    for (const range of ranges) {
      if (hasFree) break;
      let current = toArgDate(dateStr, range[0]);
      const end = toArgDate(dateStr, range[1]);
      while (current < end && !hasFree) {
        const slotEnd = new Date(current.getTime() + slotMinutes * 60000);
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

// Devuelve array de horarios libres ("HH:mm") para un día puntual. `schedule`/
// `slotMinutes` opcionales, mismo criterio que getDisponibilidadMes.
export async function getHorariosLibresDia(calendar, dateStr, schedule = WEEKLY_SCHEDULE, slotMinutes = SLOT_MINUTES) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayOfWeek = new Date(y, m - 1, d).getDay();
  const ranges = schedule[dayOfWeek] || [];
  if (ranges.length === 0) return [];

  const allSlots = [];
  ranges.forEach((range) => {
    let current = toArgDate(dateStr, range[0]);
    const end = toArgDate(dateStr, range[1]);
    while (current < end) {
      const slotEnd = new Date(current.getTime() + slotMinutes * 60000);
      if (slotEnd <= end) allSlots.push({ start: new Date(current), end: slotEnd });
      current = slotEnd;
    }
  });

  const dayStart = toArgDate(dateStr, '00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

  const { data } = await conReintentos(() => calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
  }));

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
export async function crearTurno(calendar, { date, time, nombre, apellido, telefono, dni, email, motivo, esNuevo, origen, slotMinutes = SLOT_MINUTES }) {
  if (!telefono || !telefono.trim()) {
    return { success: false, message: 'El teléfono es obligatorio.' };
  }
  const telNormalizado = telefonoParaWhatsApp(telefono);
  if (!telNormalizado) {
    return { success: false, message: 'Ese teléfono no parece válido. Revisalo e intentá de nuevo.' };
  }

  const start = toArgDate(date, time);
  const end = new Date(start.getTime() + slotMinutes * 60000);

  // Mismo criterio de Title Case que ya se usa en las fichas de /pacientes — sin
  // importar cómo lo tipee el paciente, siempre queda "Nombre Apellido".
  const title = `${aTituloCase(nombre)} ${aTituloCase(apellido) || ''}`.trim();

  const { data: existing } = await conReintentos(() => calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
  }));

  // Idempotencia ante reintentos: si ya existe un evento con el MISMO paciente
  // superpuesto en este horario, no es un conflicto de verdad — lo más probable es que
  // un intento anterior sí haya creado el turno pero la respuesta se haya perdido en el
  // camino (timeout, corte de red) antes de llegar al cliente, que reintentó. Se trata
  // como éxito (mismo eventId) en vez de mostrar "se ocupó el horario" o duplicar el
  // turno. Un evento de OTRO paciente en el mismo rango sigue siendo un conflicto real.
  const propio = (existing.items || []).find((ev) => {
    const { start: evStart, end: evEnd } = eventBounds(ev);
    return start < evEnd && end > evStart && (ev.summary || '').trim() === title;
  });
  if (propio) {
    return {
      success: true,
      message: `Turno confirmado para el ${date} a las ${time} hs (hora Argentina).`,
      eventId: propio.id,
      codigoCorto: extraerCodigoCorto(propio.description),
    };
  }

  const stillFree = !(existing.items || []).some((ev) => {
    const { start: evStart, end: evEnd } = eventBounds(ev);
    return start < evEnd && end > evStart;
  });

  if (!stillFree) {
    return { success: false, message: 'Justo se ocupó ese horario. Por favor elegí otro disponible.' };
  }
  const codigoCorto = generarCodigoCorto();
  const description =
    `Teléfono: ${telNormalizado}\n` +
    'Teléfono verificado: Sí\n' +
    `DNI: ${dni || '-'}\n` +
    `Email: ${email || '-'}\n` +
    `Motivo: ${motivo || '-'}\n` +
    `Paciente nuevo: ${esNuevo ? 'Sí' : 'No'}\n` +
    `Código corto: ${codigoCorto}\n` +
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

  const { data: created } = await conReintentos(() => calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody }));

  // Best-effort, ver lib/pacientesConsolidados.js — la mayoría de los turnos entran por
  // acá (reserva online, ver "% reservado online" del dashboard), así que sin este
  // upsert la planilla consolidada solo vería lo cargado a mano desde /gestion.
  await upsertPacienteConsolidado({ telefono: telNormalizado, nombre: aTituloCase(nombre), apellido: aTituloCase(apellido) || '', dni, origen: 'turno' });

  return {
    success: true,
    message: `Turno confirmado para el ${date} a las ${time} hs (hora Argentina).`,
    eventId: created.id,
    codigoCorto,
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

// El cliente de Calendar se devuelve SIN envolver — ver el incidente 2026-08-12 en
// decisions.md: envolver el cliente entero en un Proxy tiró producción entera abajo
// (campos privados nativos de googleapis/google-auth-library rotos por el `this` del
// Proxy). Los reintentos se aplican puntual, call site por call site, con
// `conReintentos()` (lib/retry.js) alrededor de cada llamada individual — ver
// getDisponibilidadMes/getHorariosLibresDia/crearTurno más arriba para el patrón.
//
// Nota (2026-08-24): getSheetsClient()/getDriveClient() de cuenta de servicio se
// sacaron — no tenían ningún call site (el módulo de Pacientes usa los clientes OAuth
// de lib/googleOAuthPacientes.js, que sí tienen cuota en el Drive personal del
// odontólogo; la cuenta de servicio no la tiene). El JWT sigue con los 3 scopes porque
// getAuth() es compartido y el scope extra no molesta.
export function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}
