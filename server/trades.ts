// Shift trading: open swaps (anyone may counter-offer), direct swaps (aimed at
// one person's specific shift), and giveaways (drop a shift for a vacation
// day; the shift stays yours until someone claims it).
//
// Trades check eligibility with the trade policy (./eligibility.ts): hard
// rules block; the person taking a shift is warned about their own must-off
// day and confirms (`confirmedWarnings`, the warning messages, read once by
// the route); the consecutive-night limit and the shift maximum are ignored.
// In a swap each person confirms only warnings about the shift they'd take, at
// their own step.
//
// Each command takes the data, a context of { actor, today } and its input,
// and returns an Outcome (./outcome.ts, ADR 0003). Trades need no capability:
// the actor acts as themselves, and each command checks they own what they
// act on. Commands mutate the passed db but never persist: the route adapter
// runs them in a transaction, which a refusal rolls back unless it sets
// `persist` — as the refusals that expire a stale trade (or drop a stale
// offer) do, so dead trades stay dead.

import { newId } from './db.js';
import { summarizeSchedule, includedUsers } from './scheduler.js';
import { needsConfirmation, scheduleEligibility, TRADE_POLICY } from './eligibility.js';
import type { EligibilityWarning } from '../shared/confirmation.js';
import { ok, refuse, unconfirmed, type CommandContext, type Outcome, type Refused } from './outcome.js';
import {
  applyElectionCut, electedVacation, electedVacationInYear, electedYears, extraDays, giveaway, vacationYearOf,
  vacationYearsOf, yearBalance,
} from '../shared/settlement.js';
import type {
  Assignment, ClaimOption, Db, ExtraElection, Schedule, Slot, SwapOption, SwapPartner, Trade, TradeOptions,
  TradeType,
} from '../shared/types.js';

type TradeOutcome = Outcome<Trade>;

// The refusal for warnings the person hasn't confirmed, or null to go ahead.
function refuseUnconfirmed(warnings: EligibilityWarning[], confirmedWarnings: string[]): Refused | null {
  return needsConfirmation(warnings, confirmedWarnings) ? unconfirmed(warnings) : null;
}

const isFuture = (date: string, today: string) => date > today;

const tradeNotFound = () => refuse('not_found', 'Trade not found.');
const scheduleGone = () => refuse('not_found', 'Schedule no longer exists.');

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

// The two people in a swap: the offerer owns the offered shift (the trade's
// poster); the taker would take it, giving up their own shift in return (an
// open swap's responder, or a direct swap's target).
type SwapParty = 'offerer' | 'taker';

// A swap of the offered shift for the taker's, judged on the state after it:
// each person takes the other's shift, ignoring the one they give up. Blocked
// with the first blocking reason, or eligible with each party's own warnings
// (about the shift they'd take).
type SwapCheck =
  | { reason: string }
  | { reason: null; warnings: Record<SwapParty, EligibilityWarning[]> };

function swapEligibility(db: Db, schedule: Schedule, offeredAssign: Assignment, takerAssign: Assignment): SwapCheck {
  const offerer = db.users.find((u) => u.id === offeredAssign.userId);
  const taker = db.users.find((u) => u.id === takerAssign.userId);
  if (!offerer || !taker) return { reason: 'One of the employees no longer exists.' };
  const forOfferer = scheduleEligibility(db, schedule, takerAssign, offerer, TRADE_POLICY, [offeredAssign]);
  if (!forOfferer.eligible) return { reason: forOfferer.reason };
  const forTaker = scheduleEligibility(db, schedule, offeredAssign, taker, TRADE_POLICY, [takerAssign]);
  if (!forTaker.eligible) return { reason: forTaker.reason };
  return { reason: null, warnings: { offerer: forOfferer.warnings, taker: forTaker.warnings } };
}

// One party's step in a swap: hard rules first (so a confirmed resend still
// fails if one now blocks), then `party` confirms the warnings about the
// shift they'd take. The refusal, or null to go ahead.
function swapStepRefusal(
  db: Db, schedule: Schedule, offeredAssign: Assignment, takerAssign: Assignment,
  party: SwapParty, confirmedWarnings: string[]
): Refused | null {
  const swap = swapEligibility(db, schedule, offeredAssign, takerAssign);
  if (swap.reason !== null) return refuse('invalid', swap.reason);
  return refuseUnconfirmed(swap.warnings[party], confirmedWarnings);
}

