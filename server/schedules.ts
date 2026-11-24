// Schedule commands: build a schedule for a schedule block, reassign one of
// its shifts, delete it. All three need the build-schedules capability.
//
// Each command takes the data, a context of { actor, today } and its input,
// and returns an Outcome (./outcome.ts, ADR 0003). Commands mutate the passed
// db but never persist: the route adapter runs them in a transaction, and a
// refusal rolls it back.

import { newId } from './db.js';
import { can } from './capabilities.js';
import { generateSchedule } from './scheduler.js';
import { ok, refuse, type CommandContext, type Outcome } from './outcome.js';
import { blockRange, currentBlockIndex } from '../shared/blocks.js';
import type { Db, Schedule } from '../shared/types.js';

const forbidden = () => refuse('forbidden', 'Admin access required.');

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
  if (!can(actor, 'buildSchedules')) return forbidden();
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
