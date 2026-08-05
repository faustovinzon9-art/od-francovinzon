import {
  getCalendarClient, CALENDAR_ID, WEEKLY_SCHEDULE, SLOT_MINUTES,
  toArgDate, pad2, formatArgDay, eventBounds,
} from '../lib/googleCalendar.js';

export default async function handler(req, res) {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12

    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = toArgDate(`${year}-${pad2(month)}-01`, '00:00');
    const lastDayStr = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
    const monthEnd = new Date(toArgDate(lastDayStr, '00:00').getTime() + 24 * 60 * 60000);

    const calendar = getCalendarClient();
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

    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo cargar la disponibilidad.' });
  }
}
