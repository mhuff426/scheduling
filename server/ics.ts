// Builds an iCalendar (.ics) file from a user's assignments so shifts can be
// imported into Google Calendar, Apple Calendar, Outlook, etc.
// Times are emitted as floating local times, which is the right behavior for
// shift work (an 8am shift is 8am wherever the workplace is).

import type { Assignment, ShiftType, User } from '../shared/types.js';

function icsEscape(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function dt(date: string, time: string): string {
  return date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

interface BuildIcsArgs {
  user: User;
  assignments: Assignment[];
  shiftTypes: ShiftType[];
  scheduleId: string;
}

export function buildIcs({ user, assignments, shiftTypes, scheduleId }: BuildIcsArgs): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ShiftScheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(user.name + ' — Work Shifts')}`,
  ];
  for (const a of assignments) {
    const st = shiftTypes.find((s) => s.id === a.shiftTypeId);
    if (!st) continue;
    // Overnight shift: end time at or before start time rolls to the next day.
    const endDate = st.endTime <= st.startTime ? addDays(a.date, 1) : a.date;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${scheduleId}-${a.date}-${st.id}-${user.id}@shiftscheduler`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${dt(a.date, st.startTime)}`,
      `DTEND:${dt(endDate, st.endTime)}`,
      `SUMMARY:${icsEscape(st.name)}`,
      `DESCRIPTION:${icsEscape(`${st.name} shift for ${user.name}`)}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
