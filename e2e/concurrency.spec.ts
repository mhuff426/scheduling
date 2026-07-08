import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Exercises the concurrency guarantees at the API level (Playwright `request`
// fixture — no UI): stale trade actions get clear 409s, entity edits carry
// optimistic versions, check-then-insert races are serialized by the global
// write lock, and per-tab payloads contain exactly their collections (users
// and notifications live on their own endpoints).
//
// The seed adds a far-future schedule (2099) so trades are always "future".
// Users: u-admin, u-bea, u-cy (see seed.json); shift types s-day, s-eve.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

const A = (userId: string, date: string, shiftTypeId: string) => ({ userId, date, shiftTypeId });
const schedule = {
  id: 'sch-2099',
  createdAt: '2099-01-01T00:00:00.000Z',
  startDate: '2099-01-01',
  endDate: '2099-01-31',
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  assignments: [
    A('u-admin', '2099-01-05', 's-day'),
    A('u-bea', '2099-01-10', 's-day'),
    A('u-cy', '2099-01-12', 's-day'),
  ],
  unfilled: [],
  counts: {},
  warnings: [],
};

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', {
    data: { ...SEED, schedules: [schedule] },
  });
  expect(res.ok()).toBeTruthy();
});

const post = (request, url: string, data: unknown) => request.post(url, { data });

// The server now derives the acting user from the session (httpOnly `sid`
// cookie), overriding any client-sent userId/fromUserId. The default `request`
// fixture carries no cookie, so under E2E_TESTING it is auto-authenticated as
// the first admin (u-admin) — fine for reset/admin/system-level calls. To act
// as a different user we mint a real session via /api/dev/impersonate on a
// fresh APIRequestContext (its own cookie jar). Contexts must be created INSIDE
// each test, after the beforeEach reset wipes the sessions table.
const impersonate = async (playwright, userId: string) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });
  const r = await ctx.post('/api/dev/impersonate', { data: { userId } });
  expect(r.ok()).toBeTruthy();
  return ctx;
};

test('a giveaway can only be claimed once — the loser gets a clear 409', async ({ request, playwright }) => {
  // Giveaway created by the admin (default context).
  const created = await post(request, '/api/trades', {
    scheduleId: 'sch-2099', type: 'giveaway',
    offered: { date: '2099-01-05', shiftTypeId: 's-day' },
  });
  expect(created.ok()).toBeTruthy();
  const trade = await created.json();

  const bea = await impersonate(playwright, 'u-bea');
  const cy = await impersonate(playwright, 'u-cy');

  const first = await bea.post(`/api/trades/${trade.id}/claim`, { data: {} });
  expect(first.ok()).toBeTruthy();

  // User C acts on a stale view — the giveaway is already gone.
  const second = await cy.post(`/api/trades/${trade.id}/claim`, { data: {} });
  expect(second.status()).toBe(409);
  const body = await second.json();
  expect(body.error).toContain('already been claimed');

  await bea.dispose();
  await cy.dispose();
});

test('accepting a trade that was cancelled meanwhile returns a clear 409', async ({ request, playwright }) => {
  // Created and cancelled by the owner (admin, default context).
  const created = await post(request, '/api/trades', {
    scheduleId: 'sch-2099', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 's-day' },
    toUserId: 'u-bea', requested: { date: '2099-01-10', shiftTypeId: 's-day' },
  });
  expect(created.ok()).toBeTruthy();
  const trade = await created.json();

  expect((await post(request, `/api/trades/${trade.id}/cancel`, {})).ok()).toBeTruthy();

  // The recipient (u-bea) accepts a proposal that's already gone.
  const bea = await impersonate(playwright, 'u-bea');
  const accept = await bea.post(`/api/trades/${trade.id}/accept`, { data: {} });
  expect(accept.status()).toBe(409);
  expect((await accept.json()).error).toContain('no longer open');
  await bea.dispose();
});

