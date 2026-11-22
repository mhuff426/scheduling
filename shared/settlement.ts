// Settlement: the accounting that turns a schedule's outcome into vacation
// charges, extra days and year balances (see GLOSSARY.md). Pure and shared by
// the server and the browser — every settlement rule lives here, so the two
// can't drift apart. Each function takes only the slice of state it reads, so
// the browser's per-tab data satisfies it.

import type { Assignment, ExtraElection, ShiftType, User, VacationCharge } from './types.js';

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
type SettledSchedule = { assignments: Assignment[]; vacationCharges?: VacationCharge[] };

// The vacation year a day counts toward: currently its calendar year. The one
// place the vacation-year rule lives — every charge and election goes through
// it, so a configurable year (#33) only changes this function.
export function vacationYearOf(date: string): number {
  return Number(date.slice(0, 4));
}

// Every vacation year a schedule's days fall in, earliest first.
export function vacationYearsOf(schedule: { startDate: string; endDate: string }): number[] {
  const years: number[] = [];
  for (let y = vacationYearOf(schedule.startDate); y <= vacationYearOf(schedule.endDate); y++) years.push(y);
  return years;
}

// Vacation days charged to one person in a schedule — in every vacation year,
// or only in `year`.
export function vacationChargedIn(schedule: { vacationCharges?: VacationCharge[] }, userId: string, year?: number): number {
  return (schedule.vacationCharges || []).filter(
    (c) => c.userId === userId && (year === undefined || vacationYearOf(c.date) === year)
  ).length;
}

