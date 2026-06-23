// Holiday recurrence resolution. Pure local-time date math shared by the server
// (scheduler + endpoint validation) and the client (calendars). Never uses
// toISOString — all reasoning is in local calendar terms to avoid off-by-one
// timezone bugs (same convention as shared/blocks.ts).

import type { Holiday, HolidayRecurrence } from './types.js';

const pad = (n: number): string => String(n).padStart(2, '0');

// The concrete YYYY-MM-DD a holiday lands on in a given calendar year, or null
// when it has no occurrence that year (e.g. yearly Feb 29 in a non-leap year,
// or a 4th-weekday rule in a month that only has three of that weekday).
export function resolveHoliday(h: Holiday, year: number): string | null {
  const r = h.recurrence;
  if (r.type === 'one-off') {
    return Number(r.date.slice(0, 4)) === year ? r.date : null;
  }
  if (r.type === 'yearly') {
    // Validate the month/day actually exists in this year (rejects Feb 29 in a
    // non-leap year). new Date rolls invalid days over, so check it round-trips.
    const d = new Date(year, r.month - 1, r.day);
    if (d.getFullYear() !== year || d.getMonth() !== r.month - 1 || d.getDate() !== r.day) return null;
    return `${year}-${pad(r.month)}-${pad(r.day)}`;
  }
  // nth-weekday
  const monthIdx = r.month - 1;
  if (r.ordinal === -1) {
    // Last matching weekday: walk back from the last day of the month.
    const last = new Date(year, monthIdx + 1, 0); // day 0 of next month = last day
    const back = (last.getDay() - r.weekday + 7) % 7;
    const day = last.getDate() - back;
    return `${year}-${pad(r.month)}-${pad(day)}`;
  }
  // 1st..4th: first matching weekday, then add whole weeks.
  const first = new Date(year, monthIdx, 1);
  const offset = (r.weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (r.ordinal - 1) * 7;
  // Guard against an ordinal that overruns the month (e.g. a 4th that doesn't
  // exist — rare, but keep it predictable rather than spilling into next month).
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  if (day > daysInMonth) return null;
  return `${year}-${pad(r.month)}-${pad(day)}`;
}

// Every holiday occurrence (with its source holiday) that falls within the
// inclusive [startDate, endDate] window, expanded across the calendar years the
// window spans.
export function holidayDatesInRange(
  holidays: Holiday[],
  startDate: string,
  endDate: string,
): { date: string; holiday: Holiday }[] {
  const out: { date: string; holiday: Holiday }[] = [];
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  for (const h of holidays) {
    for (let year = startYear; year <= endYear; year++) {
      const date = resolveHoliday(h, year);
      if (date && date >= startDate && date <= endDate) out.push({ date, holiday: h });
    }
  }
  return out;
}

const isYmd = (s: any): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isInt = (n: any, lo: number, hi: number): boolean =>
  Number.isInteger(n) && n >= lo && n <= hi;

// Validates an untrusted recurrence payload (request body / form state).
export function isValidRecurrence(r: any): r is HolidayRecurrence {
  if (!r || typeof r !== 'object') return false;
  if (r.type === 'one-off') return isYmd(r.date);
  if (r.type === 'yearly') return isInt(r.month, 1, 12) && isInt(r.day, 1, 31);
  if (r.type === 'nth-weekday')
    return isInt(r.month, 1, 12) && isInt(r.weekday, 0, 6) && (isInt(r.ordinal, 1, 4) || r.ordinal === -1);
  return false;
}
