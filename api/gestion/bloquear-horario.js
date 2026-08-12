import {
  getCalendarClient, CALENDAR_ID, BLOCK_MARKER, TIME_ZONE, toArgDate, isValidGestionKey,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, date, horaInicio, horaFin, motivo } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  try {
    const start = toArgDate(date, horaInicio);
    const end = toArgDate(date, horaFin);

    if (!(end > start)) {
      return res.status(200).json({
        success: false,
        message: 'La hora de fin tiene que ser posterior a la de inicio.',
      });
    }

    const calendar = getCalendarClient();

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
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/bloquear-horario.js', error: err });
    res.status(500).json({ success: false, message: 'Error al bloquear el horario.' });
  }
}
