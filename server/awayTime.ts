// Away-time commands (ADR 0003): create, edit and delete, for whoever can
// manage away time. Away time never counts against vacation.
import { newId } from './db.js';
import { ok, refuse, requireCan, type CommandContext, type Outcome } from './outcome.js';
import { staleRefusal, bumpVersion } from './staleness.js';
import { isDate } from '../shared/blocks.js';
import type { AwayTime, Db } from '../shared/types.js';

const NOT_FOUND = 'Away time not found.';
const BAD_DATES = 'Away time needs a valid start and end date.';
const END_BEFORE_START = 'The away end date must be on or after the start date.';

// Optional free-text fields: `label` is shown to the employee (calendar chip,
// away card); `memo` (the away memo) is an admin-only note. Trimmed and cut to
// a limit; blank collapses to absent.
const LABEL_MAX = 255;
const MEMO_MAX = 10000;
const awayText = (v: unknown, max: number): string | undefined => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || undefined;
};

function checkRange(start: unknown, end: unknown) {
  if (!isDate(start) || !isDate(end)) return refuse('invalid', BAD_DATES);
  if (end < start) return refuse('invalid', END_BEFORE_START);
  return null;
}

type AwayInput = { start?: unknown; end?: unknown; label?: unknown; memo?: unknown };

export function createAwayTime(
  db: Db, { actor }: CommandContext, input: AwayInput & { userId?: unknown }
): Outcome<AwayTime> {
  const no = requireCan(actor, 'manageAwayTime');
  if (no) return no;
  const { userId, start, end } = input;
  const user = db.users.find((u) => u.id === userId);
  if (!user) return refuse('not_found', 'User not found.');
  const bad = checkRange(start, end);
  if (bad) return bad;
  const label = awayText(input.label, LABEL_MAX);
  const memo = awayText(input.memo, MEMO_MAX);
  const e: AwayTime = {
    id: newId('aw'), userId: user.id, start: start as string, end: end as string,
    ...(label ? { label } : {}),
    ...(memo ? { memo } : {}),
  };
  db.awayTime.push(e);
  return ok(e);
}

/** Changes only the fields sent; a blank label or memo sent clears it. */
export function editAwayTime(
  db: Db, { actor }: CommandContext, input: AwayInput & { id: string; expectedVersion?: unknown }
): Outcome<AwayTime> {
  const no = requireCan(actor, 'manageAwayTime');
  if (no) return no;
  const entry = db.awayTime.find((a) => a.id === input.id);
  if (!entry) return refuse('not_found', NOT_FOUND);
  const stale = staleRefusal(entry, input.expectedVersion, 'This away-time range');
  if (stale) return stale;
  const start = input.start !== undefined ? input.start : entry.start;
  const end = input.end !== undefined ? input.end : entry.end;
  const bad = checkRange(start, end);
  if (bad) return bad;
  entry.start = start as string;
  entry.end = end as string;
  if (input.label !== undefined) entry.label = awayText(input.label, LABEL_MAX);
  if (input.memo !== undefined) entry.memo = awayText(input.memo, MEMO_MAX);
  bumpVersion(entry);
  return ok(entry);
}

export function deleteAwayTime(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  const no = requireCan(actor, 'manageAwayTime');
  if (no) return no;
  const idx = db.awayTime.findIndex((a) => a.id === id);
  if (idx === -1) return refuse('not_found', NOT_FOUND);
  db.awayTime.splice(idx, 1);
  return ok({ ok: true as const });
}
