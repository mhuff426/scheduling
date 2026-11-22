// Shift eligibility: may this person take this shift? One check, used by the
// generator, admin reassign and trades, each passing its own policy (ADR 0001).
// Terms follow GLOSSARY.md, "Eligibility".

import { isCountingShiftType, shiftMaximum, vacationYearOf, vacationYearsOf, yearBalance } from '../shared/settlement.js';
import type { Assignment, Db, Schedule, ShiftType, Slot, User } from '../shared/types.js';

export type LimitAction = 'block' | 'warn' | 'ignore';

// What a policy does with each limit. Hard rules always block and aren't
// part of a policy.
export interface EligibilityPolicy {
  name: string;
  affordableMustOff: LimitAction;
  unaffordableMustOff: LimitAction;
  consecutiveNightLimit: LimitAction;
  shiftMaximum: LimitAction;
}

// The generator may schedule over an unaffordable must-off day (and honours it
// where coverage allows, through its own ranking).
export const GENERATOR_POLICY: EligibilityPolicy = {
  name: 'generator',
  affordableMustOff: 'block',
  unaffordableMustOff: 'ignore',
  consecutiveNightLimit: 'block',
  shiftMaximum: 'block',
};
// An admin may do anything the generator could have done: an unaffordable
// must-off day is open to them. An affordable one stays the person's own. An
// admin overriding the generator may go past its limits, after confirming.
export const ADMIN_REASSIGN_POLICY: EligibilityPolicy = {
  name: 'admin reassign',
  affordableMustOff: 'block',
  unaffordableMustOff: 'ignore',
  consecutiveNightLimit: 'warn',
  shiftMaximum: 'warn',
};
export const TRADE_POLICY: EligibilityPolicy = {
  name: 'trade',
  affordableMustOff: 'block',
  unaffordableMustOff: 'block',
  consecutiveNightLimit: 'block',
  // Picked-up shifts are "extra" by design: trading past the maximum is the
  // person's own choice.
  shiftMaximum: 'ignore',
};

// What a person holds, as the check sees it. Adapters decide where it comes
// from (a schedule's assignments, or the generator's live indexes).
export interface HeldShifts {
  // The shift held on `date`, if any.
  on(date: string): Assignment | undefined;
  // Every held shift that could come within the rest window of a shift on
  // `date`. It may return more (the rest check skips the far ones).
  near(date: string): Iterable<Assignment>;
  // How many counting shifts (standby excluded) the person holds.
  countingShifts(): number;
}

export interface DayFacts {
  mustOff(date: string): { affordable: boolean } | null;
  isAway(date: string): boolean;
}

export interface EligibilityInput {
  person: User;
  date: string;
  shiftType: ShiftType;
  held: HeldShifts;
  facts: DayFacts;
  shiftTypes: Record<string, ShiftType>;
  policy: EligibilityPolicy;
}

export type Eligibility =
  | { eligible: true; warnings: EligibilityWarning[] }
  | { eligible: false; reason: string };

export interface EligibilityWarning {
  kind: 'must-off day' | 'shift maximum' | 'consecutive-night limit';
  message: string;
}

// Confirmation contract: a mutation that produces warnings is refused with
// CONFIRM_WARNINGS_CODE (carrying the warnings) until the request lists, in
// `confirmedWarnings`, the kind of every warning it now triggers. Checked
// afresh on every request, so a warning that appeared since is refused again.
export const CONFIRM_WARNINGS_CODE = 'eligibility_warnings';
export function needsConfirmation(warnings: EligibilityWarning[], confirmedWarnings: unknown): boolean {
  const confirmed = Array.isArray(confirmedWarnings) ? confirmedWarnings : [];
  return warnings.some((w) => !confirmed.includes(w.kind));
}

// True if the user holds a role allowed to fill this shift type. A shift with
// no allowedRoles (empty/absent) is open to everyone.
export function hasRequiredRole(user: User, st: { allowedRoles?: string[] }): boolean {
  if (!st.allowedRoles || st.allowedRoles.length === 0) return true;
  const roles = user.roles || [];
  return st.allowedRoles.some((r) => roles.includes(r));
}

// True if the user has a start date and `date` is before it (not yet onboarded).
export function isBeforeStart(user: User, date: string): boolean {
  return !!user.startDate && date < user.startDate;
}

// True if `date` falls inside any of the user's admin-set away ranges
// (inclusive). Away time blocks scheduling but never costs vacation.
export function isAway(db: Pick<Db, 'awayTime'>, userId: string, date: string): boolean {
  return db.awayTime.some((a) => a.userId === userId && a.start <= date && date <= a.end);
}

const REST_MINUTES = 8 * 60;

