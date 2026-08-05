import {
  getCalendarClient, CALENDAR_ID, WEEKLY_SCHEDULE, SLOT_MINUTES,
  toArgDate, formatArgTime, eventBounds,
} from '../lib/googleCalendar.js';

export default async function handler(req, res) {
  try {
    const dateStr = req.query.date; // "yyyy-MM-dd"

    const [y, m, d] = dateStr.split('-').map(Number);
    const dayOfWeek = new Date(y, m - 1, d).getDay();
    const ranges = WEEKLY_SCHEDULE[dayOfWeek] || [];
    if (ranges.length === 0) return res.status(200).json([]);

    const allSlots = [];
    ranges.forEach((range) => {
      let current = toArgDate(dateStr, range[0]);
      const end = toArgDate(dateStr, range[1]);
      while (current < end) {
        const slotEnd = new Date(current.getTime() + SLOT_MINUTES * 60000);
        if (slotEnd <= end) allSlots.push({ start: new Date(current), end: slotEnd });
        current = slotEnd;
      }
    });

    const dayStart = toArgDate(dateStr, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

    const calendar = getCalendarClient();
    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
    });

    const events = (data.items || []).map(eventBounds);
    const now = new Date();

    const free = allSlots.filter(
      (slot) => slot.start > now && !events.some((ev) => slot.start < ev.end && slot.end > ev.start)
    );

    res.status(200).json(free.map((slot) => formatArgTime(slot.start)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron cargar los horarios.' });
  }
}
