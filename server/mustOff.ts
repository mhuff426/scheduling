// Must-off request commands (ADR 0003). A person requests days off only for
// themselves; see GLOSSARY.md "Must-off day" and "Full day".
import { newId, vacationCountForDate } from './db.js';
import { ok, refuse, requireCan, type CommandContext, type Outcome } from './outcome.js';
import { isDate } from '../shared/blocks.js';
import type { Db, TimeOff } from '../shared/types.js';

/** Requests `date` off for the actor. Any client-sent userId is ignored. */
export function requestMustOff(
  db: Db, { actor }: CommandContext, { date, type }: { date?: unknown; type?: unknown }
): Outcome<TimeOff> {
  if (!isDate(date)) return refuse('invalid', 'Invalid date.');
  if (type !== 'vacation' && type !== 'preferred')
    return refuse('invalid', 'Type must be vacation or preferred.');
  if (db.timeOff.some((t) => t.userId === actor.id && t.date === date))
    return refuse('conflict', 'You already have a request on that day. Remove it first.');
  // Must-off requests are free at request time: vacation is charged only
  // after a schedule is generated. The per-day cap protects coverage; it runs
  // against fresh state under the write lock, so concurrent requests can't
  // slip past it. Say only that the day is full: on a small team a headcount
  // points to people (ADR 0002).
  if (type === 'vacation' && vacationCountForDate(db, date as string) >= db.settings.maxVacationPerDay)
    return refuse('invalid', 'That day is full. Pick another day.');
  const entry: TimeOff = { id: newId('t'), userId: actor.id, date: date as string, type };
  db.timeOff.push(entry);
  return ok(entry);
}

/** Withdraws request `id`: the actor's own, or anyone's with manage others' time off. */
export function withdrawMustOff(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  const idx = db.timeOff.findIndex((t) => t.id === id);
  if (idx === -1) return refuse('not_found', 'Request not found.');
  if (db.timeOff[idx].userId !== actor.id) {
    const no = requireCan(actor, 'manageOthersTimeOff', 'You can only delete your own time-off requests.');
    if (no) return no;
  }
  db.timeOff.splice(idx, 1);
  return ok({ ok: true });
}