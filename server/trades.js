// Shift trading: open swaps (anyone may counter-offer), direct swaps (aimed at
// one person's specific shift), and giveaways (drop a shift for a vacation
// day; the shift stays yours until someone claims it).
//
// Trades enforce the safety rules only — vacation-day conflicts, one shift per
// person per day, 8h rest, personal night caps. The max-shifts cap is NOT
// enforced here: picked-up shifts are "extra" by design and tracked as such.
//
// Every function returns { trade } on success or { error, code } on failure.
// Functions mutate the passed db object but never persist — the API routes
// call saveDb() after invoking them (which also keeps these testable against
// fixture objects).

import { newId, vacationAvailable } from './db.js';
import {
  restOk, nightCapOk, summarizeSchedule, includedUsers,
  weightOf, countingShifts, requiredFor, extraDays,
} from './scheduler.js';

const pad = (n) => String(n).padStart(2, '0');
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isFuture = (date) => date > todayYmd();

const shiftById = (db) => Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
const userName = (db, id) => db.users.find((u) => u.id === id)?.name || 'Someone';

function slotLabel(db, slot) {
  const st = db.shiftTypes.find((s) => s.id === slot.shiftTypeId);
  return `${st ? st.name : 'shift'} on ${slot.date}`;
}

function findAssignment(schedule, userId, slot) {
  return schedule.assignments.find(
    (a) => a.userId === userId && a.date === slot.date && a.shiftTypeId === slot.shiftTypeId
  );
}

function notify(db, userId, message, tradeId) {
  db.notifications.push({
    id: newId('n'),
    userId,
    message,
    tradeId,
    read: false,
    createdAt: new Date().toISOString(),
  });
}

function refreshSchedule(db, schedule) {
  const { counts, warnings } = summarizeSchedule(db, schedule);
  schedule.counts = counts;
  schedule.warnings = warnings;
}

// Safety-rules check (no max-shifts cap): can `user` work `slot`, pretending
// the assignments in `ignore` don't exist (i.e. shifts they are giving away)?
export function canTakeShift(db, schedule, slot, user, ignore = []) {
  const stMap = shiftById(db);
  const st = stMap[slot.shiftTypeId];
  if (!st) return 'That shift type no longer exists.';
  if (
    db.timeOff.some(
      (t) => t.userId === user.id && t.date === slot.date && t.type === 'vacation'
    )
  )
    return `${user.name} is on vacation that day.`;
  const held = schedule.assignments.filter(
    (a) => a.userId === user.id && !ignore.includes(a)
  );
  if (held.some((a) => a.date === slot.date))
    return `${user.name} already works a shift that day.`;
  if (!restOk(held, stMap, slot.date, st))
    return `${user.name} would have less than 8 hours of rest around that shift.`;
  if (!nightCapOk(user, held, stMap, slot.date, st))
    return `${user.name} would exceed their ${user.maxConsecutiveNights}-night limit on consecutive overnight shifts.`;
  return null;
}

// A swap is valid when both people can take the other's shift, each ignoring
// the shift they give up. Returns the first blocking reason, or null.
export function swapValid(db, schedule, aAssign, bAssign) {
  const aUser = db.users.find((u) => u.id === aAssign.userId);
  const bUser = db.users.find((u) => u.id === bAssign.userId);
  if (!aUser || !bUser) return 'One of the employees no longer exists.';
  return (
    canTakeShift(db, schedule, bAssign, aUser, [aAssign]) ||
    canTakeShift(db, schedule, aAssign, bUser, [bAssign])
  );
}

// Both directions of a swap must be safe. On success the two assignments
// simply change owners.
function executeSwap(db, schedule, aAssign, bAssign) {
  const err = swapValid(db, schedule, aAssign, bAssign);
  if (err) return err;
  const tmp = aAssign.userId;
  aAssign.userId = bAssign.userId;
  bAssign.userId = tmp;
  refreshSchedule(db, schedule);
  return null;
}

// The candidate's future shifts that would form a valid swap against `offered`
// (owned by offeredUserId). Used to populate the UI's offer/partner pickers.
export function eligibleSwapShifts(db, schedule, offered, offeredUserId, candidateUserId) {
  const offeredAssign = findAssignment(schedule, offeredUserId, offered);
  if (!offeredAssign) return [];
  return schedule.assignments
    .filter((a) => a.userId === candidateUserId && isFuture(a.date))
    .filter((a) => !swapValid(db, schedule, offeredAssign, a))
    .map((a) => ({ date: a.date, shiftTypeId: a.shiftTypeId }));
}

// Everything the Trades screen needs to gate its actions for one viewer, in a
// single read: which of their shifts can answer each open swap, and whether
// they can claim each open giveaway.
export function tradeOptions(db, scheduleId, userId) {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return { respond: {}, claim: {} };
  const respond = {};
  const claim = {};
  for (const t of db.trades || []) {
    if (t.scheduleId !== scheduleId || t.status !== 'open') continue;
    if (t.type === 'open' && t.fromUserId !== userId) {
      respond[t.id] = eligibleSwapShifts(db, schedule, t.offered, t.fromUserId, userId);
    } else if (t.type === 'giveaway' && t.fromUserId !== userId) {
      const claimer = db.users.find((u) => u.id === userId);
      const reason = claimer ? canTakeShift(db, schedule, t.offered, claimer) : 'User not found.';
      claim[t.id] = { ok: !reason, reason: reason || null };
    }
  }
  return { respond, claim };
}