// Swap the two assignments' owners and refresh the schedule's summary.
function executeSwap(db: Db, schedule: Schedule, aAssign: Assignment, bAssign: Assignment) {
  const tmp = aAssign.userId;
  aAssign.userId = bAssign.userId;
  bAssign.userId = tmp;
  refreshSchedule(db, schedule);
}

// The taker's future shifts that would form a swap against `offered` (owned
// by offererUserId) with no blocking reason, each marked with the warnings of
// `viewer`: the taker (responding to an open swap) or the offerer (picking a
// direct-swap partner). The other party's warnings aren't shown.
function swapOptions(
  db: Db, schedule: Schedule, offered: Slot, offererUserId: string, takerUserId: string, viewer: SwapParty,
  today: string
): SwapOption[] {
  const offeredAssign = findAssignment(schedule, offererUserId, offered);
  if (!offeredAssign) return [];
  const out: SwapOption[] = [];
  for (const a of schedule.assignments) {
    if (a.userId !== takerUserId || !isFuture(a.date, today)) continue;
    const r = swapEligibility(db, schedule, offeredAssign, a);
    if (r.reason !== null) continue;
    out.push({ date: a.date, shiftTypeId: a.shiftTypeId, warnings: r.warnings[viewer] });
  }
  return out;
}

// The responder's shifts that can answer an open swap of `offered`, marked
// with the responder's own warnings.
export function eligibleSwapShifts(
  db: Db, schedule: Schedule, offered: Slot, offererUserId: string, responderUserId: string, today: string
): SwapOption[] {
  return swapOptions(db, schedule, offered, offererUserId, responderUserId, 'taker', today);
}

