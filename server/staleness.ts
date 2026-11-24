// Optimistic concurrency for commands: clients echo the `version` they read
// as `expectedVersion`; a mismatch means someone else changed the record
// since. Absent expectedVersion skips the check (curl / legacy callers).
import { refuse, type Refused } from './outcome.js';

/** A `stale` refusal naming `what`, or null when the version matches. */
export function staleRefusal(entity: { version?: number }, expected: unknown, what: string): Refused | null {
  if (expected === undefined || Number(expected) === (entity.version ?? 1)) return null;
  return refuse('stale', `${what} was changed by someone else — the view has been refreshed with the latest data. Please retry.`);
}

export const bumpVersion = (entity: { version?: number }) => {
  entity.version = (entity.version ?? 1) + 1;
};
