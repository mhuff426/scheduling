// Client mirror of the server's settlement accounting (server/scheduler.ts +
// server/db.ts): counting shifts, per-person requirements, vacation charges,
// extra days, and yearly allowance.

import type { Db, Schedule, ShiftType, User } from '../../shared/types.js';

export function shiftWeight(st: ShiftType): number {
  // null/undefined/'' mean "automatic" (resolves to 1) — only an explicit
  // number (0 allowed) overrides. Number(null) is 0, so check raw first.
  const raw: unknown = st?.weight;
  if (raw !== null && raw !== undefined && raw !== '') {
    const w = Number(raw);
    if (Number.isFinite(w) && w >= 0) return w;
  }
  return 1;
}

export function countingShifts(db: Db, schedule: Schedule, userId: string): number {
  const stById: Record<string, ShiftType> = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
  return schedule.assignments.filter(
    (a) =>
      a.userId === userId &&
      stById[a.shiftTypeId] &&
      shiftWeight(stById[a.shiftTypeId]) > 0
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

export interface ShiftTypeBreakdownRow {
  shiftTypeId: string;
  name: string;
  standby: boolean;
  shifts: number;
  extra: number;
}

// Per-shift-type tally of one person's shifts in a schedule, plus how many of
// each kind they picked up as extras (completed giveaways they claimed — same
// definition as the server's extraShifts()). Rows follow shift-type
// definition order; all-zero rows are dropped; ids of since-deleted types
// still get a row so the totals always reconcile with the dated list.
export function shiftTypeBreakdown(db: Db, schedule: Schedule, userId: string) {
  const shifts = new Map<string, number>();
  const extra = new Map<string, number>();
  for (const a of schedule.assignments) {
    if (a.userId === userId) shifts.set(a.shiftTypeId, (shifts.get(a.shiftTypeId) || 0) + 1);
  }
  for (const t of db.trades || []) {
    if (t.type === 'giveaway' && t.status === 'completed' && t.scheduleId === schedule.id && t.claimedBy === userId) {
      extra.set(t.offered.shiftTypeId, (extra.get(t.offered.shiftTypeId) || 0) + 1);
    }
  }
  const known = new Set(db.shiftTypes.map((s) => s.id));
  const rows: ShiftTypeBreakdownRow[] = [];
  for (const st of db.shiftTypes) {
    const s = shifts.get(st.id) || 0;
    const e = extra.get(st.id) || 0;
    if (s || e) rows.push({ shiftTypeId: st.id, name: st.name, standby: shiftWeight(st) === 0, shifts: s, extra: e });
  }
  for (const id of new Set([...shifts.keys(), ...extra.keys()])) {
    if (!known.has(id)) {
      rows.push({ shiftTypeId: id, name: '(deleted shift type)', standby: false, shifts: shifts.get(id) || 0, extra: extra.get(id) || 0 });
    }
  }
  const total = rows.reduce((t, r) => ({ shifts: t.shifts + r.shifts, extra: t.extra + r.extra }), { shifts: 0, extra: 0 });
  return { rows, total };
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