test('duplicate open trade for the same shift is rejected', async ({ request }) => {
  const body = {
    scheduleId: 'sch-2099', fromUserId: 'u-admin', type: 'open',
    offered: { date: '2099-01-05', shiftTypeId: 's-day' },
  };
  expect((await post(request, '/api/trades', body)).ok()).toBeTruthy();
  const dup = await post(request, '/api/trades', body);
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toContain('already have an open trade');
});

test('entity edits are version-checked: stale writes get 409 version_conflict', async ({ request }) => {
  const first = await request.put('/api/users/u-bea', {
    data: { vacationDays: 12, expectedVersion: 1 },
  });
  expect(first.ok()).toBeTruthy();
  expect((await first.json()).version).toBe(2);

  // Another admin still holds version 1 — their write must not clobber.
  const stale = await request.put('/api/users/u-bea', {
    data: { vacationDays: 3, expectedVersion: 1 },
  });
  expect(stale.status()).toBe(409);
  const body = await stale.json();
  expect(body.code).toBe('version_conflict');

  const { users } = await (await request.get('/api/users')).json();
  expect(users.find((u) => u.id === 'u-bea').vacationDays).toBe(12);
});

test('the per-day vacation cap holds under sequential and stale submissions', async ({ request, playwright }) => {
  // Seed cap is 2 per day. Each request is a DIFFERENT user (server derives the
  // owner from the session), so the cap — not the one-request-per-day guard —
  // is what rejects the third. `userId` in the body is ignored; only date/type.
  const bea = await impersonate(playwright, 'u-bea');
  const cy = await impersonate(playwright, 'u-cy');

  expect((await post(request, '/api/timeoff', { date: '2099-02-01', type: 'vacation' })).ok()).toBeTruthy();
  expect((await bea.post('/api/timeoff', { data: { date: '2099-02-01', type: 'vacation' } })).ok()).toBeTruthy();
  const third = await cy.post('/api/timeoff', { data: { date: '2099-02-01', type: 'vacation' } });
  expect(third.status()).toBe(400);
  expect((await third.json()).error).toContain('full');

  await bea.dispose();
  await cy.dispose();
});

test('parallel writes are serialized — no lost updates', async ({ request, playwright }) => {
  // 10 simultaneous inserts; each mutation rewrites the timeOff collection,
  // so any lost update would show as a missing row. All are u-cy (one session).
  const cy = await impersonate(playwright, 'u-cy');
  const dates = Array.from({ length: 10 }, (_, i) => `2099-03-${String(i + 1).padStart(2, '0')}`);
  const results = await Promise.all(
    dates.map((date) => cy.post('/api/timeoff', { data: { date, type: 'preferred' } }))
  );
  for (const r of results) expect(r.ok()).toBeTruthy();

  const state = await (await request.get('/api/state')).json();
  const mine = state.timeOff.filter((t) => t.userId === 'u-cy');
  expect(mine.length).toBe(10);

  await cy.dispose();
});

test('tab payloads carry only their collections; users/notifications have their own endpoints', async ({ request }) => {
  const trades = await (await request.get('/api/tabs/trades')).json();
  expect(trades.trades).toBeDefined();
  expect(trades.schedules.length).toBe(1);
  expect(trades.shiftTypes.length).toBe(2);
  expect(trades.users).toEqual([]);          // not bundled — own endpoint
  expect(trades.notifications).toEqual([]);  // not bundled — own endpoint
  expect(trades.timeOff).toEqual([]);        // not part of this tab

  const prefs = await (await request.get('/api/tabs/preferences')).json();
  expect(prefs.timeOff).toBeDefined();
  expect(prefs.settings.maxVacationPerDay).toBe(2);
  expect(prefs.trades).toEqual([]);

  const { users } = await (await request.get('/api/users')).json();
  expect(users.length).toBe(3);

  const { notifications } = await (await request.get('/api/notifications?userId=u-bea')).json();
  expect(Array.isArray(notifications)).toBeTruthy();

  expect((await request.get('/api/tabs/bogus')).status()).toBe(404);
});
