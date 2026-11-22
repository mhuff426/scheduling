// Shift trading: open swaps (anyone may counter-offer), direct swaps (aimed at
// one person's specific shift), and giveaways (drop a shift for a vacation
// day; the shift stays yours until someone claims it).
//
// Trades check eligibility with the trade policy (./eligibility.ts): hard
// rules block; the person taking a shift is warned about their own must-off
// day and confirms (`confirmedWarnings`); the consecutive-night limit and the
// shift maximum are ignored. In a swap each person confirms only warnings
// about the shift they'd take, at their own step.
//
// Every function returns { trade } on success or { error, code } on failure.
// Functions mutate the passed db object but never persist — the API routes
// call saveDb() after invoking them (which also keeps these testable against
// fixture objects).

import { newId } from './db.js';
import { summarizeSchedule, includedUsers } from './scheduler.js';
import { needsConfirmation, scheduleEligibility, TRADE_POLICY } from './eligibility.js';
import type { EligibilityPolicy, EligibilityWarning } from './eligibility.js';
import {
  applyElectionCut, electedVacation, electedVacationInYear, electedYears, extraDays, giveaway, vacationYearOf,
  vacationYearsOf, yearBalance,
} from '../shared/settlement.js';
import type {
  Assignment, Db, ExtraElection, Schedule, Slot, Trade, TradeType, User,
} from '../shared/types.js';

// Functions return a success or failure shape; the routes pull these fields off.
// A failure carrying `warnings` is the confirmation contract's refusal: resend
// with `confirmedWarnings` listing their kinds.
type TradeOutcome =
  | { trade: Trade; error?: undefined; code?: undefined; warnings?: undefined }
  | { error: string; code: number; trade?: undefined; warnings?: EligibilityWarning[] };

// The refusal for warnings the person hasn't confirmed, or null to go ahead.
function unconfirmed(warnings: EligibilityWarning[], confirmedWarnings: unknown): TradeOutcome | null {
  if (!needsConfirmation(warnings, confirmedWarnings)) return null;
  return { error: warnings.map((w) => w.message).join(' '), code: 409, warnings };
}

const pad = (n: number) => String(n).padStart(2, '0');
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isFuture = (date: string) => date > todayYmd();

const userName = (db: Db, id: string) => db.users.find((u) => u.id === id)?.name || 'Someone';

function slotLabel(db: Db, slot: Slot) {
  const st = db.shiftTypes.find((s) => s.id === slot.shiftTypeId);
  return `${st ? st.name : 'shift'} on ${slot.date}`;
}

function findAssignment(schedule: Schedule, userId: string, slot: Slot) {
  return schedule.assignments.find(
    (a) => a.userId === userId && a.date === slot.date && a.shiftTypeId === slot.shiftTypeId
  );
}

function notify(db: Db, userId: string, message: string, tradeId: string) {
  db.notifications.push({
    id: newId('n'),
    userId,
    message,
    tradeId,
    read: false,
    createdAt: new Date().toISOString(),
  });
}

function refreshSchedule(db: Db, schedule: Schedule) {
  const { counts, warnings } = summarizeSchedule(db, schedule);
  schedule.counts = counts;
  schedule.warnings = warnings;
}

// Can `user` take `slot` in a trade, pretending the assignments in `ignore`
// don't exist (i.e. shifts they are giving away)? The blocking reason, or null.
export function canTakeShift(
  db: Db, schedule: Schedule, slot: Slot, user: User, ignore: Assignment[] = [], policy: EligibilityPolicy = TRADE_POLICY
): string | null {
  const r = scheduleEligibility(db, schedule, slot, user, policy, ignore);
  return r.eligible ? null : r.reason;
}

// A swap of aAssign for bAssign, judged on the state after it: each person
// takes the other's shift, ignoring the one they give up. Blocked with the
// first blocking reason, or eligible with each side's own warnings (`a` =
// warnings for aAssign's owner, about the shift they'd take).
type SwapCheck =
  | { reason: string }
  | { reason: null; a: EligibilityWarning[]; b: EligibilityWarning[] };

