// The command outcome convention (ADR 0003). A domain command takes the data,
// a context of { actor, today } and its input, and returns an Outcome: a
// success carrying a value, or a refusal with a reason. Commands never mention
// HTTP; `runCommand` is the one adapter that runs a command in a transaction
// and turns its outcome into a status and a body.
//
// A refusal rolls the transaction back, unless it sets `persist: true` (the
// command means to keep what it changed, as trade expiry does). A thrown error
// is a bug or an infrastructure failure, never a refusal.
import { confirmationRefusal, CONFIRM_WARNINGS_CODE, type EligibilityWarning } from '../shared/confirmation.js';
import type { Db, User } from '../shared/types.js';
import type { Refusal } from './projection.js';
import { can, type Capability } from './capabilities.js';

// The projection's read refusals, plus the ones only writes produce.
export type Reason = Refusal | 'invalid' | 'conflict' | 'stale' | 'unconfirmed';

export interface CommandRefusal {
  reason: Reason;
  message: string;
  warnings?: EligibilityWarning[]; // set by `unconfirmed`
  persist?: true;                   // keep the command's changes despite refusing
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: CommandRefusal };
export type Refused = Extract<Outcome<never>, { ok: false }>;

/** Who is acting and what day it is, worked out once by the route. */
export interface CommandContext {
  actor: User;
  today: string; // YYYY-MM-DD, from todayYmd() in shared/blocks.ts
}

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

export const refuse = (
  reason: Reason, message: string, extra: { persist?: true } = {}
): Refused => ({ ok: false, refusal: { reason, message, ...extra } });

/** The confirmation contract's refusal (ADR 0001): resend confirming these warnings. */
export const unconfirmed = (warnings: EligibilityWarning[]): Refused =>
  ({ ok: false, refusal: { reason: 'unconfirmed', message: confirmationRefusal(warnings).error, warnings } });

/** The one capability guard: null when `actor` may, else a forbidden refusal. */
export const requireCan = (
  actor: User, capability: Capability, message = 'Admin access required.'
): Refused | null => (can(actor, capability) ? null : refuse('forbidden', message));

/** The success value transformed, or the refusal passed through. */
export const mapOutcome = <T, U>(o: Outcome<T>, f: (value: T) => U): Outcome<U> =>
  o.ok ? ok(f(o.value)) : o;

// ---- the HTTP mapping: one place ----

export const STATUS: Record<Reason, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  stale: 409,
  unconfirmed: 409,
};

// The `code` field the client reads, where a reason has one.
const WIRE_CODE: Partial<Record<Reason, string>> = {
  unauthenticated: 'unauthenticated',
  conflict: 'conflict',
  stale: 'version_conflict',
  unconfirmed: CONFIRM_WARNINGS_CODE,
};

export interface CommandResponse { status: number; body: unknown }

export function refusalResponse({ reason, message, warnings }: CommandRefusal): CommandResponse {
  const code = WIRE_CODE[reason];
  return {
    status: STATUS[reason],
    body: { error: message, ...(code ? { code } : {}), ...(warnings ? { warnings } : {}) },
  };
}

// ---- the route adapter ----

/** withMutation's shape: runs fn in a transaction, committing unless it throws. */
export type Mutate = <T>(fn: (db: Db) => T | Promise<T>) => Promise<T>;

export type Command<T> = (db: Db, ctx: CommandContext) => Outcome<T>;

// Thrown inside the transaction to roll a refusal back.
class Rollback extends Error {
  constructor(public refusal: CommandRefusal) { super(refusal.message); }
}

/**
 * Runs `command` as the session user (`actorId`) inside `mutate`. No actor in
 * the data refuses as unauthenticated before the command runs. A refusal
 * without `persist` rolls back. Returns the status and body to send; a
 * success's body is its value, or what `afterCommit` makes of it.
 *
 * `afterCommit` runs only once a success has committed, outside the
 * transaction: work that must not happen for a refused or rolled-back command
 * (credential rows, invites, auth-table cleanup). It may shape the response.
 */
export async function runCommand<T>(
  mutate: Mutate, actorId: string | null | undefined, today: string, command: Command<T>,
  afterCommit: (value: T) => unknown = (value) => value
): Promise<CommandResponse> {
  try {
    const outcome = await mutate((db) => {
      const actor = actorId ? db.users.find((u) => u.id === actorId) : undefined;
      if (!actor) throw new Rollback(refuse('unauthenticated', 'Please log in.').refusal);
      const o = command(db, { actor, today });
      if (!o.ok && !o.refusal.persist) throw new Rollback(o.refusal);
      return o;
    });
    return outcome.ok ? { status: 200, body: await afterCommit(outcome.value) } : refusalResponse(outcome.refusal);
  } catch (e) {
    if (e instanceof Rollback) return refusalResponse(e.refusal);
    throw e;
  }
}
