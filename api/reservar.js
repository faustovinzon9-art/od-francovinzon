import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, SLOT_MINUTES, TIME_ZONE,
  toArgDate, eventBounds, crearTurno, formatArgDay, formatArgTime,
  extraerTelefono, extraerMotivo, extraerEsNuevoPaciente, extraerConfirmado, escribirConfirmado,
  extraerCodigoCorto, asegurarCodigoCorto,
} from '../lib/googleCalendar.js';
import { avisarFallo } from '../lib/alertas.js';
import { conReintentos } from '../lib/retry.js';
import { obtenerHorariosConfig, logActividad } from '../lib/adminConfig.js';

// El ticket térmico imprime un QR también para sobreturnos (ver gestion/index.html),
// así que "obtener"/"cancelar" tienen que poder apuntar a SOBRETURNOS_CALENDAR_ID —
// nunca a un calendario arbitrario que mande el cliente: whitelist de los dos ids
// válidos, cualquier otra cosa cae al default de siempre (CALENDAR_ID).
function resolverCalendarId(calendarId) {
  return calendarId === SOBRETURNOS_CALENDAR_ID ? SOBRETURNOS_CALENDAR_ID : CALENDAR_ID;
}

export default async function handler(req, res) {
  // Link corto /t/CODIGO (rewrite en vercel.json, "/t/:codigo" -> "/api/reservar?codigo=:codigo")
  // — público, GET, sin key. Ver resolverCodigoCorto más abajo.
  if (req.method === 'GET' && req.query.codigo) {
    return resolverCodigoCorto(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { accion } = req.body;
  // Mover/cancelar/consultar el turno, sin key: solo alcanza con el eventId — mismo
  // modelo de seguridad para las tres (ver decisions.md, "Modificar turno desde la
  // confirmación"). El nuevo horario de "mover" siempre sale del calendario/duración
  // normal (CALENDAR_ID, 30 min) — si el eventId que se mueve es un sobreturno
  // (calendarId = SOBRETURNOS_CALENDAR_ID), esto convierte el sobreturno en turno
  // común en vez de solo reprogramarlo (ver moverPropio). "obtener"/"cancelar" ya
  // aceptaban un calendarId whitelisteado para poder mostrar/cancelar sobreturnos.
  if (accion === 'cancelar') return cancelarPropio(req, res);
  if (accion === 'mover') return moverPropio(req, res);
  if (accion === 'obtener') return obtenerPropio(req, res);
  if (accion === 'confirmar') return confirmarPropio(req, res);

  try {
    const { date, time, nombre, apellido, telefono, dni, motivo, esNuevo } = req.body;
    const calendar = getCalendarClient();
    const { slotMinutes } = await obtenerHorariosConfig();
    // Misma lógica que usa el chatbot para la reserva conversacional — ver lib/googleCalendar.js.
    const resultado = await crearTurno(calendar, { date, time, nombre, apellido, telefono, dni, motivo, esNuevo, slotMinutes });
    if (resultado.success) {
      await logActividad({ tipo: 'turno_creado', detalle: `${nombre} ${apellido} — ${date} ${time}`, actor: 'paciente (/turnos)' });
    }
    res.status(200).json(resultado);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'crear turno', error: err });
    res.status(500).json({ success: false, message: 'Hubo un error al confirmar el turno. Probá de nuevo.' });
  }
}

// Punto de entrada del QR del ticket térmico (ver gestion/index.html): dado un
// eventId, devuelve nombre/fecha/hora para que /turnos pueda mostrar "Tu turno" y
// habilitar Cambiar día y horario / Cancelar sin haber pasado por la reserva en esa
// misma carga de página. Mismo modelo de seguridad que mover/cancelar (conocer el
// id alcanza) — no expone teléfono ni nada más de la description.
async function obtenerPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a consultar.' });
    }
    const calendar = getCalendarClient();
    const { data: ev } = await conReintentos(() => calendar.events.get({ calendarId: resolverCalendarId(calendarId), eventId }));
    // Un turno recién cancelado no siempre tira error en events.get de entrada —
    // Google Calendar puede devolver el recurso igual con status: 'cancelled'
    // (tombstone) en vez de un 404 inmediato. Bug real encontrado probando el QR
    // de punta a punta: sin este chequeo, un turno ya cancelado seguía
    // mostrándose como válido (con botones de Cambiar/Cancelar de nuevo).
    if (ev.status === 'cancelled') {
      return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
    }
    const { start } = eventBounds(ev);
    // Asegura el código corto acá también (turnos viejos, creados antes de este
    // cambio, podrían no tenerlo todavía) — así /turnos puede armar el link corto
    // para "Guardar acceso a mi turno" sin importar por dónde se llegó a esta pantalla.
    const codigoCorto = await asegurarCodigoCorto(calendar, resolverCalendarId(calendarId), eventId, ev.description || '');
    res.status(200).json({
      success: true,
      nombre: ev.summary || '',
      date: formatArgDay(start),
      time: formatArgTime(start),
      confirmado: extraerConfirmado(ev.description || ''),
      codigoCorto,
    });
  } catch (err) {
    // events.get tira si el turno ya no existe (cancelado, o id inválido/de otro
    // calendario) — se trata como "no encontrado" sin filtrar el motivo exacto.
    console.error(err);
    res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
  }
}