function swapEligibility(db: Db, schedule: Schedule, aAssign: Assignment, bAssign: Assignment): SwapCheck {
  const aUser = db.users.find((u) => u.id === aAssign.userId);
  const bUser = db.users.find((u) => u.id === bAssign.userId);
  if (!aUser || !bUser) return { reason: 'One of the employees no longer exists.' };
  const a = scheduleEligibility(db, schedule, bAssign, aUser, TRADE_POLICY, [aAssign]);
  if (!a.eligible) return { reason: a.reason };
  const b = scheduleEligibility(db, schedule, aAssign, bUser, TRADE_POLICY, [bAssign]);
  if (!b.eligible) return { reason: b.reason };
  return { reason: null, a: a.warnings, b: b.warnings };
}

// Swap the two assignments' owners and refresh the schedule's summary.
function executeSwap(db: Db, schedule: Schedule, aAssign: Assignment, bAssign: Assignment) {
  const tmp = aAssign.userId;
  aAssign.userId = bAssign.userId;
  bAssign.userId = tmp;
  refreshSchedule(db, schedule);
}

// A swappable shift for the trade pickers, marked with the viewer's own
// warnings (what they'd be asked to confirm).
type SwapOption = Slot & { warnings: EligibilityWarning[] };

// The candidate's future shifts that would form a swap against `offered`
// (owned by offeredUserId) with no blocking reason, each marked with the
// warnings of `viewer`: 'candidate' (responding to an open swap) or 'offerer'
// (picking a direct-swap partner). The other side's warnings aren't shown.
function swapOptions(
  db: Db, schedule: Schedule, offered: Slot, offeredUserId: string, candidateUserId: string, viewer: 'candidate' | 'offerer'
): SwapOption[] {
  const offeredAssign = findAssignment(schedule, offeredUserId, offered);
  if (!offeredAssign) return [];
  const out: SwapOption[] = [];
  for (const a of schedule.assignments) {
    if (a.userId !== candidateUserId || !isFuture(a.date)) continue;
    const r = swapEligibility(db, schedule, offeredAssign, a);
    if (r.reason !== null) continue;
    out.push({ date: a.date, shiftTypeId: a.shiftTypeId, warnings: viewer === 'offerer' ? r.a : r.b });
  }
  return out;
}

// The candidate's shifts that can answer an open swap of `offered`, marked
// with the candidate's own warnings.
export function eligibleSwapShifts(db: Db, schedule: Schedule, offered: Slot, offeredUserId: string, candidateUserId: string): SwapOption[] {
  return swapOptions(db, schedule, offered, offeredUserId, candidateUserId, 'candidate');
}

// Everything the Trades screen needs to gate its actions for one viewer, in a
// single read: which of their shifts can answer each open swap, and whether
// they can claim each open giveaway.
export function tradeOptions(db: Db, scheduleId: string, userId: string) {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return { respond: {}, claim: {} };
  const respond: Record<string, SwapOption[]> = {};
  // A giveaway the viewer may claim only after confirming warnings is ok, and
  // carries them; one with a blocking reason isn't.
  const claim: Record<string, { ok: boolean; reason: string | null; warnings: EligibilityWarning[] }> = {};
  for (const t of db.trades || []) {
    if (t.scheduleId !== scheduleId || t.status !== 'open') continue;
    if (t.type === 'open' && t.fromUserId !== userId) {
      respond[t.id] = eligibleSwapShifts(db, schedule, t.offered, t.fromUserId, userId);
    } else if (t.type === 'giveaway' && t.fromUserId !== userId) {
      const claimer = db.users.find((u) => u.id === userId);
      const r = claimer ? scheduleEligibility(db, schedule, t.offered, claimer, TRADE_POLICY) : null;
      claim[t.id] = !r ? { ok: false, reason: 'User not found.', warnings: [] }
        : r.eligible ? { ok: true, reason: null, warnings: r.warnings }
        : { ok: false, reason: r.reason, warnings: [] };
    }
  }
  return { respond, claim };
}

