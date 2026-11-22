// Display-only shift tallies for the schedule screen. Settlement rules
// (counting shifts, required shifts, charges, balances) live in
// shared/settlement.ts — import those from there, never re-derive them here.

import { shiftWeight } from '../../shared/settlement.js';
import type { Db, Schedule } from '../../shared/types.js';

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