// Resuelve el link corto /t/CODIGO -> redirige (302) al link largo real
// (/turno?eventId=...&calendarId=...&tipo=...). Público, sin key: el código de 6
// caracteres cumple el mismo rol que el eventId largo (conocerlo alcanza), ver
// decisions.md sobre el modelo de seguridad de mover/cancelar/obtener/confirmar.
// Busca por texto (`q`) en los dos calendarios, sin límite de fecha — mismo criterio
// que telefonoDesdeTurnos en api/gestion/pacientes.js — y confirma el match EXACTO
// contra la description antes de redirigir, porque `q` es búsqueda difusa (podría
// devolver falsos positivos si el código apareciera suelto en otro campo).
async function resolverCodigoCorto(req, res) {
  const codigo = (req.query.codigo || '').toString().trim().toUpperCase();
  if (!codigo) return paginaLinkInvalido(res);

  try {
    const calendar = getCalendarClient();
    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, q: codigo, maxResults: 50, singleEvents: true })),
      conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, q: codigo, maxResults: 50, singleEvents: true })),
    ]);

    const candidatos = [
      ...(principal.data.items || []).map((ev) => ({ ev, calendarId: CALENDAR_ID })),
      ...(sobreturnos.data.items || []).map((ev) => ({ ev, calendarId: SOBRETURNOS_CALENDAR_ID })),
    ];
    const match = candidatos.find(({ ev }) => ev.status !== 'cancelled' && extraerCodigoCorto(ev.description) === codigo);
    if (!match) return paginaLinkInvalido(res);

    const params = new URLSearchParams({ eventId: match.ev.id });
    if (match.calendarId === SOBRETURNOS_CALENDAR_ID) {
      params.set('calendarId', match.calendarId);
      params.set('tipo', 'sobreturno');
    }
    res.redirect(302, `/turno?${params.toString()}`);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'resolver código corto', error: err });
    paginaLinkInvalido(res);
  }
}

