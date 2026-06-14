// Client mirror of the server's settlement accounting (server/scheduler.ts +
// server/db.ts): counting shifts, per-person requirements, vacation charges,
// extra days, and yearly allowance.

import type { Db, Schedule, ShiftType, User } from '../../shared/types.js';

export function shiftWeight(st: ShiftType, settings: { overnightWeight?: number }): number {
  // null/undefined/'' mean "automatic" — only an explicit number (0 allowed)
  // overrides. Number(null) is 0, so the raw value must be checked first.
  const raw: unknown = st?.weight;
  if (raw !== null && raw !== undefined && raw !== '') {
    const w = Number(raw);
    if (Number.isFinite(w) && w >= 0) return w;
  }
  const overnight = st.endTime <= st.startTime && st.endTime !== '00:00';
  return overnight ? Number(settings?.overnightWeight) || 1.5 : 1;
}

export function countingShifts(db: Db, schedule: Schedule, userId: string): number {
  const stById: Record<string, ShiftType> = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
  return schedule.assignments.filter(
    (a) =>
      a.userId === userId &&
      stById[a.shiftTypeId] &&
      shiftWeight(stById[a.shiftTypeId], db.settings) > 0
  ).length;
}

export function requiredFor(user: User): number {
  const o = Number(user.maxShiftsOverride);
  const max = Number.isFinite(o) && o > 0 ? o : Infinity;
  return Math.min(Number(user.requiredShifts) || 0, max);
}

export function settlementFor(db: Db, schedule: Schedule, user: User) {
  const count = countingShifts(db, schedule, user.id);
  const required = requiredFor(user);
  const charged = schedule.vacationCharged?.[user.id] || 0;
  const extra = Math.max(0, count + charged - required);
  const election = schedule.extraElections?.[user.id] || { vacation: 0, incentive: 0 };
  return { count, required, charged, extra, election };
}

// Yearly allowance: base grant + extra days elected as vacation − charges.
export function vacationSummary(db: Db, user: User, year: number) {
  let used = 0;
  let earned = 0;
  for (const s of db.schedules || []) {
    if (!s.startDate?.startsWith(String(year))) continue;
    used += s.vacationCharged?.[user.id] || 0;
    earned += s.extraElections?.[user.id]?.vacation || 0;
  }
  return { used, earned, available: user.vacationDays + earned - used };
}
