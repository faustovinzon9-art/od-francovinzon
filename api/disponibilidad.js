import { getCalendarClient, getDisponibilidadMes, getHorariosLibresDia } from '../lib/googleCalendar.js';
import { avisarFallo } from '../lib/alertas.js';

// Fusiona lo que antes eran disponibilidad-mes.js + horarios-dia.js (mismo patrón de
// "modo" ya usado en api/gestion/buscar.js) para no sumar un archivo nuevo — ver
// CLAUDE.md sobre el límite de 12 funciones serverless del plan Hobby de Vercel.
//
// Sin "modo" (default) — GET ?year&month: disponibilidad del mes, { "1": bool, ... }.
// ?modo=dia — GET ?modo=dia&date: horarios libres de un día puntual, array de "HH:mm".
export default async function handler(req, res) {
  const esModoDia = req.query.modo === 'dia';
  try {
    const calendar = getCalendarClient();

    if (esModoDia) {
      const free = await getHorariosLibresDia(calendar, req.query.date);
      return res.status(200).json(free);
    }

    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    const result = await getDisponibilidadMes(calendar, year, month);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/disponibilidad.js', detalle: esModoDia ? 'modo=dia' : 'modo=mes', error: err });
    const message = esModoDia ? 'No se pudieron cargar los horarios.' : 'No se pudo cargar la disponibilidad.';
    res.status(500).json({ error: message });
  }
}
