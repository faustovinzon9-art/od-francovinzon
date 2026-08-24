import {
  getCalendarClient, CALENDAR_ID, BLOCK_MARKER, FERIADO_ATENDIDO_MARKER, TIME_ZONE, pad2, toArgDate, isValidGestionKey,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// Bloquear/desbloquear un día completo y bloquear un horario puntual comparten ruta
// (distinguidos por `modo`) para no pasarnos del límite de funciones serverless del
// plan gratuito de Vercel (fusiona lo que antes eran bloqueo-dia.js + bloquear-horario.js).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date, motivo, accion, horaInicio, horaFin, modo } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const calendar = getCalendarClient();

    if (modo === 'horario') return await bloquearHorario(calendar, req, res);

    if (accion === 'desbloquear') {
      const dayStart = toArgDate(date, '00:00');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

      const { data } = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      });

      const bloqueos = (data.items || []).filter(
        (ev) => !ev.start.dateTime && (ev.description || '').includes(BLOCK_MARKER)
      );

      if (bloqueos.length === 0) {
        return res.status(200).json({ success: false, message: 'Ese día no está bloqueado.' });
      }

      await Promise.all(
        bloqueos.map((ev) => calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id }))
      );

      return res.status(200).json({ success: true, message: `Día ${date} desbloqueado.` });
    }

    // Marcador de "feriado que se atiende" (feature 2026-08-24 — ver lib/feriados.js):
    // la tarea "¿Se atiende este día?" escribe esto cuando la secretaria dice que SÍ se
    // atiende, para no volver a preguntar. Mismo patrón de evento marcador que el
    // bloqueo (BLOCK_MARKER), sin base de datos propia. Idempotente: si ya existe el
    // marcador, no duplica.
    if (accion === 'marcar-feriado-atendido') {
      const dayStart = toArgDate(date, '00:00');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);
      const { data } = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      });
      const yaMarcado = (data.items || []).some(
        (ev) => !ev.start.dateTime && (ev.description || '').includes(FERIADO_ATENDIDO_MARKER)
      );
      if (yaMarcado) {
        return res.status(200).json({ success: true, message: `Feriado del ${date} marcado como atendido.` });
      }
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: 'Feriado atendido',
          description: FERIADO_ATENDIDO_MARKER,
          start: { date },
          end: { date: nextDayStr(date) },
        },
      });
      return res.status(200).json({ success: true, message: `Feriado del ${date} marcado como atendido.` });
    }

    // Quitar el marcador (la secretaria se equivocó, o cambió de idea).
    if (accion === 'desmarcar-feriado-atendido') {
      const dayStart = toArgDate(date, '00:00');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);
      const { data } = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      });
      const marcadores = (data.items || []).filter(
        (ev) => !ev.start.dateTime && (ev.description || '').includes(FERIADO_ATENDIDO_MARKER)
      );
      if (marcadores.length === 0) {
        return res.status(200).json({ success: false, message: 'Ese feriado no está marcado como atendido.' });
      }
      await Promise.all(
        marcadores.map((ev) => calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id }))
      );
      return res.status(200).json({ success: true, message: `Feriado del ${date} desmarcado.` });
    }

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
        description: BLOCK_MARKER,
        start: { date },
        end: { date: nextDayStr(date) },
      },
    });

    res.status(200).json({ success: true, message: `Día ${date} bloqueado.` });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/bloqueos.js', detalle: modo === 'horario' ? 'horario' : accion, error: err });
    res.status(500).json({ success: false, message: 'Error al procesar el bloqueo.' });
  }
}

async function bloquearHorario(calendar, req, res) {
  const { date, horaInicio, horaFin, motivo } = req.body;
  const start = toArgDate(date, horaInicio);
  const end = toArgDate(date, horaFin);

  if (!(end > start)) {
    return res.status(200).json({
      success: false,
      message: 'La hora de fin tiene que ser posterior a la de inicio.',
    });
  }

  await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
      description: BLOCK_MARKER,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    },
  });

  res.status(200).json({
    success: true,
    message: `Bloqueado de ${horaInicio} a ${horaFin} el ${date}.`,
  });
}
