// Schedule generation: expands shift types into concrete slots over the date
// range, then fills them greedily with a repair pass for minimum-shift floors.
//
// Hard constraints:
//   - A user on vacation that day is never assigned.
//   - A user works at most one shift per day.
//   - At least REST_MINUTES between the end of one shift and the start of the
//     next (no "clopening").
// Soft goals (in priority order):
//   1. Every slot is filled.
//   2. Every employee reaches their personal minimum: the schedule's minimum
//      minus their vacation days inside the range.
//   3. "Preferred off" days are avoided when someone else can cover.
//   4. Employees who asked for more than the minimum get extra shifts before
//      employees who didn't ask.
//   5. Overnight shifts are spread evenly, and overall load is balanced by
//      weight (a shift's weight comes from its per-type setting; default 1).
//
// All dates are wall-clock dates at the scheduled location; the server is
// assumed to run in (or be configured for) that location's timezone.

import { holidayDatesInRange } from '../shared/holidays.js';
import {
  shiftWeight, isCountingShiftType, shiftMaximum, requiredShifts, shortfall, vacationCharged,
  vacationYearOf, vacationYearsOf, yearBalance, shortfallCharges,
} from '../shared/settlement.js';
import type {
  Assignment, Db, PreferenceStats, ScheduleDraft, ShiftType, Slot, TimeOff, User, VacationCharge,
} from '../shared/types.js';

const REST_MINUTES = 8 * 60;

// --- preference anti-gaming constants ---
// Claim strength of a preferred day demoted by the outlier cap: below the
// lowest possible standing (0.5) but above "no preference" (0).
export const DEMOTED_CLAIM = 0.25;
// Claim strength of a must-have-off day that was downgraded because the user
// requested more must-offs in the block than they have vacation days left:
// stronger than any normal preference (standings cap at 1.25), but soft —
// schedulable over when coverage truly requires it.
export const STRONG_CLAIM = 2.0;
const STANDING_MIN = 0.5;
const STANDING_MAX = 1.25;
const STANDING_BLEND = 0.3; // weight of the newest block in the moving average
const HISTORY_BLOCKS = 6; // how many past blocks feed a person's standing
const MEDIAN_FLOOR = 2; // asks at or below this are neutral even on a quiet roster

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// A Map whose `.get` is typed non-optional. These internal maps are always
// keyed by every employee before they're read, so threading `| undefined`
// (and `!`) through the scheduling arithmetic would be pure noise. `gmap`
// builds one; reads of an absent key still return undefined at runtime, which
// the algorithm never does.
type Get<V> = Omit<Map<string, V>, 'get'> & { get(key: string): V };
const gmap = <V>(entries: [string, V][] = []): Get<V> =>
  new Map<string, V>(entries) as unknown as Get<V>;