// Página simple (sin depender de ningún archivo estático) para un código corto
// inválido o vencido (turno cancelado, o alguien tipeó mal el link) — mismo número de
// WhatsApp del consultorio que usa el resto del sitio.
function paginaLinkInvalido(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(404).send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Link no válido | Franco Vinzón Odontólogo</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #FAF9F6; color: #2A2A2A; margin: 0; padding: 40px 20px; text-align: center; }
  .box { max-width: 380px; margin: 60px auto 0; background: #FFFFFF; border-radius: 22px; padding: 32px 24px; box-shadow: 0 2px 18px rgba(30,58,95,.08); }
  h1 { font-size: 19px; color: #1E3A5F; margin: 0 0 10px; font-family: Georgia, serif; }
  p { font-size: 14px; line-height: 1.5; color: #6B6656; margin: 0 0 20px; }
  a.wa { display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: #25D366; color: #fff; text-decoration: none; font-weight: 600; font-size: 13.5px; padding: 11px 20px; border-radius: 100px; }
</style></head>
<body>
  <div class="box">
    <h1>Este link ya no es válido</h1>
    <p>Puede que el turno haya sido cancelado o que el link haya vencido. Escribinos y te ayudamos.</p>
    <a class="wa" href="https://wa.me/5403442457764">Escribinos por WhatsApp</a>
  </div>
</body></html>`);
}

// Acción 'confirmar' — el paciente toca "Confirmo el turno" desde /turno (link que
// ahora también va en el mensaje de WhatsApp de recordatorio, ver gestion/index.html).
// Mismo modelo de seguridad que obtener/mover/cancelar: conocer el eventId alcanza, sin
// key. A propósito SIN ninguna restricción de fecha (a diferencia de una eventual
// restricción de "no tocar el mismo día" para mover/cancelar): confirmar asistencia el
// mismo día del turno sigue siendo útil, así que esta acción está disponible siempre.
async function confirmarPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a confirmar.' });
    }
    const calendar = getCalendarClient();
    const calId = resolverCalendarId(calendarId);
    const { data: ev } = await conReintentos(() => calendar.events.get({ calendarId: calId, eventId }));
    if (ev.status === 'cancelled') {
      return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
    }
    const nuevaDescripcion = escribirConfirmado(ev.description || '', true);
    await conReintentos(() => calendar.events.patch({ calendarId: calId, eventId, requestBody: { description: nuevaDescripcion } }));
    await logActividad({ tipo: 'turno_confirmado', detalle: eventId, actor: 'paciente (/turno)' });
    res.status(200).json({ success: true, message: '¡Turno confirmado! Gracias por avisarnos.' });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'confirmar turno (propio)', error: err });
    res.status(500).json({ success: false, message: 'No se pudo confirmar el turno. Probá de nuevo.' });
  }
}

async function cancelarPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a cancelar.' });
    }
    const calendar = getCalendarClient();
    await conReintentos(() => calendar.events.delete({ calendarId: resolverCalendarId(calendarId), eventId }));
    await logActividad({ tipo: 'turno_cancelado', detalle: eventId, actor: 'paciente (/turno)' });
    res.status(200).json({ success: true, message: 'Turno cancelado.' });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'cancelar turno (propio)', error: err });
    res.status(500).json({ success: false, message: 'No se pudo cancelar el turno. Probá de nuevo.' });
  }
}

async function moverPropio(req, res) {
  try {
    const { eventId, date, time, calendarId } = req.body;
    if (!eventId || !date || !time) {
      return res.status(200).json({ success: false, message: 'Faltan datos para reprogramar.' });
    }

    const calendar = getCalendarClient();
    const origenSobreturno = calendarId === SOBRETURNOS_CALENDAR_ID;
    const newStart = toArgDate(date, time);
    const newEnd = new Date(newStart.getTime() + SLOT_MINUTES * 60000);

    // El horario elegido siempre es del calendario principal (30 min) — tanto para
    // reprogramar un turno común como para convertir un sobreturno en uno — así que
    // el chequeo de solapamiento es siempre contra CALENDAR_ID.
    const { data: existing } = await conReintentos(() => calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: newStart.toISOString(),
      timeMax: newEnd.toISOString(),
      singleEvents: true,
    }));

    const overlapping = (existing.items || []).some((ev) => {
      if (ev.id === eventId) return false;
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return newStart < evEnd && newEnd > evStart;
    });

    if (overlapping) {
      return res.status(200).json({ success: false, message: 'Justo se ocupó ese horario. Elegí otro disponible.' });
    }

    if (origenSobreturno) {
      // Convertir sobreturno -> turno común: el paciente eligió un horario del
      // calendario normal (30 min) desde /turno, que no tiene selector de horarios
      // de sobreturno (15 min) — no alcanza con mover fecha/hora, hay que recrear
      // el evento en el otro calendario con la duración correcta. Se crea primero
      // el turno nuevo y recién si sale bien se borra el sobreturno viejo, para no
      // perder el turno si algo falla en el medio (ver decisions.md).
      const { data: original } = await conReintentos(() => calendar.events.get({ calendarId: SOBRETURNOS_CALENDAR_ID, eventId }));
      if (original.status === 'cancelled') {
        return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
      }

      const partes = (original.summary || '').trim().split(/\s+/);
      const nombre = partes.shift() || '';
      const apellido = partes.join(' ');

      const resultado = await crearTurno(calendar, {
        date,
        time,
        nombre,
        apellido,
        telefono: extraerTelefono(original.description || ''),
        motivo: extraerMotivo(original.description || ''),
        esNuevo: extraerEsNuevoPaciente(original.description || ''),
        origen: 'conversion-sobreturno',
      });
      if (!resultado.success) return res.status(200).json(resultado);

      await conReintentos(() => calendar.events.delete({ calendarId: SOBRETURNOS_CALENDAR_ID, eventId }));
      await logActividad({ tipo: 'turno_reprogramado', detalle: `${eventId} → ${date} ${time}`, actor: 'paciente (/turno)' });

      return res.status(200).json({
        success: true,
        message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`,
        eventId: resultado.eventId,
        calendarId: CALENDAR_ID,
        codigoCorto: resultado.codigoCorto,
      });
    }

    // Se asegura el código corto antes de reprogramar (un turno viejo podría no
    // tenerlo todavía) — para turnos que ya lo tienen esto es solo una lectura, no
    // agrega ninguna escritura de más. Ver asegurarCodigoCorto en lib/googleCalendar.js.
    const { data: original } = await conReintentos(() => calendar.events.get({ calendarId: CALENDAR_ID, eventId }));
    const codigoCorto = await asegurarCodigoCorto(calendar, CALENDAR_ID, eventId, original.description || '');

    await conReintentos(() => calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        start: { dateTime: newStart.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: newEnd.toISOString(), timeZone: TIME_ZONE },
      },
    }));

    await logActividad({ tipo: 'turno_reprogramado', detalle: `${eventId} → ${date} ${time}`, actor: 'paciente (/turno)' });

    res.status(200).json({
      success: true,
      message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`,
      eventId,
      calendarId: CALENDAR_ID,
      codigoCorto,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'mover turno (propio)', error: err });
    res.status(500).json({ success: false, message: 'No se pudo reprogramar el turno. Probá de nuevo.' });
  }
}