// Everything the Trades screen needs to gate its actions for one viewer, in a
// single read: which of their shifts can answer each open swap, and whether
// they can claim each open giveaway.
export function tradeOptions(db: Db, scheduleId: string, userId: string, today: string): TradeOptions {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return { respond: {}, claim: {} };
  const respond: Record<string, SwapOption[]> = {};
  const claim: Record<string, ClaimOption> = {};
  for (const t of db.trades || []) {
    if (t.scheduleId !== scheduleId || t.status !== 'open') continue;
    if (t.type === 'open' && t.fromUserId !== userId) {
      respond[t.id] = eligibleSwapShifts(db, schedule, t.offered, t.fromUserId, userId, today);
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
export function swapPartners(db: Db, scheduleId: string, userId: string, offered: Slot, today: string): SwapPartner[] {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return [];
  const partners: SwapPartner[] = [];
  for (const u of includedUsers(db, schedule)) {
    if (u.id === userId) continue;
    const shifts = swapOptions(db, schedule, offered, userId, u.id, 'offerer', today);
    if (shifts.length) partners.push({ userId: u.id, shifts });
  }
  return partners;
}

function expire(db: Db, trade: Trade, reason: string) {
  trade.status = 'expired';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `Your trade for ${slotLabel(db, trade.offered)} expired: ${reason}`, trade.id);
}

// Expire a stale trade and refuse, keeping the expiry.
function expireAndRefuse(db: Db, trade: Trade, reason: string, message: string): Refused {
  expire(db, trade, reason);
  return refuse('conflict', message, { persist: true });
}

export function createTrade(
  db: Db, { actor: from, today }: CommandContext,
  { scheduleId, type, offered, toUserId, requested, confirmedWarnings = [] }: {
    scheduleId: string; type: TradeType; offered: Slot;
    toUserId?: string | null; requested?: Slot | null; confirmedWarnings?: string[];
  }
): TradeOutcome {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return refuse('not_found', 'Schedule not found.');
  if (!['open', 'direct', 'giveaway'].includes(type)) return refuse('invalid', 'Unknown trade type.');
  if (!offered || !findAssignment(schedule, from.id, offered))
    return refuse('invalid', 'You can only trade a shift that is currently yours.');
  if (!isFuture(offered.date, today)) return refuse('invalid', 'Only future shifts can be traded.');
  // Duplicate-submission backstop (double-click, two devices): one open trade
  // of a given type per person per offered shift.
  if (
    db.trades.some(
      (t) =>
        t.status === 'open' &&
        t.fromUserId === from.id &&
        t.type === type &&
        t.offered.date === offered.date &&
        t.offered.shiftTypeId === offered.shiftTypeId
    )
  )
    return refuse('conflict', 'You already have an open trade for that shift.');

  const trade: Trade = {
    id: newId('tr'),
    scheduleId,
    type,
    status: 'open',
    fromUserId: from.id,
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
    if (!to || to.id === from.id) return refuse('invalid', 'Pick another employee to swap with.');
    if (!requested || !findAssignment(schedule, to.id, requested))
      return refuse('invalid', `That shift doesn't belong to ${to.name}.`);
    if (!isFuture(requested.date, today)) return refuse('invalid', 'Only future shifts can be traded.');
    // The offerer confirms warnings about the shift they'd take now; the
    // target confirms their own when accepting.
    const refusal = swapStepRefusal(
      db, schedule, findAssignment(schedule, from.id, offered)!, findAssignment(schedule, to.id, requested)!,
      'offerer', confirmedWarnings
    );
    if (refusal) return refusal;
    trade.toUserId = to.id;
    trade.requested = { date: requested.date, shiftTypeId: requested.shiftTypeId };
    notify(db, to.id, `${from.name} proposes swapping their ${slotLabel(db, trade.offered)} for your ${slotLabel(db, trade.requested)}.`, trade.id);
  } else if (type === 'giveaway') {
    // A vacation day is only needed when losing this shift drops the giver
    // below their requirement — and then only if they can afford it.
    if (!giveaway(db, schedule, from, offered).canPost)
      return refuse(
        'invalid',
        `Giving this shift up would use a vacation day and you have none left for ${vacationYearOf(offered.date)} — you must switch shifts instead.`
      );
    for (const u of includedUsers(db, schedule)) {
      if (u.id !== from.id)
        notify(db, u.id, `${from.name} is giving up their ${slotLabel(db, trade.offered)} — first to claim it takes it.`, trade.id);
    }
  } else {
    for (const u of includedUsers(db, schedule)) {
      if (u.id !== from.id)
        notify(db, u.id, `${from.name} wants to swap their ${slotLabel(db, trade.offered)} — offer one of your shifts in Trades.`, trade.id);
    }
  }

  db.trades.push(trade);
  return ok(trade);
}

export function respondToOpenTrade(
  db: Db, { actor, today }: CommandContext,
  { tradeId, date, shiftTypeId, confirmedWarnings = [] }: {
    tradeId: string; date: string; shiftTypeId: string; confirmedWarnings?: string[];
  }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  if (trade.type !== 'open' || trade.status !== 'open')
    return refuse('conflict', 'This trade is no longer accepting offers.');
  if (actor.id === trade.fromUserId) return refuse('invalid', "You can't respond to your own trade.");
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return scheduleGone();
  const slot = { date, shiftTypeId };
  const myAssign = findAssignment(schedule, actor.id, slot);
  if (!myAssign) return refuse('invalid', 'You can only offer a shift that is currently yours.');
  if (!isFuture(date, today)) return refuse('invalid', 'Only future shifts can be offered.');
  const offeredAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  if (!offeredAssign)
    return expireAndRefuse(db, trade, 'the offered shift is no longer available.',
      'That shift is no longer available — the trade has expired.');
  // The responder confirms warnings about the shift they'd take; the poster
  // confirms their own when accepting.
  const refusal = swapStepRefusal(db, schedule, offeredAssign, myAssign, 'taker', confirmedWarnings);
  if (refusal?.refusal.reason === 'unconfirmed') return refusal;
  if (refusal) return refuse('invalid', `${refusal.refusal.message} — you can't cover that shift.`);

  trade.responses = trade.responses.filter((r) => r.userId !== actor.id);
  trade.responses.push({ userId: actor.id, date, shiftTypeId, at: new Date().toISOString() });
  notify(db, trade.fromUserId, `${actor.name} offered their ${slotLabel(db, slot)} for your ${slotLabel(db, trade.offered)}.`, trade.id);
  return ok(trade);
}

export function withdrawResponse(db: Db, { actor }: CommandContext, { tradeId }: { tradeId: string }): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  trade.responses = trade.responses.filter((r) => r.userId !== actor.id);
  return ok(trade);
}

export function acceptOpenResponse(
  db: Db, { actor, today }: CommandContext,
  { tradeId, responseUserId, confirmedWarnings = [] }: {
    tradeId: string; responseUserId?: string; confirmedWarnings?: string[];
  }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  if (trade.type !== 'open' || trade.status !== 'open') return refuse('conflict', 'This trade is no longer open.');
  if (actor.id !== trade.fromUserId) return refuse('forbidden', 'Only the trade owner can accept an offer.');
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return scheduleGone();

  const myAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  if (!myAssign || !isFuture(trade.offered.date, today))
    return expireAndRefuse(db, trade, 'the offered shift is no longer yours (or is in the past).',
      'Your offered shift is no longer valid — trade expired.');
  const resp = trade.responses.find((r) => r.userId === responseUserId);
  if (!resp) return refuse('not_found', 'That offer no longer exists.');
  const theirAssign = findAssignment(schedule, resp.userId, resp);
  if (!theirAssign || !isFuture(resp.date, today)) {
    // Drop the stale offer, and keep it dropped.
    trade.responses = trade.responses.filter((r) => r.userId !== responseUserId);
    return refuse('conflict', `${userName(db, resp.userId)}'s offered shift is no longer valid.`, { persist: true });
  }

  // The poster confirms warnings about the shift they'd take.
  const refusal = swapStepRefusal(db, schedule, myAssign, theirAssign, 'offerer', confirmedWarnings);
  if (refusal) return refusal;
  executeSwap(db, schedule, myAssign, theirAssign);

  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, resp.userId, `${actor.name} accepted your offer — you now work ${slotLabel(db, trade.offered)} and they took your ${slotLabel(db, resp)}.`, trade.id);
  for (const r of trade.responses) {
    if (r.userId !== responseUserId)
      notify(db, r.userId, `${actor.name}'s swap of ${slotLabel(db, trade.offered)} went to someone else.`, trade.id);
  }
  return ok(trade);
}

