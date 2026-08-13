import {
  getCalendarClient, TIME_ZONE, toArgDate, eventBounds, isValidGestionKey, escribirConfirmado,
  asegurarCodigoCorto, formatArgDay, formatArgTime,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { aTituloCase } from '../../lib/pacientesSheet.js';
import { logActividad } from '../../lib/adminConfig.js';

// Mover y cancelar un turno/sobreturno comparten ruta (distinguidos por "accion")
// para no pasarnos del límite de funciones serverless del plan gratuito de Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, accion } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();

    if (accion === 'cancelar') {
      // Se busca el evento ANTES de borrarlo únicamente para que el registro de
      // actividad diga algo legible ("Juan Pérez — 15/8 10:00hs") en vez del eventId
      // pelado — si esta lectura falla por lo que sea, no bloquea la cancelación real.
      let detalleLegible = eventId;
      try {
        const { data: original } = await calendar.events.get({ calendarId, eventId });
        const { start } = eventBounds(original);
        detalleLegible = `${original.summary || 'paciente'} — ${formatArgDay(start)} ${formatArgTime(start)}hs`;
      } catch { /* eventId pelado como último recurso, ver arriba */ }

      await calendar.events.delete({ calendarId, eventId });
      await logActividad({ tipo: 'turno_cancelado', detalle: detalleLegible, actor: 'gestión (Ayelen)' });
      return res.status(200).json({ success: true, message: 'Turno cancelado.' });
    }

    // Genera el link corto /t/CODIGO al vuelo para turnos viejos que todavía no lo
    // tienen (creados antes de este cambio) — la usa gestion/index.html justo antes de
    // mandar el WhatsApp o armar el QR del ticket, no hay ninguna migración masiva.
    // Idempotente: si el turno ya tiene código, no escribe nada, solo lo devuelve.
    if (accion === 'asegurar-codigo-corto') {
      const { data: original } = await calendar.events.get({ calendarId, eventId });
      const codigoCorto = await asegurarCodigoCorto(calendar, calendarId, eventId, original.description || '');
      return res.status(200).json({ success: true, codigoCorto });
    }

    // Toggle manual del indicador verde/rojo de la agenda (Ayelen marca "Confirmado" al
    // enterarse por teléfono/WhatsApp, o lo destilda si se equivocó) — mismo campo que
    // escribe el paciente al tocar "Confirmo el turno" en /turno (ver api/reservar.js).
    if (accion === 'confirmar') {
      const { confirmado } = req.body;
      const { data: original } = await calendar.events.get({ calendarId, eventId });
      const nuevaDescripcion = escribirConfirmado(original.description || '', !!confirmado);
      await calendar.events.patch({ calendarId, eventId, requestBody: { description: nuevaDescripcion } });
      const { start: fechaConfirmado } = eventBounds(original);
      await logActividad({
        tipo: confirmado ? 'turno_confirmado' : 'turno_desconfirmado',
        detalle: `${original.summary || 'paciente'} — ${formatArgDay(fechaConfirmado)} ${formatArgTime(fechaConfirmado)}hs`,
        actor: 'gestión (Ayelen)',
      });
      return res.status(200).json({
        success: true,
        message: confirmado ? 'Turno marcado como confirmado.' : 'Turno marcado como sin confirmar.',
        confirmado: !!confirmado,
      });
    }

    const { nuevaFecha, nuevaHora, motivo, nombre, apellido } = req.body;

    const { data: original } = await calendar.events.get({ calendarId, eventId });
    const { start: origStart, end: origEnd } = eventBounds(original);
    const durationMs = origEnd.getTime() - origStart.getTime();

    const newStart = toArgDate(nuevaFecha, nuevaHora);
    const newEnd = new Date(newStart.getTime() + durationMs);

    const { data: existing } = await calendar.events.list({
      calendarId,
      timeMin: newStart.toISOString(),
      timeMax: newEnd.toISOString(),
      singleEvents: true,
    });

    const overlapping = (existing.items || []).some((ev) => {
      if (ev.id === eventId) return false;
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return newStart < evEnd && newEnd > evStart;
    });

    if (overlapping) {
      return res.status(200).json({ success: false, message: 'Ese horario ya está ocupado.' });
    }

    const requestBody = {
      start: { dateTime: newStart.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: newEnd.toISOString(), timeZone: TIME_ZONE },
    };
    // Título del evento: solo "Nombre Apellido" (ver decisions.md) — permite
    // corregir un nombre mal tipeado desde el mismo flujo de mover/editar.
    if (nombre && nombre.trim()) {
      requestBody.summary = `${aTituloCase(nombre.trim())} ${aTituloCase((apellido || '').trim())}`.trim();
    }
    if (motivo && motivo.trim()) {
      const desc = original.description || '';
      requestBody.description = /Motivo:\s*[^\n]*/i.test(desc)
        ? desc.replace(/Motivo:\s*[^\n]*/i, `Motivo: ${motivo.trim()}`)
        : `${desc.replace(/\s+$/, '')}\nMotivo: ${motivo.trim()}`;
    }

    await calendar.events.patch({ calendarId, eventId, requestBody });
    await logActividad({
      tipo: 'turno_reprogramado',
      detalle: `${requestBody.summary || original.summary || 'paciente'} — pasó a ${nuevaFecha} ${nuevaHora}hs`,
      actor: 'gestión (Ayelen)',
    });

    res.status(200).json({ success: true, message: `Movido al ${nuevaFecha} a las ${nuevaHora} hs.` });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/evento.js', detalle: accion, error: err });
    res.status(500).json({ success: false, message: 'Error al procesar el turno.' });
  }
}

