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

test('a giveaway can only be claimed once — the loser gets a clear 409', async ({ request }) => {
  const created = await post(request, '/api/trades', {
    scheduleId: 'sch-2099', fromUserId: 'u-admin', type: 'giveaway',
    offered: { date: '2099-01-05', shiftTypeId: 's-day' },
  });
  expect(created.ok()).toBeTruthy();
  const trade = await created.json();

  const first = await post(request, `/api/trades/${trade.id}/claim`, { userId: 'u-bea' });
  expect(first.ok()).toBeTruthy();

  // User C acts on a stale view — the giveaway is already gone.
  const second = await post(request, `/api/trades/${trade.id}/claim`, { userId: 'u-cy' });
  expect(second.status()).toBe(409);
  const body = await second.json();
  expect(body.error).toContain('already been claimed');
});

test('accepting a trade that was cancelled meanwhile returns a clear 409', async ({ request }) => {
  const created = await post(request, '/api/trades', {
    scheduleId: 'sch-2099', fromUserId: 'u-admin', type: 'direct',
    offered: { date: '2099-01-05', shiftTypeId: 's-day' },
    toUserId: 'u-bea', requested: { date: '2099-01-10', shiftTypeId: 's-day' },
  });
  expect(created.ok()).toBeTruthy();
  const trade = await created.json();

  expect((await post(request, `/api/trades/${trade.id}/cancel`, { userId: 'u-admin' })).ok()).toBeTruthy();

  const accept = await post(request, `/api/trades/${trade.id}/accept`, { userId: 'u-bea' });
  expect(accept.status()).toBe(409);
  expect((await accept.json()).error).toContain('no longer open');
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

test('the per-day vacation cap holds under sequential and stale submissions', async ({ request }) => {
  // Seed cap is 2 per day.
  expect((await post(request, '/api/timeoff', { userId: 'u-admin', date: '2099-02-01', type: 'vacation' })).ok()).toBeTruthy();
  expect((await post(request, '/api/timeoff', { userId: 'u-bea', date: '2099-02-01', type: 'vacation' })).ok()).toBeTruthy();
  const third = await post(request, '/api/timeoff', { userId: 'u-cy', date: '2099-02-01', type: 'vacation' });
  expect(third.status()).toBe(400);
  expect((await third.json()).error).toContain('full');
});

test('parallel writes are serialized — no lost updates', async ({ request }) => {
  // 10 simultaneous inserts; each mutation rewrites the timeOff collection,
  // so any lost update would show as a missing row.
  const dates = Array.from({ length: 10 }, (_, i) => `2099-03-${String(i + 1).padStart(2, '0')}`);
  const results = await Promise.all(
    dates.map((date) => post(request, '/api/timeoff', { userId: 'u-cy', date, type: 'preferred' }))
  );
  for (const r of results) expect(r.ok()).toBeTruthy();

  const state = await (await request.get('/api/state')).json();
  const mine = state.timeOff.filter((t) => t.userId === 'u-cy');
  expect(mine.length).toBe(10);
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
