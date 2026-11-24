// Holiday commands (ADR 0003): create, edit and delete, for whoever can
// configure scheduling.
import { newId } from './db.js';
import { ok, refuse, requireCan, type CommandContext, type Outcome } from './outcome.js';
import { staleRefusal, bumpVersion } from './staleness.js';
import { isValidRecurrence } from '../shared/holidays.js';
import type { Db, Holiday } from '../shared/types.js';

const NOT_FOUND = 'Holiday not found.';
const NEEDS_NAME = 'A holiday needs a name.';
const NEEDS_RECURRENCE = 'A holiday needs a valid recurrence.';

const isName = (v: unknown): v is string => !!v && typeof v === 'string';

export function createHoliday(
  db: Db, { actor }: CommandContext, input: { name?: unknown; recurrence?: unknown; workable?: unknown }
): Outcome<Holiday> {
  const no = requireCan(actor, 'configureScheduling');
  if (no) return no;
  const { name, recurrence } = input;
  if (!isName(name)) return refuse('invalid', NEEDS_NAME);
  if (!isValidRecurrence(recurrence)) return refuse('invalid', NEEDS_RECURRENCE);
  const e: Holiday = { id: newId('hol'), name: name.trim(), workable: !!input.workable, recurrence };
  db.holidays.push(e);
  return ok(e);
}

/** Changes only the fields sent. */
export function editHoliday(
  db: Db, { actor }: CommandContext,
  input: { id: string; expectedVersion?: unknown; name?: unknown; recurrence?: unknown; workable?: unknown }
): Outcome<Holiday> {
  const no = requireCan(actor, 'configureScheduling');
  if (no) return no;
  const entry = db.holidays.find((h) => h.id === input.id);
  if (!entry) return refuse('not_found', NOT_FOUND);
  const stale = staleRefusal(entry, input.expectedVersion, `The holiday "${entry.name}"`);
  if (stale) return stale;
  if (input.name !== undefined) {
    if (!isName(input.name)) return refuse('invalid', NEEDS_NAME);
    entry.name = input.name.trim();
  }
  if (input.recurrence !== undefined) {
    if (!isValidRecurrence(input.recurrence)) return refuse('invalid', NEEDS_RECURRENCE);
    entry.recurrence = input.recurrence;
  }
  if (input.workable !== undefined) entry.workable = !!input.workable;
  bumpVersion(entry);
  return ok(entry);
}

export function deleteHoliday(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  const no = requireCan(actor, 'configureScheduling');
  if (no) return no;
  const idx = db.holidays.findIndex((h) => h.id === id);
  if (idx === -1) return refuse('not_found', NOT_FOUND);
  db.holidays.splice(idx, 1);
  return ok({ ok: true as const });
}