// Feasible partners for a proposed direct swap of `offered` (owned by userId):
// every other employee who has at least one shift forming a swap with no
// blocking reason, with those shifts listed and marked with the offerer's
// own warnings. A partner who'd land on their own must-off day is listed;
// they're warned when they accept.
export function swapPartners(db: Db, scheduleId: string, userId: string, offered: Slot) {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return [];
  const partners: { userId: string; shifts: SwapOption[] }[] = [];
  for (const u of includedUsers(db, schedule)) {
    if (u.id === userId) continue;
    const shifts = swapOptions(db, schedule, offered, userId, u.id, 'offerer');
    if (shifts.length) partners.push({ userId: u.id, shifts });
  }
  return partners;
}

function expire(db: Db, trade: Trade, reason: string) {
  trade.status = 'expired';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `Your trade for ${slotLabel(db, trade.offered)} expired: ${reason}`, trade.id);
}

export function createTrade(
  db: Db,
  { scheduleId, fromUserId, type, offered, toUserId, requested, confirmedWarnings }: {
    scheduleId: string; fromUserId: string; type: TradeType; offered: Slot;
    toUserId?: string | null; requested?: Slot | null; confirmedWarnings?: unknown;
  }
): TradeOutcome {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return { error: 'Schedule not found.', code: 404 };
  const from = db.users.find((u) => u.id === fromUserId);
  if (!from) return { error: 'User not found.', code: 404 };
  if (!['open', 'direct', 'giveaway'].includes(type))
    return { error: 'Unknown trade type.', code: 400 };
  if (!offered || !findAssignment(schedule, fromUserId, offered))
    return { error: 'You can only trade a shift that is currently yours.', code: 400 };
  if (!isFuture(offered.date))
    return { error: 'Only future shifts can be traded.', code: 400 };
  // Duplicate-submission backstop (double-click, two devices): one open trade
  // of a given type per person per offered shift.
  if (
    db.trades.some(
      (t) =>
        t.status === 'open' &&
        t.fromUserId === fromUserId &&
        t.type === type &&
        t.offered.date === offered.date &&
        t.offered.shiftTypeId === offered.shiftTypeId
    )
  )
    return { error: 'You already have an open trade for that shift.', code: 409 };

  const trade: Trade = {
    id: newId('tr'),
    scheduleId,
    type,
    status: 'open',
    fromUserId,
    offered: { date: offered.date, shiftTypeId: offered.shiftTypeId },
    toUserId: null,
    requested: null,
    responses: [],
    claimedBy: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };

  if (type === 'direct') {
    const to = db.users.find((u) => u.id === toUserId);
    if (!to || to.id === fromUserId) return { error: 'Pick another employee to swap with.', code: 400 };
    if (!requested || !findAssignment(schedule, to.id, requested))
      return { error: `That shift doesn't belong to ${to.name}.`, code: 400 };
    if (!isFuture(requested.date))
      return { error: 'Only future shifts can be traded.', code: 400 };
    // The offerer confirms warnings about the shift they'd take now; the
    // target confirms their own when accepting.
    const swap = swapEligibility(db, schedule, findAssignment(schedule, fromUserId, offered)!, findAssignment(schedule, to.id, requested)!);
    if (swap.reason !== null) return { error: swap.reason, code: 400 };
    const refusal = unconfirmed(swap.a, confirmedWarnings);
    if (refusal) return refusal;
    trade.toUserId = to.id;
    trade.requested = { date: requested.date, shiftTypeId: requested.shiftTypeId };
    notify(db, to.id, `${from.name} proposes swapping their ${slotLabel(db, trade.offered)} for your ${slotLabel(db, trade.requested)}.`, trade.id);
  } else if (type === 'giveaway') {
    // A vacation day is only needed when losing this shift drops the giver
    // below their requirement — and then only if they can afford it.
    if (!giveaway(db, schedule, from, offered).canPost)
      return {
        error: `Giving this shift up would use a vacation day and you have none left for ${vacationYearOf(offered.date)} — you must switch shifts instead.`,
        code: 400,
      };
    for (const u of includedUsers(db, schedule)) {
      if (u.id !== fromUserId)
        notify(db, u.id, `${from.name} is giving up their ${slotLabel(db, trade.offered)} — first to claim it takes it.`, trade.id);
    }
  } else {
    for (const u of includedUsers(db, schedule)) {
      if (u.id !== fromUserId)
        notify(db, u.id, `${from.name} wants to swap their ${slotLabel(db, trade.offered)} — offer one of your shifts in Trades.`, trade.id);
    }
  }

  db.trades.push(trade);
  return { trade };
}