// Feasible partners for a proposed direct swap of `offered` (owned by userId):
// every other employee who has at least one shift forming a valid swap, with
// those shifts listed.
export function swapPartners(db, scheduleId, userId, offered) {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return [];
  const partners = [];
  for (const u of includedUsers(db, schedule)) {
    if (u.id === userId) continue;
    const shifts = eligibleSwapShifts(db, schedule, offered, userId, u.id);
    if (shifts.length) partners.push({ userId: u.id, shifts });
  }
  return partners;
}

// Would losing `offered` drop the giver below their requirement, counting the
// vacation already charged to them this schedule? (Weight-0 standby shifts
// never count, so giving one away never needs a day.)
function giveawayNeedsDay(db, schedule, giverId, offered) {
  const st = db.shiftTypes.find((s) => s.id === offered.shiftTypeId);
  const losesCount = st && weightOf(st, db.settings) > 0 ? 1 : 0;
  const after = countingShifts(db, schedule, giverId) - losesCount;
  const charged = schedule.vacationCharged?.[giverId] || 0;
  return after + charged < requiredFor(db, schedule, giverId);
}

function expire(db, trade, reason) {
  trade.status = 'expired';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `Your trade for ${slotLabel(db, trade.offered)} expired: ${reason}`, trade.id);
}