// A shift is "overnight" when it crosses midnight into sleeping hours. A shift
// ending exactly at midnight (e.g. 16:00–00:00) is late, but not overnight.
export function isOvernight(st: ShiftType) {
  return st.endTime <= st.startTime && st.endTime !== '00:00';
}

// Concrete start/end of one occurrence, in epoch minutes (local clock).
export function shiftBounds(date: string, st: ShiftType): number[] {
  const start = new Date(`${date}T${st.startTime}:00`).getTime() / 60000;
  let end = new Date(`${date}T${st.endTime}:00`).getTime() / 60000;
  if (st.endTime <= st.startTime) end += 24 * 60;
  return [start, end];
}

// True when a new occurrence of `st` on `date` leaves at least REST_MINUTES
// on both sides of every shift the user already holds.
export function restOk(heldAssignments: Iterable<Assignment>, shiftById: Record<string, ShiftType>, date: string, st: ShiftType): boolean {
  const [s, e] = shiftBounds(date, st);
  for (const a of heldAssignments) {
    const held = shiftById[a.shiftTypeId];
    if (!held) continue;
    const [s2, e2] = shiftBounds(a.date, held);
    if (!(s >= e2 + REST_MINUTES || e + REST_MINUTES <= s2)) return false;
  }
  return true;
}