export function respondToOpenTrade(
  db: Db, tradeId: string,
  { userId, date, shiftTypeId, confirmedWarnings }: { userId: string; date: string; shiftTypeId: string; confirmedWarnings?: unknown }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.type !== 'open' || trade.status !== 'open')
    return { error: 'This trade is no longer accepting offers.', code: 409 };
  if (userId === trade.fromUserId)
    return { error: "You can't respond to your own trade.", code: 400 };
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return { error: 'Schedule no longer exists.', code: 404 };
  const slot = { date, shiftTypeId };
  const myAssign = findAssignment(schedule, userId, slot);
  if (!myAssign)
    return { error: 'You can only offer a shift that is currently yours.', code: 400 };
  if (!isFuture(date)) return { error: 'Only future shifts can be offered.', code: 400 };
  const offeredAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  if (!offeredAssign) {
    expire(db, trade, 'the offered shift is no longer available.');
    return { error: 'That shift is no longer available — the trade has expired.', code: 409 };
  }
  // The responder confirms warnings about the shift they'd take; the poster
  // confirms their own when accepting.
  const swap = swapEligibility(db, schedule, offeredAssign, myAssign);
  if (swap.reason !== null) return { error: `${swap.reason} — you can't cover that shift.`, code: 400 };
  const refusal = unconfirmed(swap.b, confirmedWarnings);
  if (refusal) return refusal;

  trade.responses = trade.responses.filter((r) => r.userId !== userId);
  trade.responses.push({ userId, date, shiftTypeId, at: new Date().toISOString() });
  notify(db, trade.fromUserId, `${userName(db, userId)} offered their ${slotLabel(db, slot)} for your ${slotLabel(db, trade.offered)}.`, trade.id);
  return { trade };
}

export function withdrawResponse(db: Db, tradeId: string, { userId }: { userId: string }) {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  trade.responses = trade.responses.filter((r) => r.userId !== userId);
  return { trade };
}

export function acceptOpenResponse(
  db: Db, tradeId: string,
  { userId, responseUserId, confirmedWarnings }: { userId: string; responseUserId: string; confirmedWarnings?: unknown }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.type !== 'open' || trade.status !== 'open')
    return { error: 'This trade is no longer open.', code: 409 };
  if (userId !== trade.fromUserId)
    return { error: 'Only the trade owner can accept an offer.', code: 403 };
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return { error: 'Schedule no longer exists.', code: 404 };

  const myAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  if (!myAssign || !isFuture(trade.offered.date)) {
    expire(db, trade, 'the offered shift is no longer yours (or is in the past).');
    return { error: 'Your offered shift is no longer valid — trade expired.', code: 409 };
  }
  const resp = trade.responses.find((r) => r.userId === responseUserId);
  if (!resp) return { error: 'That offer no longer exists.', code: 404 };
  const theirAssign = findAssignment(schedule, resp.userId, resp);
  if (!theirAssign || !isFuture(resp.date)) {
    trade.responses = trade.responses.filter((r) => r.userId !== responseUserId);
    return { error: `${userName(db, resp.userId)}'s offered shift is no longer valid.`, code: 409 };
  }

  // Hard rules first (a confirmed resend still fails if one now blocks), then
  // the poster confirms warnings about the shift they'd take.
  const swap = swapEligibility(db, schedule, myAssign, theirAssign);
  if (swap.reason !== null) return { error: swap.reason, code: 400 };
  const refusal = unconfirmed(swap.a, confirmedWarnings);
  if (refusal) return refusal;
  executeSwap(db, schedule, myAssign, theirAssign);

  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, resp.userId, `${userName(db, userId)} accepted your offer — you now work ${slotLabel(db, trade.offered)} and they took your ${slotLabel(db, resp)}.`, trade.id);
  for (const r of trade.responses) {
    if (r.userId !== responseUserId)
      notify(db, r.userId, `${userName(db, userId)}'s swap of ${slotLabel(db, trade.offered)} went to someone else.`, trade.id);
  }
  return { trade };
}

