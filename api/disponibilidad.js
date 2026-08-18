import { getCalendarClient, getDisponibilidadMes, getHorariosLibresDia } from '../lib/googleCalendar.js';
import { avisarFallo } from '../lib/alertas.js';
import { obtenerHorariosConfig, obtenerReservaOnlinePausada } from '../lib/adminConfig.js';

// Fusiona lo que antes eran disponibilidad-mes.js + horarios-dia.js (mismo patrón de
// "modo" ya usado en api/gestion/buscar.js) para no sumar un archivo nuevo — ver
// CLAUDE.md sobre el límite de 12 funciones serverless del plan Hobby de Vercel.
//
// Sin "modo" (default) — GET ?year&month: disponibilidad del mes, { "1": bool, ... }.
// ?modo=dia — GET ?modo=dia&date: horarios libres de un día puntual, array de "HH:mm".
// ?modo=estado — GET: { pausada: bool } del interruptor de reserva online (ver el
// pedido, 2026-08-14). Vive acá (no en api/gestion/admin.js) porque /turnos y la home
// son páginas públicas sin ADMIN_KEY/GESTION_KEY, y este archivo ya es público.
export default async function handler(req, res) {
  const esModoDia = req.query.modo === 'dia';
  const esModoEstado = req.query.modo === 'estado';
  try {
    if (esModoEstado) {
      const pausada = await obtenerReservaOnlinePausada();
      return res.status(200).json({ pausada });
    }

    const calendar = getCalendarClient();
    const { schedule, slotMinutes } = await obtenerHorariosConfig();

    if (esModoDia) {
      const free = await getHorariosLibresDia(calendar, req.query.date, schedule, slotMinutes);
      return res.status(200).json(free);
    }

    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    const result = await getDisponibilidadMes(calendar, year, month, schedule, slotMinutes);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    const detalle = esModoEstado ? 'modo=estado' : esModoDia ? 'modo=dia' : 'modo=mes';
    await avisarFallo({ endpoint: 'api/disponibilidad.js', detalle, error: err });
    if (esModoEstado) return res.status(200).json({ pausada: true }); // fail-safe: nunca romper /turnos ni la home
    const message = esModoDia ? 'No se pudieron cargar los horarios.' : 'No se pudo cargar la disponibilidad.';
    res.status(500).json({ error: message });
  }
}
