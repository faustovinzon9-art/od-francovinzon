import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, CLINIC_ADDRESS, TIME_ZONE,
  toArgDate, eventBounds, isValidGestionKey, telefonoParaWhatsApp,
  generarCodigoCorto, extraerCodigoCorto,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { conReintentos } from '../../lib/retry.js';
import { aTituloCase } from '../../lib/pacientesSheet.js';
import { obtenerHorariosConfig, logActividad } from '../../lib/adminConfig.js';
import { upsertPacienteConsolidado } from '../../lib/pacientesConsolidados.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date, time, nombre, apellido, telefono, dni, motivo, sobreturno, esNuevo } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  if (!telefono || !telefono.trim()) {
    return res.status(200).json({ success: false, message: 'El teléfono es obligatorio.' });
  }
  const telNormalizado = telefonoParaWhatsApp(telefono);
  if (!telNormalizado) {
    return res.status(200).json({ success: false, message: 'Ese teléfono no parece válido. Revisalo e intentá de nuevo.' });
  }

  try {
    const { slotMinutes, sobreturnoMinutes } = await obtenerHorariosConfig();
    const calendarId = sobreturno ? SOBRETURNOS_CALENDAR_ID : CALENDAR_ID;
    const duration = sobreturno ? sobreturnoMinutes : slotMinutes;

    const start = toArgDate(date, time);
    const end = new Date(start.getTime() + duration * 60000);

    const calendar = getCalendarClient();
    const title = `${aTituloCase(nombre)} ${aTituloCase(apellido) || ''}`.trim();

    const { data: existing } = await conReintentos(() => calendar.events.list({
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
    }));

    // Idempotencia ante reintentos — mismo criterio que crearTurno() en
    // lib/googleCalendar.js: si ya existe un evento del mismo paciente superpuesto acá,
    // no duplicar ni mostrar "ocupado", devolver éxito con ese evento ya existente.
    const propio = (existing.items || []).find((ev) => {
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return start < evEnd && end > evStart && (ev.summary || '').trim() === title;
    });
    if (propio) {
      return res.status(200).json({
        success: true,
        message: `${sobreturno ? 'Sobreturno' : 'Turno'} cargado para el ${date} a las ${time} hs.`,
        eventId: propio.id,
        calendarId,
        codigoCorto: extraerCodigoCorto(propio.description),
      });
    }

    const stillFree = !(existing.items || []).some((ev) => {
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return start < evEnd && end > evStart;
    });

    if (!stillFree) {
      return res.status(200).json({
        success: false,
        message: 'Ese horario ya está ocupado en ese calendario.',
      });
    }

    const codigoCorto = generarCodigoCorto();
    const description =
      `Teléfono: ${telNormalizado}\n` +
      'Teléfono verificado: Sí\n' +
      `DNI: ${dni || '-'}\n` +
      `Motivo: ${motivo}\n` +
      `Paciente nuevo: ${esNuevo ? 'Sí' : 'No'}\n` +
      `Código corto: ${codigoCorto}\n` +
      'Cargado manualmente desde el panel de gestión.';

    const { data: created } = await conReintentos(() => calendar.events.insert({
      calendarId,
      requestBody: {
        summary: title,
        location: CLINIC_ADDRESS,
        description,
        start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      },
    }));

    await logActividad({
      tipo: sobreturno ? 'sobreturno_creado' : 'turno_creado',
      detalle: `${title} — ${date} ${time}`,
      actor: 'gestión (Ayelen)',
    });

    // Best-effort, ver lib/pacientesConsolidados.js — si ya hay ficha con este teléfono
    // esos datos ganan solos (no hace falta chequearlo acá), y no bloquea la respuesta
    // si la planilla falla.
    await upsertPacienteConsolidado({ telefono: telNormalizado, nombre: aTituloCase(nombre), apellido: aTituloCase(apellido), dni, origen: 'turno' });

    res.status(200).json({
      success: true,
      message: `${sobreturno ? 'Sobreturno' : 'Turno'} cargado para el ${date} a las ${time} hs.`,
      eventId: created.id,
      calendarId,
      codigoCorto,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/crear-turno.js', detalle: sobreturno ? 'sobreturno' : 'turno', error: err });
    res.status(500).json({ success: false, message: 'Error al cargar el turno.' });
  }
}