export function createTrade(db, { scheduleId, fromUserId, type, offered, toUserId, requested }) {
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

  const trade = {
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
    if (!requested || !findAssignment(schedule, toUserId, requested))
      return { error: `That shift doesn't belong to ${to.name}.`, code: 400 };
    if (!isFuture(requested.date))
      return { error: 'Only future shifts can be traded.', code: 400 };
    trade.toUserId = toUserId;
    trade.requested = { date: requested.date, shiftTypeId: requested.shiftTypeId };
    notify(db, toUserId, `${from.name} proposes swapping their ${slotLabel(db, trade.offered)} for your ${slotLabel(db, trade.requested)}.`, trade.id);
  } else if (type === 'giveaway') {
    // A vacation day is only needed when losing this shift drops the giver
    // below their requirement — and then only if they can afford it.
    if (giveawayNeedsDay(db, schedule, fromUserId, offered)) {
      const year = Number(schedule.startDate.slice(0, 4));
      if (vacationAvailable(db, from, year) <= 0)
        return {
          error: `Giving this shift up would use a vacation day and you have none left for ${year} — you must switch shifts instead.`,
          code: 400,
        };
    }
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

export function respondToOpenTrade(db, tradeId, { userId, date, shiftTypeId }) {
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
  const bad = swapValid(db, schedule, offeredAssign, myAssign);
  if (bad) return { error: `${bad} — you can't cover that shift.`, code: 400 };

  trade.responses = trade.responses.filter((r) => r.userId !== userId);
  trade.responses.push({ userId, date, shiftTypeId, at: new Date().toISOString() });
  notify(db, trade.fromUserId, `${userName(db, userId)} offered their ${slotLabel(db, slot)} for your ${slotLabel(db, trade.offered)}.`, trade.id);
  return { trade };
}

export function withdrawResponse(db, tradeId, { userId }) {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  trade.responses = trade.responses.filter((r) => r.userId !== userId);
  return { trade };
}

export function acceptOpenResponse(db, tradeId, { userId, responseUserId }) {
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

  const err = executeSwap(db, schedule, myAssign, theirAssign);
  if (err) return { error: err, code: 400 };

  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, resp.userId, `${userName(db, userId)} accepted your offer — you now work ${slotLabel(db, trade.offered)} and they took your ${slotLabel(db, resp)}.`, trade.id);
  for (const r of trade.responses) {
    if (r.userId !== responseUserId)
      notify(db, r.userId, `${userName(db, userId)}'s swap of ${slotLabel(db, trade.offered)} went to someone else.`, trade.id);
  }
  return { trade };
}

export function acceptDirect(db, tradeId, { userId }) {
  const trade = db.trades.find((t) => t.id === tradeId);
  if (!trade) return { error: 'Trade not found.', code: 404 };
  if (trade.type !== 'direct' || trade.status !== 'open')
    return { error: 'This proposal is no longer open.', code: 409 };
  if (userId !== trade.toUserId)
    return { error: 'This proposal was sent to someone else.', code: 403 };
  const schedule = db.schedules.find((s) => s.id === trade.scheduleId);
  if (!schedule) return { error: 'Schedule no longer exists.', code: 404 };

  const fromAssign = findAssignment(schedule, trade.fromUserId, trade.offered);
  const toAssign = findAssignment(schedule, trade.toUserId, trade.requested);
  if (!fromAssign || !toAssign || !isFuture(trade.offered.date) || !isFuture(trade.requested.date)) {
    expire(db, trade, 'one of the shifts changed hands or is in the past.');
    return { error: 'One of the shifts is no longer valid — proposal expired.', code: 409 };
  }

  const err = executeSwap(db, schedule, fromAssign, toAssign);
  if (err) return { error: err, code: 400 };

  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${userName(db, userId)} accepted your swap — you now work ${slotLabel(db, trade.requested)} and they took your ${slotLabel(db, trade.offered)}.`, trade.id);
  return { trade };
}

export function rejectDirect(db, tradeId, { userId }) {
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

export function claimGiveaway(db, tradeId, { userId }) {
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
    expire(db, trade, 'the shift changed hands or is in the past (vacation day refunded).');
    return { error: 'That shift is no longer available — giveaway expired.', code: 409 };
  }

  const err = canTakeShift(db, schedule, trade.offered, claimer);
  if (err) return { error: err, code: 400 };

  // Settle the giver's side before transferring: charge a vacation day if the
  // loss drops them below required, and trim their extra-day election if
  // their extra shrinks (incentive first). Block when either step would push
  // their year's balance negative.
  const giver = db.users.find((u) => u.id === trade.fromUserId);
  const year = Number(schedule.startDate.slice(0, 4));
  const needsDay = giveawayNeedsDay(db, schedule, trade.fromUserId, trade.offered);
  const st = db.shiftTypes.find((s) => s.id === trade.offered.shiftTypeId);
  const losesCount = st && weightOf(st, db.settings) > 0 ? 1 : 0;
  const predictedExtra = Math.max(
    0,
    countingShifts(db, schedule, trade.fromUserId) - losesCount +
      (schedule.vacationCharged?.[trade.fromUserId] || 0) + (needsDay ? 1 : 0) -
      requiredFor(db, schedule, trade.fromUserId)
  );
  const el = schedule.extraElections?.[trade.fromUserId];
  const electedSum = el ? el.vacation + el.incentive : 0;
  const over = Math.max(0, electedSum - predictedExtra);
  const vacTrim = el ? Math.max(0, over - el.incentive) : 0;
  if (vacationAvailable(db, giver, year) - (needsDay ? 1 : 0) - vacTrim < 0) {
    expire(db, trade, `${giver.name} can no longer cover the vacation day it requires.`);
    return { error: 'The giver can no longer afford this giveaway — it has expired.', code: 409 };
  }
  if (needsDay) {
    schedule.vacationCharged ??= {};
    schedule.vacationCharged[trade.fromUserId] =
      (schedule.vacationCharged[trade.fromUserId] || 0) + 1;
  }
  if (el && over > 0) {
    const incCut = Math.min(over, el.incentive);
    el.incentive -= incCut;
    el.vacation -= over - incCut;
  }

  assign.userId = userId;
  refreshSchedule(db, schedule);
  trade.claimedBy = userId;
  trade.status = 'completed';
  trade.resolvedAt = new Date().toISOString();
  notify(db, trade.fromUserId, `${claimer.name} picked up your ${slotLabel(db, trade.offered)}. Enjoy the day off!`, trade.id);
  return { trade };
}

export function cancelTrade(db, tradeId, { userId }) {
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
  // A cancelled giveaway stops counting against vacation (see vacationUsed).
  return { trade };
}

// Split a user's extra days (worked or charged beyond required) between
// extra vacation (credits the year's allowance) and incentive pay (HR pays
// out). The new split replaces the previous one; total may not exceed the
// current extra, and lowering an elected vacation amount may not push the
// year's balance negative (those days may already be spent).
export function setExtraElection(db, scheduleId, { userId, vacation, incentive }) {
  const schedule = db.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return { error: 'Schedule not found.', code: 404 };
  const user = db.users.find((u) => u.id === userId);
  if (!user) return { error: 'User not found.', code: 404 };
  const vac = Math.max(0, Math.floor(Number(vacation) || 0));
  const inc = Math.max(0, Math.floor(Number(incentive) || 0));
  const extra = extraDays(db, schedule, userId);
  if (vac + inc > extra)
    return {
      error: `Only ${extra} extra day${extra === 1 ? '' : 's'} available to allocate.`,
      code: 400,
    };
  const year = Number(schedule.startDate.slice(0, 4));
  const prev = schedule.extraElections?.[userId]?.vacation || 0;
  if (vac < prev && vacationAvailable(db, user, year) - (prev - vac) < 0)
    return { error: 'You have already used the vacation days earned from those extra days.', code: 400 };
  schedule.extraElections ??= {};
  schedule.extraElections[userId] = { vacation: vac, incentive: inc };
  return { election: schedule.extraElections[userId] };
}

// Extra shifts picked up per schedule, derived from completed giveaways.
export function extraShifts(db, scheduleId) {
  const out = {};
  for (const t of db.trades || []) {
    if (t.type === 'giveaway' && t.status === 'completed' && t.scheduleId === scheduleId && t.claimedBy) {
      out[t.claimedBy] = (out[t.claimedBy] || 0) + 1;
    }
  }
  return out;
}