export function acceptDirect(
  db: Db, tradeId: string, { userId, confirmedWarnings }: { userId: string; confirmedWarnings?: unknown }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.type !== 'direct' || trade.status !== 'open')
    return { error: 'This proposal is no longer open.', code: 409 };
  if (userId !== trade.toUserId)
    return { error: 'This proposal was sent to someone else.', code: 403 };
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return { error: 'Schedule no longer exists.', code: 404 };

  const fromAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  const toAssign = findAssignment(schedule, trade.toUserId!, trade.requested!);
  if (!fromAssign || !toAssign || !isFuture(trade.offered.date) || !isFuture(trade.requested!.date)) {
    expire(db, trade, 'one of the shifts changed hands or is in the past.');
    return { error: 'One of the shifts is no longer valid — proposal expired.', code: 409 };
  }

  // Hard rules first, then the target confirms warnings about the shift
  // they'd take (the offerer confirmed theirs when sending the offer).
  const swap = swapEligibility(db, schedule, fromAssign, toAssign);
  if (swap.reason !== null) return { error: swap.reason, code: 400 };
  const refusal = unconfirmed(swap.b, confirmedWarnings);
  if (refusal) return refusal;
  executeSwap(db, schedule, fromAssign, toAssign);

  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${userName(db, userId)} accepted your swap — you now work ${slotLabel(db, trade.requested!)} and they took your ${slotLabel(db, trade.offered)}.`, trade.id);
  return { trade };
}

export function rejectDirect(db: Db, tradeId: string, { userId }: { userId: string }) {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.type !== 'direct' || trade.status !== 'open')
    return { error: 'This proposal is no longer open.', code: 409 };
  if (userId !== trade.toUserId)
    return { error: 'This proposal was sent to someone else.', code: 403 };
  trade.status = 'rejected';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${userName(db, userId)} declined your swap proposal for ${slotLabel(db, trade.offered)}.`, trade.id);
  return { trade };
}

