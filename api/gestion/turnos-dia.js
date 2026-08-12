import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER,
  toArgDate, eventBounds, isValidGestionKey, extraerTelefono, extraerEsNuevoPaciente,
  extraerTelefonoVerificado, extraerConfirmado, extraerDni, extraerCodigoCorto,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { conReintentos } from '../../lib/retry.js';

export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const dateStr = req.query.date;
    const dayStart = toArgDate(dateStr, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      })),
      conReintentos(() => calendar.events.list({
        calendarId: SOBRETURNOS_CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      })),
    ]);

    const items = [];

    (principal.data.items || []).forEach((ev) => {
      const { start, end } = eventBounds(ev);
      const allDay = !ev.start.dateTime;
      const isBloqueo = allDay || (ev.description || '').includes(BLOCK_MARKER);
      items.push({
        id: ev.id,
        calendarId: CALENDAR_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        title: ev.summary || '',
        description: ev.description || '',
        tipo: isBloqueo ? 'bloqueo' : 'turno',
        allDay,
        telefono: extraerTelefono(ev.description),
        dni: extraerDni(ev.description),
        codigoCorto: extraerCodigoCorto(ev.description),
        esNuevoPaciente: extraerEsNuevoPaciente(ev.description),
        telefonoVerificado: extraerTelefonoVerificado(ev.description),
        confirmado: extraerConfirmado(ev.description),
      });
    });

    (sobreturnos.data.items || []).forEach((ev) => {
      const { start, end } = eventBounds(ev);
      items.push({
        id: ev.id,
        calendarId: SOBRETURNOS_CALENDAR_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        title: ev.summary || '',
        description: ev.description || '',
        tipo: 'sobreturno',
        allDay: !ev.start.dateTime,
        telefono: extraerTelefono(ev.description),
        dni: extraerDni(ev.description),
        codigoCorto: extraerCodigoCorto(ev.description),
        esNuevoPaciente: extraerEsNuevoPaciente(ev.description),
        telefonoVerificado: extraerTelefonoVerificado(ev.description),
        confirmado: extraerConfirmado(ev.description),
      });
    });

    items.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json(items);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/turnos-dia.js', error: err });
    res.status(500).json({ error: 'No se pudo cargar la agenda del día.' });
  }
}