function prevDay(date: string) {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Consecutive days held on ANY overnight shift, ending the day before `date`.
function overnightRunBefore(held: Pick<HeldShifts, 'on'>, shiftById: Record<string, ShiftType>, date: string) {
  let len = 0;
  let cur = prevDay(date);
  for (;;) {
    const a = held.on(cur);
    if (!a) break;
    const st = shiftById[a.shiftTypeId];
    if (!st || !isOvernight(st)) break;
    len++;
    cur = prevDay(cur);
  }
  return len;
}

// Would `st` on `date` keep the person within their consecutive-night limit
// (all overnight types counted together)?
function withinNightLimit(person: User, held: Pick<HeldShifts, 'on'>, shiftById: Record<string, ShiftType>, date: string, st: ShiftType) {
  if (!isOvernight(st)) return true;
  const cap = Number(person.maxConsecutiveNights);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return overnightRunBefore(held, shiftById, date) + 1 <= cap;
}

// Same check over a plain list of the person's assignments.
export function nightCapOk(user: User, userAssignments: Assignment[], shiftById: Record<string, ShiftType>, date: string, st: ShiftType) {
  const byDate = new Map(userAssignments.map((a) => [a.date, a]));
  return withinNightLimit(user, { on: (d) => byDate.get(d) }, shiftById, date, st);
}

const blocked = (reason: string): Eligibility => ({ eligible: false, reason });

export function checkEligibility({ person, date, shiftType, held, facts, shiftTypes, policy }: EligibilityInput): Eligibility {
  const warnings: EligibilityWarning[] = [];
  // A limit the policy blocks on returns its reason; `warn` collects it.
  const limit = (action: LimitAction, kind: EligibilityWarning['kind'], message: string): Eligibility | null => {
    if (action === 'block') return blocked(message);
    if (action === 'warn') warnings.push({ kind, message });
    return null;
  };

  if (!hasRequiredRole(person, shiftType))
    return blocked(`${person.name} doesn't have a role allowed for that shift.`);
  const off = facts.mustOff(date);
  if (off) {
    const action = off.affordable ? policy.affordableMustOff : policy.unaffordableMustOff;
    const r = limit(action, 'must-off day', `${person.name} is on vacation that day.`);
    if (r) return r;
  }
  if (isBeforeStart(person, date))
    return blocked(`${person.name} hasn't started yet (starts ${person.startDate}).`);
  if (facts.isAway(date)) return blocked(`${person.name} is on away time that day.`);
  if (held.on(date)) return blocked(`${person.name} already works a shift that day.`);
  if (!restOk(held.near(date), shiftTypes, date, shiftType))
    return blocked(`${person.name} would have less than 8 hours of rest around that shift.`);
  if (!withinNightLimit(person, held, shiftTypes, date, shiftType)) {
    const r = limit(policy.consecutiveNightLimit, 'consecutive-night limit',
      `${person.name} would exceed their ${person.maxConsecutiveNights}-night limit on consecutive overnight shifts.`);
    if (r) return r;
  }
  // Only counting shifts count toward the shift maximum.
  const max = shiftMaximum(person);
  if (isCountingShiftType(shiftType) && held.countingShifts() + 1 > max) {
    const r = limit(policy.shiftMaximum, 'shift maximum',
      `${person.name} is already at their maximum of ${max} shifts for this schedule.`);
    if (r) return r;
  }
  return { eligible: true, warnings };
}

// Held-shifts view over a schedule's assignments, leaving out `givingUp` (the
// shifts the person hands over in the same move). Used by trades and reassign.
export function scheduleHeldShifts(
  assignments: Assignment[], userId: string, shiftTypes: Record<string, ShiftType>, givingUp: Assignment[] = []
): HeldShifts {
  const mine = assignments.filter((a) => a.userId === userId && !givingUp.includes(a));
  const byDate = new Map(mine.map((a) => [a.date, a]));
  return {
    on: (date) => byDate.get(date),
    near: () => mine,
    countingShifts: () => mine.filter((a) => isCountingShiftType(shiftTypes[a.shiftTypeId])).length,
  };
}

// The generator's live per-person indexes, keyed by person id. Read on every
// call, so the view follows the schedule as it fills in.
interface Lookup<V> { get(key: string): V | undefined }
export interface HeldShiftIndexes {
  list: Lookup<Assignment[]>;
  byDate: Lookup<Lookup<Assignment>>;
  counts: Lookup<number>;
}

// Held-shifts view over the generator's indexes: O(1) per question, so the
// generator keeps its speed.
export function indexedHeldShifts(userId: string, { list, byDate, counts }: HeldShiftIndexes): HeldShifts {
  return {
    on: (date) => byDate.get(userId)?.get(date),
    near: () => list.get(userId) ?? [],
    countingShifts: () => counts.get(userId) ?? 0,
  };
}

// Unaffordable must-off days: in each vacation year the schedule spans, when
// the person's must-off days in the schedule falling in that year outnumber
// their year balance for it, all of that year's must-off days are
// unaffordable. The generator and the live check below share this rule.
export function unaffordableMustOffDays(
  mustOffDates: string[], schedule: { startDate: string; endDate: string }, yearBalanceOf: (year: number) => number
): Set<string> {
  const out = new Set<string>();
  for (const y of vacationYearsOf(schedule)) {
    const inYear = mustOffDates.filter((d) => vacationYearOf(d) === y);
    if (inYear.length > yearBalanceOf(y)) for (const d of inYear) out.add(d);
  }
  return out;
}

// A schedulable day (GLOSSARY.md): a day in the schedule with at least one
// shift, where the person has started, isn't on away time and has no must-off
// day other than an unaffordable one. The generator's look-ahead and the
// schedule summary's charge warning both count days with this.
export function isSchedulableDay(person: User, date: string, facts: DayFacts, hasShift: boolean): boolean {
  if (!hasShift || isBeforeStart(person, date) || facts.isAway(date)) return false;
  const off = facts.mustOff(date);
  return !off || !off.affordable;
}

type FactsSchedule =Pick<Schedule, 'startDate' | 'endDate'> & Partial<Pick<Schedule, 'id' | 'vacationCharges'>>;

// Day facts read straight from the db, for trades and reassign. Affordability
// is recomputed live: year balances from every schedule as they stand now,
// leaving out `schedule`'s own vacation charges (so settling a schedule
// doesn't change which of its must-off days are protected).
export function dbDayFacts(
  db: Pick<Db, 'timeOff' | 'awayTime' | 'schedules'>, person: Pick<User, 'id' | 'vacationDays'>, schedule: FactsSchedule
): DayFacts {
  const mustOff = new Set(
    db.timeOff.filter((t) => t.userId === person.id && t.type === 'vacation').map((t) => t.date)
  );
  const inSchedule = [...mustOff].filter((d) => schedule.startDate <= d && d <= schedule.endDate);
  const isThis = (s: (typeof db.schedules)[number]) => s === schedule || (schedule.id !== undefined && s.id === schedule.id);
  const others = { schedules: db.schedules.map((s) => (isThis(s) ? { ...s, vacationCharges: [] } : s)) };
  const unaffordable = unaffordableMustOffDays(inSchedule, schedule, (y) => yearBalance(others, person, y).balance);
  return {
    mustOff: (date) => (mustOff.has(date) ? { affordable: !unaffordable.has(date) } : null),
    isAway: (date) => isAway(db, person.id, date),
  };
}

// May `person` take `slot` in `schedule`, judged as if the shifts in
// `givingUp` were already handed over?
export function scheduleEligibility(
  db: Db, schedule: FactsSchedule & Pick<Schedule, 'assignments'>, slot: Slot, person: User,
  policy: EligibilityPolicy, givingUp: Assignment[] = []
): Eligibility {
  const shiftTypes: Record<string, ShiftType> = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
  const shiftType = shiftTypes[slot.shiftTypeId];
  if (!shiftType) return blocked('That shift type no longer exists.');
  return checkEligibility({
    person, date: slot.date, shiftType, shiftTypes, policy,
    held: scheduleHeldShifts(schedule.assignments, person.id, shiftTypes, givingUp),
    facts: dbDayFacts(db, person, schedule),
  });
}