export function acceptDirect(
  db: Db, { actor, today }: CommandContext,
  { tradeId, confirmedWarnings = [] }: { tradeId: string; confirmedWarnings?: string[] }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  if (trade.type !== 'direct' || trade.status !== 'open') return refuse('conflict', 'This proposal is no longer open.');
  if (actor.id !== trade.toUserId) return refuse('forbidden', 'This proposal was sent to someone else.');
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return scheduleGone();

  const fromAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  const toAssign = findAssignment(schedule, trade.toUserId!, trade.requested!);
  if (!fromAssign || !toAssign || !isFuture(trade.offered.date, today) || !isFuture(trade.requested!.date, today))
    return expireAndRefuse(db, trade, 'one of the shifts changed hands or is in the past.',
      'One of the shifts is no longer valid — proposal expired.');

  // The target confirms warnings about the shift they'd take (the offerer
  // confirmed theirs when sending the offer).
  const refusal = swapStepRefusal(db, schedule, fromAssign, toAssign, 'taker', confirmedWarnings);
  if (refusal) return refusal;
  executeSwap(db, schedule, fromAssign, toAssign);

  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${actor.name} accepted your swap — you now work ${slotLabel(db, trade.requested!)} and they took your ${slotLabel(db, trade.offered)}.`, trade.id);
  return ok(trade);
}

// Accept whichever kind of trade this is: an offer on your open swap
// (`responseUserId`), or a direct proposal sent to you.
export function acceptTrade(
  db: Db, ctx: CommandContext,
  input: { tradeId: string; responseUserId?: string; confirmedWarnings?: string[] }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === input.tradeId);
  if (!trade) return tradeNotFound();
  return trade.type === 'open' ? acceptOpenResponse(db, ctx, input) : acceptDirect(db, ctx, input);
}

export function rejectDirect(db: Db, { actor }: CommandContext, { tradeId }: { tradeId: string }): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  if (trade.type !== 'direct' || trade.status !== 'open') return refuse('conflict', 'This proposal is no longer open.');
  if (actor.id !== trade.toUserId) return refuse('forbidden', 'This proposal was sent to someone else.');
  trade.status = 'rejected';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${actor.name} declined your swap proposal for ${slotLabel(db, trade.offered)}.`, trade.id);
  return ok(trade);
}

