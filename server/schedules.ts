// Schedule commands: build a schedule for a schedule block, reassign one of
// its shifts, delete it. All three need the build-schedules capability.
//
// Each command takes the data, a context of { actor, today } and its input,
// and returns an Outcome (./outcome.ts, ADR 0003). Commands mutate the passed
// db but never persist: the route adapter runs them in a transaction, and a
// refusal rolls it back.

import { newId } from './db.js';
import { generateSchedule, summarizeSchedule } from './scheduler.js';
import { ADMIN_REASSIGN_POLICY, needsConfirmation, parseConfirmedWarnings, scheduleEligibility } from './eligibility.js';
import { ok, refuse, requireCan, unconfirmed, type CommandContext, type Outcome } from './outcome.js';
import { blockRange, currentBlockIndex } from '../shared/blocks.js';
import type { Db, Schedule } from '../shared/types.js';

// How many blocks the selectable window offers: the current one and the next 4.
const SELECTABLE_BLOCKS = 5;

/**
 * Builds the schedule for schedule block `blockIndex`, which must be in the
 * selectable window and not already have a schedule. `userIds` picks who is
 * included (everyone when absent; unknown ids dropped). Moves the rotation
 * cursor forward.
 */
export function buildSchedule(
  db: Db, { actor, today }: CommandContext, input: { blockIndex: unknown; userIds?: unknown }
): Outcome<Schedule> {
  const no = requireCan(actor, 'buildSchedules');
  if (no) return no;
  const cadence = db.settings.cadence;
  if (!cadence) return refuse('invalid', 'Configure a schedule cadence in Settings first.');
  if (db.shiftTypes.length === 0) return refuse('invalid', 'Configure at least one shift type first.');
  // (No "empty roster" check: the actor is always on the roster.)
  const blockIndex = Number(input.blockIndex);
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return refuse('invalid', 'Pick a schedule block.');
  const firstBlock = currentBlockIndex(cadence, today);
  if (blockIndex < firstBlock || blockIndex >= firstBlock + SELECTABLE_BLOCKS)
    return refuse('invalid', 'That block is outside the selectable window.');
  const { startDate, endDate } = blockRange(cadence, blockIndex);
  // Checked under the transaction's lock (plus a UNIQUE(start_date) backstop in
  // the schema), so two admins building the same block can't both win.
  if (db.schedules.some((s) => s.startDate === startDate))
    return refuse('invalid', 'A schedule for this block already exists — delete it first to regenerate.');

  const requested = Array.isArray(input.userIds) ? (input.userIds as string[]) : null;
  const userIds = (requested || db.users.map((u) => u.id)).filter((id) => db.users.some((u) => u.id === id));
  if (userIds.length === 0) return refuse('invalid', 'Include at least one person in the block.');

  const { nextRotationCursor, ...result } = generateSchedule(db, { startDate, endDate, userIds });
  const schedule: Schedule = {
    id: newId('sch'),
    startDate,
    endDate,
    userIds,
    createdAt: new Date().toISOString(),
    extraElections: {},
    ...result,
  };
  db.schedules.push(schedule);
  db.meta.rotationCursor = nextRotationCursor;
  return ok(schedule);
}

export interface ReassignInput {
  id: string;                 // the schedule
  date: string;
  shiftTypeId: string;
  fromUserId?: string | null; // absent: fill an open shift
  toUserId?: string | null;   // absent: unassign back to open
  confirmedWarnings?: unknown; // the warning messages the admin confirmed
}

/**
 * Manual assignment editing: fill an open shift, hand a shift to someone else,
 * or unassign it back to open. Checked with the admin reassign policy (ADR
 * 0001): hard rules and affordable must-off days block; an unaffordable
 * must-off day, the shift maximum and the consecutive-night limit warn the
 * admin, who confirms. Re-summarizes the schedule's counts and warnings.
 */
export function reassignShift(db: Db, { actor }: CommandContext, input: ReassignInput): Outcome<Schedule> {
  const no = requireCan(actor, 'buildSchedules');
  if (no) return no;
  const schedule = db.schedules.find((s) => s.id === input.id);
  if (!schedule) return refuse('not_found', 'Schedule not found.');
  const { date, shiftTypeId, fromUserId, toUserId } = input;
  const confirmedWarnings = parseConfirmedWarnings(input.confirmedWarnings);
  if (!db.shiftTypes.some((s) => s.id === shiftTypeId)) return refuse('invalid', 'Shift type no longer exists.');

  if (toUserId) {
    const to = db.users.find((u) => u.id === toUserId);
    if (!to) return refuse('not_found', 'Employee not found.');
    const moving = fromUserId
      ? schedule.assignments.find((a) => a.date === date && a.shiftTypeId === shiftTypeId && a.userId === fromUserId)
      : null;
    const r = scheduleEligibility(db, schedule, { date, shiftTypeId }, to, ADMIN_REASSIGN_POLICY, moving ? [moving] : []);
    if (!r.eligible) return refuse('invalid', r.reason);
    if (needsConfirmation(r.warnings, confirmedWarnings)) return unconfirmed(r.warnings);
  }

  if (!fromUserId) {
    if (!toUserId) return refuse('invalid', 'Pick an employee for the open shift.');
    const idx = schedule.unfilled.findIndex((s) => s.date === date && s.shiftTypeId === shiftTypeId);
    if (idx === -1) return refuse('not_found', 'Open shift not found.');
    schedule.unfilled.splice(idx, 1);
    schedule.assignments.push({ date, shiftTypeId, userId: toUserId });
  } else {
    const a = schedule.assignments.find(
      (x) => x.date === date && x.shiftTypeId === shiftTypeId && x.userId === fromUserId
    );
    if (!a) return refuse('not_found', 'Assignment not found.');
    if (toUserId) {
      a.userId = toUserId;
    } else {
      schedule.assignments.splice(schedule.assignments.indexOf(a), 1);
      schedule.unfilled.push({ date, shiftTypeId });
    }
  }

  const { counts, warnings } = summarizeSchedule(db, schedule);
  schedule.counts = counts;
  schedule.warnings = warnings;
  return ok(schedule);
}

/** Removes a schedule. */
export function deleteSchedule(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  const no = requireCan(actor, 'buildSchedules');
  if (no) return no;
  const idx = db.schedules.findIndex((s) => s.id === id);
  if (idx === -1) return refuse('not_found', 'Schedule not found.');
  db.schedules.splice(idx, 1);
  return ok({ ok: true });
}
