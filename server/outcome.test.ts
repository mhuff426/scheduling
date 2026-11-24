// Smoke test: tsx server/outcome.test.ts
// The route adapter against an in-memory stand-in for withMutation that
// commits what the callback changed only when it returns (a throw rolls back),
// the way the MySQL transaction does.
import assert from 'assert';
import { ok, refuse, unconfirmed, runCommand, type Mutate } from './outcome.js';
import type { Db, User } from '../shared/types.js';

const ann: User = { id: 'a', name: 'Ann', roles: ['role-employee'], vacationDays: 10, color: '#888' };
const mkDb = (): Db => ({
  users: [ann], roles: [], shiftTypes: [], settings: { maxVacationPerDay: 2 }, timeOff: [],
  schedules: [], trades: [], notifications: [], awayTime: [], holidays: [], meta: { rotationCursor: 0 },
});

// Holds the committed data; each mutation works on a copy.
function memoryStore(db: Db) {
  const store = { db };
  const mutate: Mutate = async (fn) => {
    const draft = structuredClone(store.db);
    const result = await fn(draft);
    store.db = draft;
    return result;
  };
  return { store, mutate };
}
const TODAY = '2050-06-01';
const note = (db: Db, message: string) =>
  db.notifications.push({ id: 'n1', userId: 'a', message, tradeId: 't', read: false, createdAt: '' });

async function main() {
  // ---- success: commits and sends the value with 200; the command sees the actor and today ----
  {
    const { store, mutate } = memoryStore(mkDb());
    const res = await runCommand(mutate, 'a', TODAY, (db, ctx) => {
      note(db, `${ctx.actor.name} ${ctx.today}`);
      return ok({ done: true });
    });
    assert.deepStrictEqual(res, { status: 200, body: { done: true } });
    assert.deepStrictEqual(store.db.notifications.map((n) => n.message), ['Ann 2050-06-01']);
  }

  // ---- a refusal without persist rolls back what the command changed ----
  {
    const { store, mutate } = memoryStore(mkDb());
    const res = await runCommand(mutate, 'a', TODAY, (db) => {
      note(db, 'half a change');
      return refuse('invalid', 'Nope.');
    });
    assert.deepStrictEqual(res, { status: 400, body: { error: 'Nope.' } });
    assert.deepStrictEqual(store.db.notifications, [], 'rolled back');
  }

  // ---- a refusal with persist keeps the change ----
  {
    const { store, mutate } = memoryStore(mkDb());
    const res = await runCommand(mutate, 'a', TODAY, (db) => {
      note(db, 'expired');
      return refuse('conflict', 'Expired.', { persist: true });
    });
    assert.deepStrictEqual(res, { status: 409, body: { error: 'Expired.', code: 'conflict' } });
    assert.strictEqual(store.db.notifications.length, 1, 'persisted');
  }

  // ---- no session user, or one no longer in the data: unauthenticated, command never runs ----
  for (const actorId of [null, 'ghost']) {
    const { mutate } = memoryStore(mkDb());
    let ran = false;
    const res = await runCommand(mutate, actorId, TODAY, () => { ran = true; return ok(1); });
    assert.deepStrictEqual(res, { status: 401, body: { error: 'Please log in.', code: 'unauthenticated' } });
    assert.ok(!ran);
  }

  // ---- each reason maps to its status and wire code ----
  {
    const { mutate } = memoryStore(mkDb());
    const send = (o: ReturnType<typeof refuse>) => runCommand(mutate, 'a', TODAY, () => o);
    assert.deepStrictEqual(await send(refuse('forbidden', 'F.')), { status: 403, body: { error: 'F.' } });
    assert.deepStrictEqual(await send(refuse('not_found', 'N.')), { status: 404, body: { error: 'N.' } });
    assert.deepStrictEqual(await send(refuse('stale', 'S.')), { status: 409, body: { error: 'S.', code: 'version_conflict' } });
    const warnings = [{ kind: 'must-off day' as const, message: 'Ann asked for this day off.' }];
    assert.deepStrictEqual(await send(unconfirmed(warnings)), {
      status: 409, body: { error: 'Ann asked for this day off.', code: 'eligibility_warnings', warnings },
    });
  }

  // ---- a thrown error is not a refusal: it propagates (500/503 upstream) ----
  {
    const { mutate } = memoryStore(mkDb());
    await assert.rejects(runCommand(mutate, 'a', TODAY, () => { throw new Error('boom'); }), /boom/);
  }

  console.log('outcome tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