// Per-candidate run/recovery signals computed while filling one slot.
interface Sig {
  sticky: number;
  eligible: number;
  atCap: number;
  typeCnt: number;
  stCnt: number;
  lookahead: number;
  rec: number;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function ymdLocal(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function* eachDate(startDate: string, endDate: string): Generator<string> {
  const d = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (d <= end) {
    yield ymdLocal(d);
    d.setDate(d.getDate() + 1);
  }
}

function dayOfWeek(date: string) {
  return new Date(date + 'T00:00:00').getDay();
}

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
export function restOk(heldAssignments: Assignment[], shiftById: Record<string, ShiftType>, date: string, st: ShiftType): boolean {
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
  return ymdLocal(d);
}
function nextDay(date: string) {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return ymdLocal(d);
}

// --- shift "runs": keeping one person on a shift type several days running ---
// Grouping is active for a shift type only when the admin sets a run target
// (minRun > 1 or a finite maxRun); otherwise the scheduler behaves as before.
export function isGrouped(st: { minRun?: number; maxRun?: number | null }) {
  const min = Number(st?.minRun) || 1;
  const max = Number(st?.maxRun);
  return min > 1 || (Number.isFinite(max) && max > 0);
}
export function runBounds(st: { minRun?: number; maxRun?: number | null }) {
  const min = Math.max(1, Number(st?.minRun) || 1);
  const maxRaw = Number(st?.maxRun);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.max(min, maxRaw) : Infinity;
  return { min, max };
}

// Consecutive days the user worked `shiftTypeId` ending the day before `date`.
function runLengthBefore(byDate: Map<string, Assignment>, shiftTypeId: string, date: string) {
  let len = 0;
  let cur = prevDay(date);
  for (;;) {
    const a = byDate.get(cur);
    if (!a || a.shiftTypeId !== shiftTypeId) break;
    len++;
    cur = prevDay(cur);
  }
  return len;
}

// Consecutive days the user worked ANY overnight shift ending before `date`.
function overnightRunBefore(byDate: Map<string, Assignment>, shiftById: Record<string, ShiftType>, date: string) {
  let len = 0;
  let cur = prevDay(date);
  for (;;) {
    const a = byDate.get(cur);
    if (!a) break;
    const st = shiftById[a.shiftTypeId];
    if (!st || !isOvernight(st)) break;
    len++;
    cur = prevDay(cur);
  }
  return len;
}

// Recovery days owed after a stretch of consecutive worked days: a short run
// (2-4 days) earns 1 full day off, a long run (5+) earns 2. Soft — coverage
// still wins when nobody rested can take the slot.
export function recoveryNeed(streakLen: number) {
  if (streakLen >= 5) return 2;
  if (streakLen >= 2) return 1;
  return 0;
}

// Would assigning `st` on `date` keep the user within their personal
// consecutive-night cap (counting all overnight types together)? Exported for
// the manual-reassign endpoint.
export function nightCapOk(user: User, userAssignments: Assignment[], shiftById: Record<string, ShiftType>, date: string, st: ShiftType) {
  if (!isOvernight(st)) return true;
  const cap = Number(user.maxConsecutiveNights);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  const byDate = new Map(userAssignments.map((a) => [a.date, a]));
  return overnightRunBefore(byDate, shiftById, date) + 1 <= cap;
}

export function buildSlots(shiftTypes: ShiftType[], startDate: string, endDate: string): Slot[] {
  const slots: Slot[] = [];
  for (const date of eachDate(startDate, endDate)) {
    for (const st of shiftTypes) {
      const due =
        st.frequency === 'daily' ||
        (st.frequency === 'weekly' && dayOfWeek(date) === Number(st.dayOfWeek));
      if (!due) continue;
      const headcount = Math.max(1, Number(st.staffRequired) || 1);
      for (let i = 0; i < headcount; i++) {
        slots.push({ date, shiftTypeId: st.id });
      }
    }
  }
  return slots;
}

// Users the admin marked as schedulable for this block (older schedules
// without the field include everyone).
export function includedUsers(db: Db, schedule: { userIds?: string[] | null }): User[] {
  const ids = schedule.userIds;
  if (!Array.isArray(ids)) return db.users;
  return db.users.filter((u) => ids.includes(u.id));
}

function median(nums: number[]) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Preferred-day requests a user filed inside the block, in the order they
// originally requested them (timeOff array order = insertion order).
function prefsInRange(db: Db, userId: string, { startDate, endDate }: { startDate: string; endDate: string }) {
  return db.timeOff.filter(
    (t) =>
      t.userId === userId &&
      t.type === 'preferred' &&
      t.date >= startDate &&
      t.date <= endDate
  );
}

// Outlier cap for a block: per included user, threshold = everyone else's
// average + 4 × max(standard deviation, 1 day). Asks beyond the threshold are
// demoted (not voided). Also returns the raw ask snapshot stored on the
// schedule so long-term standing can be derived later.
export function computeCaps(db: Db, { startDate, endDate, userIds }: { startDate: string; endDate: string; userIds?: string[] | null }) {
  const users = includedUsers(db, { userIds });
  const range = { startDate, endDate };
  const asks: Record<string, number> = {};
  for (const u of users) asks[u.id] = prefsInRange(db, u.id, range).length;
  const med = median(Object.values(asks));

  const caps: Record<string, number> = {}; // userId -> how many of their asks keep full strength
  const warnings: string[] = [];
  if (users.length >= 2) {
    for (const u of users) {
      const others = users.filter((x) => x.id !== u.id).map((x) => asks[x.id]);
      const mean = others.reduce((a, b) => a + b, 0) / others.length;
      const sd = Math.sqrt(
        others.reduce((a, b) => a + (b - mean) ** 2, 0) / others.length
      );
      const threshold = mean + 4 * Math.max(sd, 1);
      if (asks[u.id] > threshold) {
        caps[u.id] = Math.floor(threshold);
        warnings.push(
          `${u.name} asked for ${asks[u.id]} preferred days (roster norm ${med}); the first ${caps[u.id]} kept full priority.`
        );
      }
    }
  }
  return { stats: { asks, median: med }, caps, warnings };
}

// How many standard deviations above the roster mean someone's preferred-off
// ask count must be before their preferred days become consumable for charge
// avoidance (a heavy asker's days may be pulled in a rescue chain; a modest
// asker's days stay protected). Tune here.
export const HEAVY_ASKER_STDDEV = 2;

// Mirrors computeCaps's exclude-self mean/sd (with the same SD floor of 1 day,
// so a quiet roster doesn't flag someone heavy over a 1-day difference), but
// against a lower threshold (k standard deviations, default 2 vs caps' 4) and
// returning a plain membership set rather than a per-user cap count.
export function heavyAskers(db: Db, { startDate, endDate, userIds }: { startDate: string; endDate: string; userIds?: string[] | null }, k: number = HEAVY_ASKER_STDDEV): Set<string> {
  const users = includedUsers(db, { userIds });
  const range = { startDate, endDate };
  const asks: Record<string, number> = {};
  for (const u of users) asks[u.id] = prefsInRange(db, u.id, range).length;

  const heavy = new Set<string>();
  if (users.length >= 2) {
    for (const u of users) {
      const others = users.filter((x) => x.id !== u.id).map((x) => asks[x.id]);
      const mean = others.reduce((a, b) => a + b, 0) / others.length;
      const sd = Math.sqrt(
        others.reduce((a, b) => a + (b - mean) ** 2, 0) / others.length
      );
      const threshold = mean + k * Math.max(sd, 1);
      if (asks[u.id] > threshold) heavy.add(u.id);
    }
  }
  return heavy;
}

// Long-term preference standing, derived on demand from the ask snapshots of
// past schedules (never stored as a running counter, so deleting or
// regenerating a schedule self-corrects). 1.0 is neutral; chronic over-askers
// sink toward 0.5, people who rarely ask drift up to 1.25.
export function preferenceStandings(db: { users: User[]; schedules?: { createdAt: string; preferenceStats?: PreferenceStats }[] }): Record<string, number> {
  const sorted = [...(db.schedules || [])]
    .filter((s) => s.preferenceStats)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: Record<string, number> = {};
  for (const u of db.users) {
    let standing = 1.0;
    const mine = sorted.filter((s) => u.id in s.preferenceStats!.asks).slice(-HISTORY_BLOCKS);
    for (const s of mine) {
      const ratio = clamp(
        s.preferenceStats!.asks[u.id] / Math.max(s.preferenceStats!.median, MEDIAN_FLOOR),
        0,
        3
      );
      const signal = 1.5 - ratio / 2;
      standing = clamp(
        (1 - STANDING_BLEND) * standing + STANDING_BLEND * signal,
        STANDING_MIN,
        STANDING_MAX
      );
    }
    out[u.id] = standing;
  }
  return out;
}

// Claim strength of each preferred day for scheduling: 0 = no preference,
// DEMOTED_CLAIM = over-cap excess, otherwise the user's standing. Higher
// claims are violated last.
export function preferenceClaims(db: Db, { startDate, endDate, userIds }: { startDate: string; endDate: string; userIds?: string[] | null }, caps: Record<string, number>, standings: Record<string, number>) {
  const claims = new Map<string, number>();
  for (const u of includedUsers(db, { userIds })) {
    const prefs = prefsInRange(db, u.id, { startDate, endDate });
    const cap = caps[u.id] ?? Infinity;
    prefs.forEach((t, i) => {
      claims.set(`${u.id}|${t.date}`, i < cap ? standings[u.id] : DEMOTED_CLAIM);
    });
  }
  return claims;
}

// True if the user has a start date and `date` is before it (not yet onboarded).
export function isBeforeStart(user: User, date: string): boolean {
  return !!user.startDate && date < user.startDate;
}

// True if `date` falls inside any of the user's admin-set away ranges
// (inclusive). Away time blocks scheduling but never costs vacation.
export function isAway(db: Db, userId: string, date: string): boolean {
  return db.awayTime.some((a) => a.userId === userId && a.start <= date && date <= a.end);
}

// True if the user holds a role allowed to fill this shift type. A shift with
// no allowedRoles (empty/absent) is open to everyone.
export function hasRequiredRole(user: User, st: { allowedRoles?: string[] }): boolean {
  if (!st.allowedRoles || st.allowedRoles.length === 0) return true;
  const roles = user.roles || [];
  return st.allowedRoles.some((r) => roles.includes(r));
}

// Must-have-off entries a user filed inside the block.
export function mustOffInRange(db: Db, userId: string, { startDate, endDate }: { startDate: string; endDate: string }) {
  return db.timeOff.filter(
    (t) =>
      t.userId === userId &&
      t.type === 'vacation' &&
      t.date >= startDate &&
      t.date <= endDate
  );
}

// Per-user minimum for this block, for scheduler-internal pressure: the
// per-user required shifts reduced by hard must-off days inside the range.
// Users in `softOff` had their must-offs downgraded to soft claims, so theirs
// don't reduce anything — they might still work those days.
export function effectiveMinimums(db: Db, { startDate, endDate }: { startDate: string; endDate: string }, softOff: Set<string> = new Set()): Map<string, number> {
  const mins = new Map<string, number>();
  for (const u of db.users) {
    const offDays = softOff.has(u.id)
      ? 0
      : mustOffInRange(db, u.id, { startDate, endDate }).length;
    mins.set(u.id, Math.max(0, (Number(u.requiredShifts) || 0) - offDays));
  }
  return mins;
}

// Per-user shift ceiling: the per-employee maxShiftsOverride if set, else
// unlimited. (An override of 0/blank means "no override", not "no shifts" —
// exclude someone from the block for that.)
export function effectiveMaximums(db: Db): Map<string, number> {
  const maxs = new Map<string, number>();
  for (const u of db.users) maxs.set(u.id, shiftMaximum(u));
  return maxs;
}

// Recomputes counts and warnings from a schedule's current assignments. Used
// after generation and after manual reassignments.
export function summarizeSchedule(db: Db, schedule: ScheduleDraft) {
  const preferred = new Set(
    db.timeOff.filter((t) => t.type === 'preferred').map((t) => `${t.userId}|${t.date}`)
  );
  const stById: Record<string, ShiftType> = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
  const counts: Record<string, number> = Object.fromEntries(db.users.map((u) => [u.id, 0]));
  for (const a of schedule.assignments) {
    const st = stById[a.shiftTypeId];
    if (a.userId in counts && isCountingShiftType(st)) counts[a.userId]++;
  }

  const warnings: string[] = [];
  for (const slot of schedule.unfilled) {
    const st = db.shiftTypes.find((s) => s.id === slot.shiftTypeId);
    warnings.push(
      `Open shift: ${st ? st.name : slot.shiftTypeId} on ${slot.date} — no one available. Consider outside help or reassigning.`
    );
  }
  for (const u of includedUsers(db, schedule)) {
    // A shift ceiling below someone's minimum lowers their minimum — the cap
    // is a hard rule, so don't warn about a floor they aren't allowed to reach.
    // Vacation days charged for this schedule cover shortfall; warn only on
    // the uncovered remainder.
    const required = requiredShifts(u);
    const charge = vacationCharged(schedule, u.id);
    const residual = shortfall(db, schedule, u) - charge;
    if (residual > 0) {
      const covered = charge > 0 ? `, ${charge} covered by vacation day${charge === 1 ? '' : 's'}` : '';
      warnings.push(
        `${u.name} has ${counts[u.id] || 0} of ${required} minimum shifts${covered} — ${residual} short.`
      );
    }
    // Charge diagnostics: how much of a charge was structurally unavoidable
    // (not enough schedulable days at all to reach the requirement) versus
    // unresolved for other reasons (most notably, protected preferred-off
    // days the generator wouldn't override). This doesn't affect the charge
    // itself — the charges are untouched — it only explains it. Uses raw
    // must-off entries (summarizeSchedule has no softOff context to know
    // which were downgraded this block), which is an approximation.
    if (charge > 0) {
      const offDates = new Set(
        mustOffInRange(db, u.id, { startDate: schedule.startDate, endDate: schedule.endDate }).map((t) => t.date)
      );
      let schedulableDays = 0;
      for (const d of eachDate(schedule.startDate, schedule.endDate)) {
        if (offDates.has(d)) continue;
        if (isAway(db, u.id, d)) continue;
        if (isBeforeStart(u, d)) continue;
        schedulableDays++;
      }
      const unavoidable = clamp(required - schedulableDays, 0, charge);
      const unresolved = charge - unavoidable;
      if (unavoidable > 0 || unresolved > 0) {
        const parts: string[] = [];
        if (unavoidable > 0) {
          parts.push(
            `${unavoidable} unavoidable (only ${schedulableDays} schedulable day${schedulableDays === 1 ? '' : 's'} for ${required} required)`
          );
        }
        if (unresolved > 0) {
          parts.push(`${unresolved} unresolvable without overriding protected preferred days`);
        }
        warnings.push(
          `${u.name} charged ${charge} vacation day${charge === 1 ? '' : 's'}: ${parts.join(', ')}.`
        );
      }
    }
  }
  for (const a of schedule.assignments) {
    if (preferred.has(`${a.userId}|${a.date}`)) {
      const u = db.users.find((x) => x.id === a.userId);
      warnings.push(`${u ? u.name : a.userId} was scheduled on ${a.date} despite preferring it off.`);
    }
  }
  // Quality-of-life: flag returns that cut into post-stretch recovery days
  // (1 day off owed after a 2-4 day stretch, 2 days after 5+). Soft — these
  // happen when coverage left no rested alternative.
  const datesByUser: Record<string, string[]> = {};
  for (const a of schedule.assignments) (datesByUser[a.userId] ||= []).push(a.date);
  const dayDiff = (a: string, b: string) =>
    Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000);
  for (const [uid, dates] of Object.entries(datesByUser)) {
    const u = db.users.find((x) => x.id === uid);
    if (!u) continue;
    dates.sort();
    // collapse into stretches of consecutive days
    const stretches: { start: string; end: string; len: number }[] = [];
    let start = dates[0], prev = dates[0];
    for (const d of dates.slice(1)) {
      if (dayDiff(prev, d) === 1) { prev = d; continue; }
      stretches.push({ start, end: prev, len: dayDiff(start, prev) + 1 });
      start = prev = d;
    }
    stretches.push({ start, end: prev, len: dayDiff(start, prev) + 1 });
    for (let i = 1; i < stretches.length; i++) {
      const rest = dayDiff(stretches[i - 1].end, stretches[i].start) - 1;
      const need = recoveryNeed(stretches[i - 1].len);
      if (rest < need) {
        warnings.push(
          `${u.name} returns on ${stretches[i].start} with only ${rest} day${rest === 1 ? '' : 's'} off after a ${stretches[i - 1].len}-day stretch (ideally ${need}).`
        );
      }
    }
  }
  warnings.push(...computeCaps(db, schedule).warnings);
  return { counts, warnings };
}

export function generateSchedule(db: Db, { startDate, endDate, userIds }: { startDate: string; endDate: string; userIds?: string[] }) {
  const employees = includedUsers(db, { userIds });
  const shiftById = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
  // Non-workable holidays mean the org is closed: no shifts that day. Holidays
  // recur, so resolve each rule to concrete dates within the run's range.
  const closedHolidays = new Set(
    holidayDatesInRange((db.holidays || []).filter((h) => !h.workable), startDate, endDate).map((o) => o.date)
  );
  const slots = buildSlots(db.shiftTypes, startDate, endDate).filter((s) => !closedHolidays.has(s.date));

  // Slots are processed one day at a time; the order *within* each day is
  // decided per-day, by run urgency, just before that day is filled (see the
  // greedy pass). A static order would let types at the top of the list poach
  // the run-holders of types further down.
  const slotsByDate = gmap<Slot[]>();
  for (const slot of slots) {
    if (!slotsByDate.has(slot.date)) slotsByDate.set(slot.date, []);
    slotsByDate.get(slot.date).push(slot);
  }
  const typeIndex: Record<string, number> = Object.fromEntries(db.shiftTypes.map((s, i) => [s.id, i]));

  // Affordability check, per vacation year: someone whose must-off days in
  // this block falling in one vacation year outnumber that year's balance
  // gets ALL their must-offs in the block downgraded to soft "strongly prefer
  // off" claims — honored when possible, schedulable over when coverage
  // requires it.
  // Holiday fairness counts per calendar year; vacation per vacation year.
  const blockYear = Number(startDate.slice(0, 4));
  const blockYears = vacationYearsOf({ startDate, endDate });
  // Year balances (floored) before this block, per person per vacation year.
  const balances = gmap<Map<number, number>>(
    employees.map((u) => [u.id, new Map(blockYears.map((y) => [y, Math.max(0, yearBalance(db, u, y).balance)]))])
  );
  const yearBalanceOf = (uid: string) => (year: number) => balances.get(uid).get(year) ?? 0;
  const range = { startDate, endDate, userIds };
  const mustOffDates = gmap<string[]>(employees.map((u) => [u.id, mustOffInRange(db, u.id, range).map((t) => t.date)]));
  const softOff = new Set(
    employees
      .filter((u) =>
        blockYears.some(
          (y) => mustOffDates.get(u.id).filter((d) => vacationYearOf(d) === y).length > yearBalanceOf(u.id)(y)
        )
      )
      .map((u) => u.id)
  );

  const vacation = new Set(
    db.timeOff
      .filter((t) => t.type === 'vacation' && !softOff.has(t.userId))
      .map((t) => `${t.userId}|${t.date}`)
  );

  // Preference claims: outlier caps for this block plus standing earned from
  // past blocks (db.schedules holds only prior schedules at this point).
  const { stats, caps } = computeCaps(db, range);
  const standings = preferenceStandings(db);
  const claims = preferenceClaims(db, range, caps, standings);
  for (const uid of softOff) {
    for (const t of mustOffInRange(db, uid, range)) {
      claims.set(`${uid}|${t.date}`, STRONG_CLAIM);
    }
  }
  const claimOf = (userId: string, date: string) => claims.get(`${userId}|${date}`) ?? 0;

  const effMin = effectiveMinimums(db, { startDate, endDate }, softOff) as unknown as Get<number>;
  const effMax = effectiveMaximums(db) as unknown as Get<number>;
  // A ceiling below the floor wins: the cap is hard, the minimum is a goal.
  for (const u of employees) {
    effMin.set(u.id, Math.min(effMin.get(u.id), effMax.get(u.id)));
  }
  // Target = required shifts (already clamped to the ceiling above).
  const target = gmap<number>(employees.map((u) => [u.id, effMin.get(u.id)]));

  // Holiday fairness (soft): only WORKABLE holidays are schedulable/counted.
  // `holWorked` is a live counter — seeded from prior schedules in this calendar
  // year, then kept current by give()/take() so the second holiday in a run goes
  // to someone who hasn't worked one yet.
  // Resolve workable holidays across the whole block year (so prior-schedule
  // seeding sees them) plus any cross-year tail of this run.
  const holYearEnd = endDate > `${blockYear}-12-31` ? endDate : `${blockYear}-12-31`;
  const holidayDates = new Set(
    holidayDatesInRange((db.holidays || []).filter((h) => h.workable), `${blockYear}-01-01`, holYearEnd).map((o) => o.date)
  );
  const reqHolidays = Math.max(0, Number(db.settings.holidaysRequiredPerYear) || 0);
  const holWorked = gmap<number>(employees.map((u) => [u.id, 0]));
  for (const s of db.schedules || []) {
    if (!s.startDate?.startsWith(String(blockYear))) continue;
    for (const a of s.assignments || []) {
      if (holidayDates.has(a.date) && holWorked.has(a.userId))
        holWorked.set(a.userId, holWorked.get(a.userId) + 1);
    }
  }

  const counts = gmap<number>(employees.map((u) => [u.id, 0]));
  const loads = gmap<number>(employees.map((u) => [u.id, 0])); // weighted
  const overnights = gmap<number>(employees.map((u) => [u.id, 0]));
  const held = gmap<Assignment[]>(employees.map((u) => [u.id, []])); // assignments per user
  const heldByDate = gmap<Get<Assignment>>(employees.map((u) => [u.id, gmap<Assignment>()])); // date -> assignment
  const typeCount = gmap<Map<string, number>>(employees.map((u) => [u.id, new Map()])); // shiftTypeId -> n
  const workingDay = new Set<string>(); // `${userId}|${date}` — one shift per person per day
  const assignments: Assignment[] = [];
  const unfilled: Slot[] = [];

  // Personal consecutive-night cap (all overnight types counted together).
  const nightCapOkLocal = (u: User, date: string, st: ShiftType) => {
    if (!isOvernight(st)) return true;
    const cap = Number(u.maxConsecutiveNights);
    if (!Number.isFinite(cap) || cap <= 0) return true;
    return overnightRunBefore(heldByDate.get(u.id), shiftById, date) + 1 <= cap;
  };

  const available = (u: User, date: string, st: ShiftType) =>
    // The shift maximum only gates counting shifts; weight-0 standby duty is
    // always assignable capacity-wise.
    (shiftWeight(st) === 0 || counts.get(u.id) < effMax.get(u.id)) &&
    !vacation.has(`${u.id}|${date}`) &&
    !isBeforeStart(u, date) &&
    !isAway(db, u.id, date) &&
    hasRequiredRole(u, st) &&
    !workingDay.has(`${u.id}|${date}`) &&
    restOk(held.get(u.id), shiftById, date, st) &&
    nightCapOkLocal(u, date, st);

  const give = (a: Assignment, u: User) => {
    a.userId = u.id;
    const st = shiftById[a.shiftTypeId];
    const w = shiftWeight(st);
    if (w > 0) counts.set(u.id, counts.get(u.id) + 1); // weight 0 doesn't count
    loads.set(u.id, loads.get(u.id) + w);
    if (isOvernight(st)) overnights.set(u.id, overnights.get(u.id) + 1);
    held.get(u.id).push(a);
    heldByDate.get(u.id).set(a.date, a);
    const tc = typeCount.get(u.id);
    tc.set(a.shiftTypeId, (tc.get(a.shiftTypeId) || 0) + 1);
    workingDay.add(`${u.id}|${a.date}`);
    if (holidayDates.has(a.date)) holWorked.set(u.id, holWorked.get(u.id) + 1);
  };

  const take = (a: Assignment) => {
    const u = a.userId;
    const st = shiftById[a.shiftTypeId];
    const w = shiftWeight(st);
    if (w > 0) counts.set(u, counts.get(u) - 1);
    loads.set(u, loads.get(u) - w);
    if (isOvernight(st)) overnights.set(u, overnights.get(u) - 1);
    held.set(u, held.get(u).filter((x) => x !== a));
    heldByDate.get(u).delete(a.date);
    const tc = typeCount.get(u);
    tc.set(a.shiftTypeId, (tc.get(a.shiftTypeId) || 0) - 1);
    workingDay.delete(`${u}|${a.date}`);
    if (holidayDates.has(a.date)) holWorked.set(u, holWorked.get(u) - 1);
  };

  // --- Charge-risk model -----------------------------------------------
  // Predicts vacation charges as generation proceeds, so the greedy fill and
  // repair pass can steer toward AVOIDABLE-charge-free outcomes without
  // touching the settlement itself (below) — predictedCharge and the final
  // settle step both call settlement's vacationCharge, so "predicted" and
  // "actual" never disagree.
  const employeeById = gmap<User>(employees.map((u) => [u.id, u]));
  const heavy = heavyAskers(db, range);
  const mustOffCount = gmap<number>(employees.map((u) => [u.id, mustOffDates.get(u.id).length]));
  // Whether a person has any vacation left in a year one of their must-off
  // days falls in — i.e. whether a shortfall could charge them at all.
  const canBeCharged = gmap<boolean>(employees.map((u) => [
    u.id, mustOffDates.get(u.id).some((d) => yearBalanceOf(u.id)(vacationYearOf(d)) > 0),
  ]));
  const fullRequired = gmap<number>(employees.map((u) => [u.id, requiredShifts(u)]));

  // Live: reads current `counts`, so it tracks the schedule as it fills in.
  const predictedCharge = (uid: string) =>
    shortfallCharges({
      required: fullRequired.get(uid),
      counting: counts.get(uid),
      mustOffDates: mustOffDates.get(uid),
      yearBalance: yearBalanceOf(uid),
    }).length;
  const atRiskNow = (uid: string) =>
    mustOffCount.get(uid) > 0 && canBeCharged.get(uid) && counts.get(uid) < fullRequired.get(uid);

  // Date-level approximation of "could this person legally work something
  // between fromDate and the end of the block" — the coarse hard gates that
  // are cheap to check per day (a tighter per-slot check would need to
  // enumerate every slot on every remaining date, which is unaffordable
  // inside a sort comparator). None of the inputs (vacation/away/start/slot
  // presence) change once generation starts, so precompute a per-user suffix
  // count over the block's dates once — an O(days) walk per user instead of
  // an O(days) walk per (candidate, slot) comparison, which is what made this
  // quadratic-ish (many slots share the same calendar date) before.
  const blockDates = [...eachDate(startDate, endDate)];
  const blockDateIndex = new Map<string, number>(blockDates.map((d, i) => [d, i]));
  const schedulableSuffix = gmap<Int32Array>(
    employees.map((u): [string, Int32Array] => {
      const arr = new Int32Array(blockDates.length + 1);
      for (let i = blockDates.length - 1; i >= 0; i--) {
        const d = blockDates[i];
        const ok =
          !vacation.has(`${u.id}|${d}`) &&
          !isAway(db, u.id, d) &&
          !isBeforeStart(u, d) &&
          slotsByDate.has(d);
        arr[i] = arr[i + 1] + (ok ? 1 : 0);
      }
      return [u.id, arr];
    })
  );
  const schedulableRemaining = (uid: string, fromDate: string) => {
    const idx = blockDateIndex.get(fromDate);
    return idx === undefined ? 0 : schedulableSuffix.get(uid)[idx];
  };
  // Floored at 0: once someone's own minimum is already mathematically out of
  // reach (negative raw slack), further deepening that deficit doesn't make
  // today's shift any more "theirs" to claim — it would just take a slot away
  // from someone who could still make their own number, without changing the
  // already-lost person's outcome (their shortfall is capped by settlement
  // regardless of which specific days they missed). Flooring lets "tighter
  // first" mean "most urgent among those who can still be saved," rather than
  // "most hopeless wins."
  const slack = (uid: string, date: string) =>
    Math.max(0, schedulableRemaining(uid, date) - Math.max(0, effMin.get(uid) - counts.get(uid)));

  // A person's own predicted charge outranks their own preference — never
  // anyone else's. Used ONLY in the greedy comparator's tier-1 claim check;
  // `claimOf` itself (donation sorting, softOff strong claims, etc.) is
  // untouched.
  const effectiveClaim = (uid: string, date: string) => {
    const c = claimOf(uid, date);
    if (c > 0 && atRiskNow(uid) && predictedCharge(uid) > 0) return 0;
    return c;
  };

  // Is there a preferred-off day for this user within the next `span` days
  // (used so a new run isn't started on someone about to want time off)?
  const hasPrefSoon = (uid: string, date: string, span: number) => {
    let cur = date;
    for (let i = 0; i < span; i++) {
      if (claimOf(uid, cur) > 0) return true;
      cur = nextDay(cur);
    }
    return false;
  };

  // 1 when assigning `st` on `date` would cut into the recovery days owed for
  // the user's most recent stretch of consecutive worked days; 0 otherwise.
  // Continuing the same shift type with no gap is a run continuation, governed
  // by the run caps — not a return from rest.
  const recoveryPenalty = (u: User, date: string, st: ShiftType) => {
    const byDate = heldByDate.get(u.id);
    let gap = 0;
    let cursor = prevDay(date);
    while (cursor >= startDate && !byDate.has(cursor)) {
      gap++;
      cursor = prevDay(cursor);
    }
    if (!byDate.has(cursor)) return 0; // hasn't worked yet this block
    if (gap === 0 && byDate.get(cursor).shiftTypeId === st.id) return 0;
    let streak = 0;
    while (cursor >= startDate && byDate.has(cursor)) {
      streak++;
      cursor = prevDay(cursor);
    }
    return gap < recoveryNeed(streak) ? 1 : 0;
  };

  // Greedy pass. The rotation cursor persists across schedule generations
  // (db.meta.rotationCursor) so exact ties don't favor the same people in
  // every block.
  let rotation = db.meta?.rotationCursor || 0;
  const fillSlot = (slot: Slot) => {
    const st = shiftById[slot.shiftTypeId];
    const candidates = employees.filter((u) => available(u, slot.date, st));
    if (candidates.length === 0) {
      unfilled.push(slot);
      return;
    }
    const slotOvernight = isOvernight(st);
    const grouped = isGrouped(st);
    // Weight-0 (standby) slots invert the need-based tiers: people who still
    // need counting shifts are *reserved* (standby would burn their day), and
    // standby duty rotates by who has done it least.
    const slotCounts = shiftWeight(st) > 0;
    const needDir = slotCounts ? 1 : -1;
    const { min: minRun, max: maxRun } = runBounds(st);
    // Per-candidate run signals. `sticky` = mid-run below the target (continue
    // hard), `eligible` = within the target band (continue unless someone is
    // under their minimum), `atCap` = at the max run (rotate off). `typeCnt`
    // and `lookahead` drive who *starts* a new run: spread the type across the
    // team, and avoid starting on someone who wants time off soon.
    const sig = gmap<Sig>(
      candidates.map((u): [string, Sig] => {
        const r = grouped ? runLengthBefore(heldByDate.get(u.id), st.id, slot.date) : 0;
        return [u.id, {
          sticky: grouped && r >= 1 && r < minRun ? 0 : 1,
          eligible: grouped && r >= minRun && r < maxRun ? 0 : 1,
          atCap: grouped && r >= maxRun ? 1 : 0,
          typeCnt: grouped ? typeCount.get(u.id).get(st.id) || 0 : 0,
          stCnt: slotCounts ? 0 : typeCount.get(u.id).get(st.id) || 0,
          lookahead: grouped && r === 0 && hasPrefSoon(u.id, slot.date, minRun) ? 1 : 0,
          rec: recoveryPenalty(u, slot.date, st),
        }];
      })
    );
    // Charge-risk slack, precomputed per candidate (once per slot, like
    // `sig` above) rather than inside the comparator — schedulableRemaining
    // walks the remaining dates, so computing it per-comparison would be
    // quadratic in candidate count.
    const slackOf = gmap<number>(candidates.map((u) => [u.id, slack(u.id, slot.date)]));
    candidates.sort((a, b) => {
      const A = sig.get(a.id), B = sig.get(b.id);
      // A person's own predicted vacation charge outranks their own
      // preference (effectiveClaim zeroes their claim in that case only) —
      // this never affects anyone else's claim.
      const claimA = effectiveClaim(a.id, slot.date);
      const claimB = effectiveClaim(b.id, slot.date);
      if (claimA !== claimB) return claimA - claimB;
      // Holiday fairness (only on workable-holiday dates, so normal days are
      // unaffected): those who still owe their required count first, then the
      // fewest holidays worked this year.
      if (holidayDates.has(slot.date)) {
        const belowA = holWorked.get(a.id) < reqHolidays ? 0 : 1;
        const belowB = holWorked.get(b.id) < reqHolidays ? 0 : 1;
        if (belowA !== belowB) return belowA - belowB;
        if (holWorked.get(a.id) !== holWorked.get(b.id))
          return holWorked.get(a.id) - holWorked.get(b.id);
      }
      if (A.sticky !== B.sticky) return A.sticky - B.sticky;
      const underMinA = counts.get(a.id) < effMin.get(a.id) ? 0 : 1;
      const underMinB = counts.get(b.id) < effMin.get(b.id) ? 0 : 1;
      if (underMinA !== underMinB) return (underMinA - underMinB) * needDir;
      // Charge-avoidance tiebreak: whoever has the least slack toward their
      // own minimum (tightest remaining runway) goes first — ties fall
      // through to the tiers below, rotation remains the final decider.
      const slackDiff = slackOf.get(a.id) - slackOf.get(b.id);
      if (slackDiff !== 0) return slackDiff;
      if (A.eligible !== B.eligible) return A.eligible - B.eligible;
      if (A.atCap !== B.atCap) return A.atCap - B.atCap;
      // Rested people before early returns: recovery outranks the desire for
      // extra shifts, but never minimums or the run caps above.
      if (A.rec !== B.rec) return A.rec - B.rec;
      if (A.typeCnt !== B.typeCnt) return A.typeCnt - B.typeCnt;
      if (A.lookahead !== B.lookahead) return A.lookahead - B.lookahead;
      const underTgtA = counts.get(a.id) < target.get(a.id) ? 0 : 1;
      const underTgtB = counts.get(b.id) < target.get(b.id) ? 0 : 1;
      if (underTgtA !== underTgtB) return (underTgtA - underTgtB) * needDir;
      if (A.stCnt !== B.stCnt) return A.stCnt - B.stCnt; // rotate standby duty
      if (slotOvernight && overnights.get(a.id) !== overnights.get(b.id))
        return overnights.get(a.id) - overnights.get(b.id);
      if (slotCounts && loads.get(a.id) !== loads.get(b.id))
        return loads.get(a.id) - loads.get(b.id);
      const ia = (employees.indexOf(a) + rotation) % employees.length;
      const ib = (employees.indexOf(b) + rotation) % employees.length;
      return ia - ib;
    });
    const a: Assignment = { date: slot.date, shiftTypeId: slot.shiftTypeId, userId: '' };
    give(a, candidates[0]);
    assignments.push(a);
    rotation++;
  };

  // Process day by day. Each day's slots are ordered by run urgency, computed
  // from the state at the start of that day: active runs still below their
  // minimum go first, then active runs inside the band, then new-run starts,
  // then ungrouped types. A run continuation therefore always claims its
  // holder before any other type can poach them. Ties within a class rotate
  // daily so list position never decides who goes first long-term.
  const nTypes = Math.max(1, db.shiftTypes.length);
  const dayIndexOf = (date: string) =>
    Math.round((new Date(date + 'T00:00:00').getTime() - new Date(startDate + 'T00:00:00').getTime()) / 86400000);
  for (const [date, daySlots] of slotsByDate) {
    const urgency: Record<string, number> = {};
    for (const t of db.shiftTypes) {
      if (!isGrouped(t)) { urgency[t.id] = 3; continue; }
      const { min, max } = runBounds(t);
      let best = 2; // no continuable run -> a new run starts today
      for (const u of employees) {
        const r = runLengthBefore(heldByDate.get(u.id), t.id, date);
        if (r >= 1 && r < max && available(u, date, t)) {
          best = Math.min(best, r < min ? 0 : 1);
          if (best === 0) break;
        }
      }
      urgency[t.id] = best;
    }
    const dayRot = dayIndexOf(date);
    daySlots.sort((a, b) => {
      if (urgency[a.shiftTypeId] !== urgency[b.shiftTypeId])
        return urgency[a.shiftTypeId] - urgency[b.shiftTypeId];
      const ia = (typeIndex[a.shiftTypeId] + dayRot) % nTypes;
      const ib = (typeIndex[b.shiftTypeId] + dayRot) % nTypes;
      return ia - ib;
    });
    for (const slot of daySlots) fillSlot(slot);
  }

  // A shift sits at a run boundary (first/last day) unless the donor works the
  // same type on both neighboring days. Pulling from a boundary disturbs a run
  // least; non-grouped types are always "boundaries" (neutral).
  const atRunBoundary = (a: Assignment) => {
    const st = shiftById[a.shiftTypeId];
    if (!isGrouped(st)) return true;
    const byDate = heldByDate.get(a.userId);
    const sameType = (d: string) => byDate.get(d)?.shiftTypeId === a.shiftTypeId;
    return !(sameType(prevDay(a.date)) && sameType(nextDay(a.date)));
  };

  // Repair pass: pull shifts from users over their own minimum and hand them
  // to users under theirs, when the receiver can legally take the shift.
  // Prefer takeovers that avoid the receiver's preferred-off days and that pull
  // from a run boundary rather than splitting a run mid-stream.
  //
  // Two charge-avoidance extensions on top of the original single-hop pass:
  //  - Receivers are processed in charge-urgency order first (biggest
  //    predicted vacation charge, tie-broken by standing, then original
  //    order), THEN the remaining under-effMin users in their original order
  //    — so a transfer that can prevent a charge gets first crack at a shift.
  //  - When the single-hop transfer can't close a charge-at-risk receiver's
  //    gap, a bounded (depth <= 3, fan-out <= 8) rescue chain is tried: pull
  //    from a donor whose day isn't a protected (modest-asker) preference,
  //    recursively finding THAT donor a replacement so nobody is left below
  //    their own fullRequired without one.
  const trySingleHop = (u: User) => {
    const donatable = assignments
      .filter(
        (a) =>
          a.userId !== u.id &&
          // Moving a weight-0 (standby) shift can't raise anyone's count.
          shiftWeight(shiftById[a.shiftTypeId]) > 0 &&
          counts.get(a.userId) > effMin.get(a.userId) &&
          available(u, a.date, shiftById[a.shiftTypeId])
      )
      .sort((a, b) => {
        const claimA = claimOf(u.id, a.date);
        const claimB = claimOf(u.id, b.date);
        if (claimA !== claimB) return claimA - claimB;
        const recA = recoveryPenalty(u, a.date, shiftById[a.shiftTypeId]);
        const recB = recoveryPenalty(u, b.date, shiftById[b.shiftTypeId]);
        if (recA !== recB) return recA - recB;
        const boundA = atRunBoundary(a) ? 0 : 1;
        const boundB = atRunBoundary(b) ? 0 : 1;
        if (boundA !== boundB) return boundA - boundB;
        return loads.get(b.userId) - loads.get(a.userId);
      });
    if (donatable.length === 0) return false;
    const a = donatable[0];
    take(a);
    give(a, u);
    return true;
  };

  // A donor's day is protected — never taken as part of someone else's rescue
  // — when it's a genuine, full-strength preferred-off day from someone who
  // isn't a heavy asker. Demoted excess days (DEMOTED_CLAIM) and heavy
  // askers' days are consumable.
  const isProtected = (donorId: string, date: string) => {
    const c = claimOf(donorId, date);
    return c > 0 && c !== DEMOTED_CLAIM && !heavy.has(donorId);
  };

  const totalPredictedCharge = () => {
    let sum = 0;
    for (const u of employees) sum += predictedCharge(u.id);
    return sum;
  };

  // Attempts to hand `p` one more counting shift by pulling it from another
  // holder (and, if that leaves the donor short of their own fullRequired,
  // finding the donor a replacement in turn — recursively, up to depth 3).
  // Every move is applied immediately via take/give so nested checks see the
  // post-move state; a branch that dead-ends rolls its own moves back before
  // trying the next candidate.
  // Depth (<=3) and fan-out (<=8) bound the cost of any ONE tryRescue call,
  // but not the total across every at-risk employee and every rescue round —
  // in a heavily oversubscribed block (many people simultaneously short),
  // that product can still be large. A shared work budget across the whole
  // rescue phase caps the aggregate cost outright: once exhausted, further
  // rescue attempts simply decline (the existing single-hop pass and
  // settlement's charge accounting still apply — this only gives up on
  // *additional* charge-avoidance search, never on correctness).
  let rescueBudget = 1200;
  const tryRescue = (p: User, depth: number, visited: Set<string>): boolean => {
    if (depth > 3 || rescueBudget-- <= 0) return false;
    // Protected days (a modest asker's genuine preferred-off day, worked
    // anyway) are never eligible at all — not merely deprioritized — per the
    // "may NEVER be taken" rule. Everything else sorts run-boundary first,
    // then donor load DESC.
    //
    // Cheap checks (identity/weight/visited/protection) and the sort run over
    // the full assignment list first; `available` — which walks rest-rule
    // math per candidate — only runs against the already-best-ordered
    // prefix, stopping as soon as the fan-out cap is filled. Checking
    // `available` before slicing (the naive order) would pay its cost for
    // every assignment in the schedule at every recursion node, which is
    // what made this quadratic-ish in practice.
    const ranked = assignments
      .filter(
        (a) =>
          a.userId !== p.id &&
          shiftWeight(shiftById[a.shiftTypeId]) > 0 &&
          !visited.has(`${a.date}|${a.shiftTypeId}`) &&
          !isProtected(a.userId, a.date)
      )
      .sort((a, b) => {
        const boundA = atRunBoundary(a) ? 0 : 1;
        const boundB = atRunBoundary(b) ? 0 : 1;
        if (boundA !== boundB) return boundA - boundB;
        return loads.get(b.userId) - loads.get(a.userId);
      });
    const candidates: Assignment[] = [];
    for (const a of ranked) {
      if (available(p, a.date, shiftById[a.shiftTypeId])) {
        candidates.push(a);
        if (candidates.length >= 8) break; // cap fan-out
      }
    }

    for (const s of candidates) {
      const donorId = s.userId;
      const donor = employeeById.get(donorId);
      const slotKey = `${s.date}|${s.shiftTypeId}`;

      visited.add(slotKey);
      take(s);
      give(s, p);

      // Allowed outright when the donor is left whole (still at/above their
      // own fullRequired — the hard rule that a donor is never left below it
      // without a replacement). This condition also guarantees no NEW
      // predictedCharge for the donor, since predictedCharge is necessarily
      // 0 once counts >= fullRequired.
      if (counts.get(donorId) >= fullRequired.get(donorId)) {
        return true;
      }

      // Donor is left short: find them a replacement — an open slot they can
      // take, or (recursively) a shift of their own to pull from someone else.
      const unfilledIdx = unfilled.findIndex((sl) => available(donor, sl.date, shiftById[sl.shiftTypeId]));
      if (unfilledIdx !== -1) {
        const sl = unfilled[unfilledIdx];
        const na: Assignment = { date: sl.date, shiftTypeId: sl.shiftTypeId, userId: '' };
        give(na, donor);
        assignments.push(na);
        unfilled.splice(unfilledIdx, 1);
        return true;
      }
      if (tryRescue(donor, depth + 1, visited)) return true;

      // Dead end down this branch: roll back and try the next candidate.
      take(s);
      give(s, donor);
      visited.delete(slotKey);
    }
    return false;
  };

  // Single-hop fixpoint: converges quickly on its own (each pass either moves
  // at least one shift toward someone's effMin or does nothing, so it's
  // bounded by the number of such moves possible). Charge-urgency order
  // (biggest predicted charge first, then standing DESC, then original order)
  // decides who gets first crack within each pass — same shape as the
  // under-effMin loop this replaces, just reordered.
  const runSingleHopFixpoint = () => {
    let progressed = false;
    let localChanged = true;
    while (localChanged) {
      localChanged = false;
      const chargeSnapshot = gmap<number>(employees.map((u) => [u.id, predictedCharge(u.id)]));
      const atRisk = employees.filter((u) => chargeSnapshot.get(u.id) > 0);
      atRisk.sort((a, b) => {
        const byCharge = chargeSnapshot.get(b.id) - chargeSnapshot.get(a.id);
        if (byCharge !== 0) return byCharge;
        return (standings[b.id] ?? 1) - (standings[a.id] ?? 1);
      });
      const atRiskIds = new Set(atRisk.map((u) => u.id));
      const rest = employees.filter((u) => !atRiskIds.has(u.id) && counts.get(u.id) < effMin.get(u.id));
      for (const u of [...atRisk, ...rest]) {
        if (counts.get(u.id) < effMin.get(u.id) && trySingleHop(u)) {
          localChanged = true;
          progressed = true;
        }
      }
    }
    return progressed;
  };

  runSingleHopFixpoint();

  // Rescue chains are tried in bounded sweeps AFTER single-hop has already
  // converged, rather than interleaved into every single-hop pass — a sweep
  // that makes no progress would otherwise force a full extra fixpoint
  // re-scan of everyone, and a sweep is far more expensive per employee than
  // a single-hop attempt (bounded recursive search vs. one filter+sort). Each
  // round tries every still-at-risk employee (worst-to-best charge, standing
  // breaks ties) once; a productive round re-runs single-hop (a rescue can
  // free up a fresh donor for someone else) and loops, capped defensively at
  // employees.length + 1 rounds.
  let rescueRounds = 0;
  let rescueProgressed = true;
  while (rescueProgressed && rescueRounds <= employees.length) {
    rescueRounds++;
    rescueProgressed = false;
    const chargeSnapshot = gmap<number>(employees.map((u) => [u.id, predictedCharge(u.id)]));
    const atRisk = employees.filter((u) => chargeSnapshot.get(u.id) > 0);
    atRisk.sort((a, b) => {
      const byCharge = chargeSnapshot.get(b.id) - chargeSnapshot.get(a.id);
      if (byCharge !== 0) return byCharge;
      return (standings[b.id] ?? 1) - (standings[a.id] ?? 1);
    });
    for (const u of atRisk) {
      if (atRiskNow(u.id) && predictedCharge(u.id) > 0) {
        const before = totalPredictedCharge();
        if (tryRescue(u, 0, new Set()) && totalPredictedCharge() < before) {
          rescueProgressed = true;
        }
      }
    }
    if (rescueProgressed) runSingleHopFixpoint();
  }

  // Settle vacation: shortfall against the FULL personal requirement is
  // covered by vacation charges on the must-off days that caused it, earliest
  // first, each dated on its day and limited by that day's vacation-year
  // balance (never negative).
  const vacationCharges: VacationCharge[] = [];
  for (const u of employees) {
    for (const date of shortfallCharges({
      required: requiredShifts(u),
      counting: counts.get(u.id),
      mustOffDates: mustOffDates.get(u.id),
      yearBalance: yearBalanceOf(u.id),
    })) vacationCharges.push({ userId: u.id, date, cause: 'shortfall' });
  }

  const draft: ScheduleDraft = {
    startDate, endDate, userIds: userIds ?? db.users.map((u) => u.id),
    assignments, unfilled, vacationCharges,
  };
  const { counts: finalCounts, warnings } = summarizeSchedule(db, draft);

  return {
    assignments,
    unfilled,
    warnings,
    counts: finalCounts,
    vacationCharges,
    preferenceStats: stats,
    nextRotationCursor: employees.length ? rotation % employees.length : 0,
  };
}