// Vacation days an election puts into every vacation year, or only `year`.
export function electedVacation(el: ExtraElection | undefined, year?: number): number {
  if (!el) return 0;
  if (year !== undefined) return Number(el.vacationByYear?.[year]) || 0;
  return Object.values(el.vacationByYear || {}).reduce((t, n) => t + (Number(n) || 0), 0);
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

type SettledYearSchedule = {
  vacationCharges?: VacationCharge[];
  extraElections?: Record<string, ExtraElection>;
};

// A person's year balance: vacation allowance + extra days elected as
// vacation into that year (earned) − vacation charges dated in that year
// (used), across every schedule. Not floored — callers that need "what's
// left" floor it.
export function yearBalance(
  data: { schedules?: SettledYearSchedule[] },
  user: Pick<User, 'id' | 'vacationDays'>,
  year: number
): { used: number; earned: number; balance: number } {
  let used = 0;
  let earned = 0;
  for (const s of data.schedules || []) {
    used += vacationChargedIn(s, user.id, year);
    earned += electedVacation(s.extraElections?.[user.id], year);
  }
  return { used, earned, balance: user.vacationDays + earned - used };
}

// The days charged as vacation to cover a shortfall against the full
// required shifts: must-off days in the block, earliest first, one per
// shortfall shift, skipping a day once its vacation year's balance (floored
// at zero) is used up. Each vacation year's balance is its own limit.
export function shortfallCharges({ required, counting, mustOffDates, yearBalance }: {
  required: number; counting: number; mustOffDates: string[]; yearBalance: (year: number) => number;
}): string[] {
  let short = Math.max(0, required - counting);
  const left = new Map<number, number>();
  const charged: string[] = [];
  for (const date of [...mustOffDates].sort()) {
    if (short <= 0) break;
    const year = vacationYearOf(date);
    if (!left.has(year)) left.set(year, Math.max(0, yearBalance(year)));
    if (left.get(year)! <= 0) continue;
    left.set(year, left.get(year)! - 1);
    charged.push(date);
    short--;
  }
  return charged;
}

export interface GiveawayResult {
  // Losing the shift drops the giver below their required shifts, so
  // claiming it charges them one vacation day, dated on the shift's day.
  needsDay: boolean;
  // The vacation year that day (and so the charge) belongs to.
  chargeYear: number;
  // The giver's extra days once the shift (and any vacation day) settles.
  extraAfter: number;
  // How much of the giver's extra-day election no longer fits in
  // extraAfter: incentive days first, then the earlier vacation year's days
  // as far as that year's balance can absorb, the rest from the later year.
  electionCut: ExtraElection;
  // The charge year's balance before, and after the vacation day and the
  // election cut.
  balanceBefore: number;
  balanceAfter: number;
  // Balance afterwards of every year the giveaway touches (the charge year
  // and every year the cut takes vacation days from).
  balancesAfter: Record<string, number>;
  // Posting is refused only when a day is needed and the charge year has none
  // left (the election cut isn't considered until claim time).
  canPost: boolean;
  // Claiming is refused when it would push any touched year below zero.
  canClaim: boolean;
}

// What giving `offered` away would do to the giver's settlement. Pure: the
// caller applies the result. Weight-0 standby shifts never count, so giving
// one away never needs a day.
export function giveaway(
  data: { shiftTypes: ShiftType[]; schedules?: SettledYearSchedule[] },
  schedule: SettledSchedule & SettledYearSchedule,
  giver: SettledPerson & Pick<User, 'vacationDays'>,
  offered: { date: string; shiftTypeId: string }
): GiveawayResult {
  const losesCount = isCountingShiftType(data.shiftTypes.find((s) => s.id === offered.shiftTypeId)) ? 1 : 0;
  const counting = countingShifts(data, schedule, giver.id) - losesCount;
  const charged = vacationChargedIn(schedule, giver.id);
  const required = requiredShifts(giver);
  const needsDay = counting + charged < required;
  const chargeYear = vacationYearOf(offered.date);
  const extraAfter = Math.max(0, counting + charged + (needsDay ? 1 : 0) - required);

  const balances: Record<string, number> = {};
  const balanceOf = (y: number) => (balances[y] ??= yearBalance(data, giver, y).balance);
  const balanceBefore = balanceOf(chargeYear);
  if (needsDay) balances[chargeYear] -= 1;

  const el = schedule.extraElections?.[giver.id];
  const over = Math.max(0, electedVacation(el) + (el?.incentive || 0) - extraAfter);
  const incentiveCut = Math.min(over, el?.incentive || 0);
  const vacationByYear: Record<string, number> = {};
  let rest = over - incentiveCut;
  const years = Object.keys(el?.vacationByYear || {}).map(Number).filter((y) => electedVacation(el, y) > 0).sort((a, b) => a - b);
  const cut = (y: number, n: number) => {
    if (n <= 0) return;
    vacationByYear[y] = (vacationByYear[y] || 0) + n;
    balances[y] = balanceOf(y) - n;
    rest -= n;
  };
  // Earlier years first, each only as far as its balance can absorb (days
  // already used from it can't be taken back)...
  for (const y of years.slice(0, -1)) cut(y, Math.min(rest, electedVacation(el, y), Math.max(0, balanceOf(y))));
  // ...then the rest from the later year, and anything still left from
  // whichever years have elected days remaining (overdrawing them, which
  // blocks the claim).
  for (const y of [...years].reverse()) cut(y, Math.min(rest, electedVacation(el, y) - (vacationByYear[y] || 0)));

  const balanceAfter = balances[chargeYear];
  return {
    needsDay,
    chargeYear,
    extraAfter,
    electionCut: { incentive: incentiveCut, vacationByYear },
    balanceBefore,
    balanceAfter,
    balancesAfter: balances,
    canPost: !(needsDay && balanceBefore <= 0),
    canClaim: Object.values(balances).every((b) => b >= 0),
  };
}

// The schedule's settlement in today's shape, from data saved before charges
// were dated and elections split by year: each legacy per-schedule charge
// count becomes that many `legacy` charges dated on the schedule's start
// date, and each election's vacation days move to the start date's vacation
// year — so no year balance changes. Idempotent: data already in the new
// shape passes through.
export function migrateLegacySettlement(schedule: {
  startDate: string;
  vacationCharged?: Record<string, number>;
  vacationCharges?: VacationCharge[];
  extraElections?: Record<string, ExtraElection | { vacation: number; incentive: number }>;
}): { vacationCharges: VacationCharge[]; extraElections: Record<string, ExtraElection> } {
  const vacationCharges: VacationCharge[] = schedule.vacationCharges ? [...schedule.vacationCharges] : [];
  if (!schedule.vacationCharges) {
    for (const [userId, n] of Object.entries(schedule.vacationCharged || {})) {
      for (let i = 0; i < Math.round(Number(n) || 0); i++) vacationCharges.push({ userId, date: schedule.startDate, cause: 'legacy' });
    }
  }
  const year = vacationYearOf(schedule.startDate);
  const extraElections: Record<string, ExtraElection> = {};
  for (const [userId, e] of Object.entries(schedule.extraElections || {})) {
    if ('vacationByYear' in e) {
      extraElections[userId] = e;
    } else {
      const vacation = Number(e.vacation) || 0;
      extraElections[userId] = { vacationByYear: vacation ? { [year]: vacation } : {}, incentive: Number(e.incentive) || 0 };
    }
  }
  return { vacationCharges, extraElections };
}
