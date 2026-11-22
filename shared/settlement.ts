// Settlement: the accounting that turns a schedule's outcome into vacation
// charges, extra days and year balances (see GLOSSARY.md). Pure and shared by
// the server and the browser — every settlement rule lives here, so the two
// can't drift apart. Each function takes only the slice of state it reads, so
// the browser's per-tab data satisfies it.

import type { Assignment, ExtraElection, ShiftType, User } from './types.js';

// Weight of a shift type. An explicit number (0 allowed) wins; null, absent
// or '' mean "automatic" (1). Number(null) is 0, so check raw first. Weight 0
// = standby: the shift is held but doesn't count toward settlement.
export function shiftWeight(st: Pick<ShiftType, 'weight'>): number {
  const raw: unknown = st?.weight;
  if (raw !== null && raw !== undefined && raw !== '') {
    const w = Number(raw);
    if (Number.isFinite(w) && w >= 0) return w;
  }
  return 1;
}

// Whether a shift of this type counts toward required shifts. Shifts of a
// deleted shift type (undefined) don't count.
export function isCountingShiftType(st: Pick<ShiftType, 'weight'> | undefined): boolean {
  return !!st && shiftWeight(st) > 0;
}

// Counting shifts one person holds in a schedule (standby excluded).
export function countingShifts(
  data: { shiftTypes: ShiftType[] },
  schedule: { assignments: Assignment[] },
  userId: string
): number {
  const stById = new Map(data.shiftTypes.map((s) => [s.id, s]));
  return schedule.assignments.filter(
    (a) => a.userId === userId && isCountingShiftType(stById.get(a.shiftTypeId))
  ).length;
}

// A person's shift maximum per schedule: their maxShiftsOverride, or no
// maximum (Infinity) when it's absent, invalid or non-positive. (0/blank
// means "no override", not "no shifts" — exclude someone from the block for
// that.)
export function shiftMaximum(user: Pick<User, 'maxShiftsOverride'>): number {
  const o = Number(user.maxShiftsOverride);
  return Number.isFinite(o) && o > 0 ? o : Infinity;
}

// Counting shifts a person owes in one schedule: their personal requirement,
// lowered to their shift maximum when that is smaller. Never reduced by
// must-off days — vacation charges cover that gap instead.
export function requiredShifts(user: Pick<User, 'requiredShifts' | 'maxShiftsOverride'>): number {
  return Math.min(Number(user.requiredShifts) || 0, shiftMaximum(user));
}

type SettledPerson = Pick<User, 'id' | 'requiredShifts' | 'maxShiftsOverride'>;
type SettledSchedule = { assignments: Assignment[]; vacationCharged?: Record<string, number> };

// Vacation days already charged to one person in a schedule.
export function vacationChargedIn(schedule: { vacationCharged?: Record<string, number> }, userId: string): number {
  return schedule.vacationCharged?.[userId] || 0;
}

// Counting shifts a person is below their required shifts (charges aside).
export function shortfall(data: { shiftTypes: ShiftType[] }, schedule: SettledSchedule, user: SettledPerson): number {
  return Math.max(0, requiredShifts(user) - countingShifts(data, schedule, user.id));
}

// Counting shifts plus vacation charges beyond required shifts — the
// currency a person can elect into extra vacation or incentive pay.
export function extraDays(data: { shiftTypes: ShiftType[] }, schedule: SettledSchedule, user: SettledPerson): number {
  return Math.max(
    0,
    countingShifts(data, schedule, user.id) + vacationChargedIn(schedule, user.id) - requiredShifts(user)
  );
}

// The vacation year a schedule's charges and elections count toward: the
// calendar year of its start date.
export function vacationYearOf(schedule: { startDate?: string }): number {
  return Number(schedule.startDate?.slice(0, 4));
}

type SettledYearSchedule = {
  startDate?: string;
  vacationCharged?: Record<string, number>;
  extraElections?: Record<string, ExtraElection>;
};

// A person's year balance: vacation allowance + extra days elected as
// vacation (earned) − vacation charges (used), across the schedules in that
// vacation year. Not floored — callers that need "what's left" floor it.
export function yearBalance(
  data: { schedules?: SettledYearSchedule[] },
  user: Pick<User, 'id' | 'vacationDays'>,
  year: number
): { used: number; earned: number; balance: number } {
  let used = 0;
  let earned = 0;
  for (const s of data.schedules || []) {
    if (vacationYearOf(s) !== year) continue;
    used += vacationChargedIn(s, user.id);
    earned += s.extraElections?.[user.id]?.vacation || 0;
  }
  return { used, earned, balance: user.vacationDays + earned - used };
}

// Vacation days charged to cover a shortfall against the full required
// shifts: the shortfall, capped by the must-off days in the block that caused
// it and by the person's year balance (floored at zero).
export function vacationCharge({ required, counting, mustOffDays, yearBalance }: {
  required: number; counting: number; mustOffDays: number; yearBalance: number;
}): number {
  return Math.min(Math.max(0, required - counting), mustOffDays, Math.max(0, yearBalance));
}

export interface GiveawayResult {
  // Losing the shift drops the giver below their required shifts, so
  // claiming it charges them one vacation day.
  needsDay: boolean;
  // The giver's extra days once the shift (and any vacation day) settles.
  extraAfter: number;
  // How much of the giver's extra-day election no longer fits in
  // extraAfter: incentive days are cut first, then vacation days.
  electionCut: ExtraElection;
  balanceBefore: number;
  // Year balance after the vacation day and the election's vacation cut.
  balanceAfter: number;
  // Posting is refused only when a day is needed and none are left (the
  // election cut isn't considered until claim time).
  canPost: boolean;
  // Claiming is refused when it would push the year balance below zero.
  canClaim: boolean;
}

// What giving `offered` away would do to the giver's settlement. Pure: the
// caller applies the result. Weight-0 standby shifts never count, so giving
// one away never needs a day.
export function giveaway(
  data: { shiftTypes: ShiftType[]; schedules?: SettledYearSchedule[] },
  schedule: SettledSchedule & SettledYearSchedule,
  giver: SettledPerson & Pick<User, 'vacationDays'>,
  offered: { shiftTypeId: string }
): GiveawayResult {
  const losesCount = isCountingShiftType(data.shiftTypes.find((s) => s.id === offered.shiftTypeId)) ? 1 : 0;
  const counting = countingShifts(data, schedule, giver.id) - losesCount;
  const charged = vacationChargedIn(schedule, giver.id);
  const required = requiredShifts(giver);
  const needsDay = counting + charged < required;
  const extraAfter = Math.max(0, counting + charged + (needsDay ? 1 : 0) - required);
  const el = schedule.extraElections?.[giver.id];
  const over = el ? Math.max(0, el.vacation + el.incentive - extraAfter) : 0;
  const incentiveCut = el ? Math.min(over, el.incentive) : 0;
  const electionCut = { incentive: incentiveCut, vacation: over - incentiveCut };
  const balanceBefore = yearBalance(data, giver, vacationYearOf(schedule)).balance;
  const balanceAfter = balanceBefore - (needsDay ? 1 : 0) - electionCut.vacation;
  return {
    needsDay,
    extraAfter,
    electionCut,
    balanceBefore,
    balanceAfter,
    canPost: !(needsDay && balanceBefore <= 0),
    canClaim: balanceAfter >= 0,
  };
}