export function claimGiveaway(
  db: Db, { actor: claimer, today }: CommandContext,
  { tradeId, confirmedWarnings = [] }: { tradeId: string; confirmedWarnings?: string[] }
): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  if (trade.type !== 'giveaway' || trade.status !== 'open')
    return refuse('conflict', 'This shift has already been claimed or withdrawn.');
  if (claimer.id === trade.fromUserId) return refuse('invalid', "You can't claim your own giveaway.");
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return scheduleGone();

  const assign = findAssignment(schedule, trade.fromUserId, trade.offered);
  if (!assign || !isFuture(trade.offered.date, today))
    // Nothing was charged yet — a giveaway only settles when it's claimed.
    return expireAndRefuse(db, trade, 'the shift changed hands or is in the past.',
      'That shift is no longer available — giveaway expired.');

  // Hard rules first, so a confirmed resend still fails if one now blocks;
  // then the claimer confirms warnings about their own must-off day.
  const elig = scheduleEligibility(db, schedule, trade.offered, claimer, TRADE_POLICY);
  if (!elig.eligible) return refuse('invalid', elig.reason);
  const refusal = refuseUnconfirmed(elig.warnings, confirmedWarnings);
  if (refusal) return refusal;

  // Settle the giver's side before transferring: charge a vacation day if the
  // loss drops them below required, and trim their extra-day election if
  // their extra shrinks (incentive first). Block when either step would push
  // their year's balance negative.
  const giver = db.users.find((u) => u.id === trade.fromUserId)!;
  const settled = giveaway(db, schedule, giver, trade.offered);
  if (!settled.canClaim)
    return expireAndRefuse(db, trade, `${giver.name} can no longer cover the vacation day it requires.`,
      'The giver can no longer afford this giveaway — it has expired.');
  if (settled.needsDay) {
    schedule.vacationCharges ??= [];
    schedule.vacationCharges.push({ userId: trade.fromUserId, date: trade.offered.date, cause: 'giveaway' });
  }
  const el = schedule.extraElections?.[trade.fromUserId];
  if (el) schedule.extraElections![trade.fromUserId] = applyElectionCut(el, settled.electionCut);

  assign.userId = claimer.id;
  refreshSchedule(db, schedule);
  trade.claimedBy = claimer.id;
  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${claimer.name} picked up your ${slotLabel(db, trade.offered)}. Enjoy the day off!`, trade.id);
  return ok(trade);
}

export function cancelTrade(db: Db, { actor }: CommandContext, { tradeId }: { tradeId: string }): TradeOutcome {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return tradeNotFound();
  if (trade.status !== 'open') return refuse('conflict', 'This trade is no longer open.');
  if (actor.id !== trade.fromUserId) return refuse('forbidden', 'Only the trade owner can cancel it.');
  trade.status = 'cancelled';
  trade.resolvedAt = new Date().toISOString();
  const audience = new Set([
    ...(trade.toUserId ? [trade.toUserId] : []),
    ...trade.responses.map((r) => r.userId),
  ]);
  for (const uid of audience) {
    notify(db, uid, `${actor.name} withdrew their trade for ${slotLabel(db, trade.offered)}.`, trade.id);
  }
  // Nothing to undo for a giveaway: vacation is only charged when it's claimed.
  return ok(trade);
}

// Split the actor's extra days (worked or charged beyond required) between
// extra vacation (credits a vacation year's balance) and incentive pay (HR
// pays out). Vacation days are elected per vacation year the schedule spans,
// so a schedule across New Year can put them in either year or split them.
// The new split replaces the previous one; the total may not exceed the
// current extra, and lowering a year's elected vacation may not push that
// year's balance negative (those days may already be spent).
export function setExtraElection(
  db: Db, { actor: user }: CommandContext,
  { scheduleId, vacationByYear, incentive, ...rest }: {
    scheduleId: string; vacationByYear?: Record<string, unknown>; incentive: unknown;
  }
): Outcome<ExtraElection> {
  // The single `vacation` number from before per-year elections (#37) would
  // otherwise be silently ignored, clearing the person's elected vacation.
  if ('vacation' in rest)
    return refuse('invalid', 'Elect vacation days per vacation year with `vacationByYear`; `vacation` is no longer supported.');
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return refuse('not_found', 'Schedule not found.');
  const years = vacationYearsOf(schedule);
  const byYear: Record<string, number> = {};
  for (const [year, n] of Object.entries(vacationByYear || {})) {
    const days = Math.max(0, Math.floor(Number(n) || 0));
    if (!days) continue;
    const y = Number(year);
    if (!Number.isInteger(y) || !years.includes(y))
      return refuse('invalid', `This schedule doesn't cover vacation year ${year}.`);
    // Keyed by the canonical year, so "02026" and "2026" are one year (and
    // one schedule_election_vacation row), not two.
    byYear[y] = (byYear[y] || 0) + days;
  }
  const inc = Math.max(0, Math.floor(Number(incentive) || 0));
  const next: ExtraElection = { vacationByYear: byYear, incentive: inc };
  const extra = extraDays(db, schedule, user);
  if (electedVacation(next) + inc > extra)
    return refuse('invalid', `Only ${extra} extra day${extra === 1 ? '' : 's'} available to allocate.`);
  const prev = schedule.extraElections?.[user.id];
  for (const year of electedYears(prev)) {
    const lowered = electedVacationInYear(prev, year) - electedVacationInYear(next, year);
    if (lowered > 0 && yearBalance(db, user, year).balance - lowered < 0)
      return refuse('invalid', `You have already used the ${year} vacation days earned from those extra days.`);
  }
  schedule.extraElections ??= {};
  schedule.extraElections[user.id] = next;
  return ok(next);
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