export function claimGiveaway(
  db: Db, tradeId: string, { userId, confirmedWarnings }: { userId: string; confirmedWarnings?: unknown }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.type !== 'giveaway' || trade.status !== 'open')
    return { error: 'This shift has already been claimed or withdrawn.', code: 409 };
  if (userId === trade.fromUserId)
    return { error: "You can't claim your own giveaway.", code: 400 };
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return { error: 'Schedule no longer exists.', code: 404 };
  const claimer = db.users.find((u) => u.id === userId);
  if (!claimer) return { error: 'User not found.', code: 404 };

  const assign = findAssignment(schedule, trade.fromUserId, trade.offered);
  if (!assign || !isFuture(trade.offered.date)) {
    // Nothing was charged yet — a giveaway only settles when it's claimed.
    expire(db, trade, 'the shift changed hands or is in the past.');
    return { error: 'That shift is no longer available — giveaway expired.', code: 409 };
  }

  // Hard rules first, so a confirmed resend still fails if one now blocks;
  // then the claimer confirms warnings about their own must-off day.
  const elig = scheduleEligibility(db, schedule, trade.offered, claimer, TRADE_POLICY);
  if (!elig.eligible) return { error: elig.reason, code: 400 };
  const refusal = unconfirmed(elig.warnings, confirmedWarnings);
  if (refusal) return refusal;

  // Settle the giver's side before transferring: charge a vacation day if the
  // loss drops them below required, and trim their extra-day election if
  // their extra shrinks (incentive first). Block when either step would push
  // their year's balance negative.
  const giver = db.users.find((u) => u.id === trade.fromUserId)!;
  const settled = giveaway(db, schedule, giver, trade.offered);
  if (!settled.canClaim) {
    expire(db, trade, `${giver.name} can no longer cover the vacation day it requires.`);
    return { error: 'The giver can no longer afford this giveaway — it has expired.', code: 409 };
  }
  if (settled.needsDay) {
    schedule.vacationCharges ??= [];
    schedule.vacationCharges.push({ userId: trade.fromUserId, date: trade.offered.date, cause: 'giveaway' });
  }
  const el = schedule.extraElections?.[trade.fromUserId];
  if (el) schedule.extraElections![trade.fromUserId] = applyElectionCut(el, settled.electionCut);

  assign.userId = userId;
  refreshSchedule(db, schedule);
  trade.claimedBy = userId;
  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${claimer.name} picked up your ${slotLabel(db, trade.offered)}. Enjoy the day off!`, trade.id);
  return { trade };
}

export function cancelTrade(db: Db, tradeId: string, { userId }: { userId: string }) {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.status !== 'open') return { error: 'This trade is no longer open.', code: 409 };
  if (userId !== trade.fromUserId)
    return { error: 'Only the trade owner can cancel it.', code: 403 };
  trade.status = 'cancelled';
  trade.resolvedAt = new Date().toISOString();
  const audience = new Set([
    ...(trade.toUserId ? [trade.toUserId] : []),
    ...trade.responses.map((r) => r.userId),
  ]);
  for (const uid of audience) {
    notify(db, uid, `${userName(db, userId)} withdrew their trade for ${slotLabel(db, trade.offered)}.`, trade.id);
  }
  // Nothing to undo for a giveaway: vacation is only charged when it's claimed.
  return { trade };
}

// Split a user's extra days (worked or charged beyond required) between
// extra vacation (credits a vacation year's balance) and incentive pay (HR
// pays out). Vacation days are elected per vacation year the schedule spans,
// so a schedule across New Year can put them in either year or split them.
// The new split replaces the previous one; the total may not exceed the
// current extra, and lowering a year's elected vacation may not push that
// year's balance negative (those days may already be spent).
export function setExtraElection(
  db: Db,
  scheduleId: string,
  { userId, vacationByYear, incentive, ...rest }: { userId: string; vacationByYear?: Record<string, unknown>; incentive: number }
) {
  // The single `vacation` number from before per-year elections (#37) would
  // otherwise be silently ignored, clearing the person's elected vacation.
  if ('vacation' in rest)
    return { error: 'Elect vacation days per vacation year with `vacationByYear`; `vacation` is no longer supported.', code: 400 };
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return { error: 'Schedule not found.', code: 404 };
  const user = db.users.find((u) => u.id === userId);
  if (!user) return { error: 'User not found.', code: 404 };
  const years = vacationYearsOf(schedule);
  const byYear: Record<string, number> = {};
  for (const [year, n] of Object.entries(vacationByYear || {})) {
    const days = Math.max(0, Math.floor(Number(n) || 0));
    if (!days) continue;
    const y = Number(year);
    if (!Number.isInteger(y) || !years.includes(y))
      return { error: `This schedule doesn't cover vacation year ${year}.`, code: 400 };
    // Keyed by the canonical year, so "02026" and "2026" are one year (and
    // one schedule_election_vacation row), not two.
    byYear[y] = (byYear[y] || 0) + days;
  }
  const inc = Math.max(0, Math.floor(Number(incentive) || 0));
  const next: ExtraElection = { vacationByYear: byYear, incentive: inc };
  const extra = extraDays(db, schedule, user);
  if (electedVacation(next) + inc > extra)
    return {
      error: `Only ${extra} extra day${extra === 1 ? '' : 's'} available to allocate.`,
      code: 400,
    };
  const prev = schedule.extraElections?.[userId];
  for (const year of electedYears(prev)) {
    const lowered = electedVacationInYear(prev, year) - electedVacationInYear(next, year);
    if (lowered > 0 && yearBalance(db, user, year).balance - lowered < 0)
      return { error: `You have already used the ${year} vacation days earned from those extra days.`, code: 400 };
  }
  schedule.extraElections ??= {};
  schedule.extraElections[userId] = next;
  return { election: next };
}

// Extra shifts picked up per schedule, derived from completed giveaways.
export function extraShifts(db: Db, scheduleId: string) {
  const out: Record<string, number> = {};
  for (const t of db.trades || []) {
    if (t.type === 'giveaway' && t.status === 'completed' && t.scheduleId === scheduleId && t.claimedBy) {
      out[t.claimedBy] = (out[t.claimedBy] || 0) + 1;
    }
  }
  return out;
}
