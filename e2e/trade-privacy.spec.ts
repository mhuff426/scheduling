import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Open trades from coworkers carry only the viewer's own responses (ADR 0002);
// the poster sees every response. A trade mutation's response is the trade as
// that viewer's projection would show it, never the raw row.
//
// Seed: u-admin, u-bea, u-cy. Cy posts an open trade; Bea and the admin have
// both offered a shift in reply.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const BASE = 'http://localhost:5173';

const response = (userId: string, date: string) => ({ userId, date, shiftTypeId: 's-day', at: '2099-01-01T01:00:00.000Z' });
const openTrade = {
  id: 'tr-open',
  scheduleId: 'sch-2099',
  type: 'open',
  status: 'open',
  fromUserId: 'u-cy',
  offered: { date: '2099-01-08', shiftTypeId: 's-eve' },
  toUserId: null,
  requested: null,
  responses: [response('u-admin', '2099-01-03'), response('u-bea', '2099-01-04')],
  claimedBy: null,
  createdAt: '2099-01-01T00:00:00.000Z',
  resolvedAt: null,
};

const schedule = {
  id: 'sch-2099', createdAt: '2099-01-01T00:00:00.000Z', startDate: '2099-01-01', endDate: '2099-01-14',
  userIds: ['u-admin', 'u-bea', 'u-cy'],
  assignments: [
    { userId: 'u-admin', date: '2099-01-03', shiftTypeId: 's-day' },
    { userId: 'u-bea', date: '2099-01-04', shiftTypeId: 's-day' },
    { userId: 'u-cy', date: '2099-01-08', shiftTypeId: 's-eve' },
  ],
  unfilled: [], counts: {}, warnings: [],
};

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: { ...SEED, schedules: [schedule], trades: [openTrade] } });
  expect(res.ok()).toBeTruthy();
});

const signedInAs = async (playwright, userId: string) => {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  expect((await ctx.post('/api/dev/impersonate', { data: { userId } })).ok()).toBeTruthy();
  return ctx;
};

test("an employee's copy of a coworker's open trade carries only their own response", async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  const { trades } = await (await bea.get('/api/tabs/trades')).json();
  expect(trades.find((t) => t.id === 'tr-open').responses.map((r) => r.userId)).toEqual(['u-bea']);
  await bea.dispose();
});

test("the poster sees every response to their open trade", async ({ playwright }) => {
  const cy = await signedInAs(playwright, 'u-cy');
  const { trades } = await (await cy.get('/api/tabs/trades')).json();
  expect(trades.find((t) => t.id === 'tr-open').responses.map((r) => r.userId)).toEqual(['u-admin', 'u-bea']);
  await cy.dispose();
});

test("withdrawing a response returns the trade without a coworker's response", async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  const res = await bea.post('/api/trades/tr-open/withdraw', { data: {} });
  expect(res.status()).toBe(200);
  const trade = await res.json();
  expect(trade.id).toBe('tr-open');
  expect(trade.responses).toEqual([]);
  await bea.dispose();
});

test('the poster cancelling gets the trade back with every response', async ({ playwright }) => {
  const cy = await signedInAs(playwright, 'u-cy');
  const res = await cy.post('/api/trades/tr-open/cancel', { data: {} });
  expect(res.status()).toBe(200);
  const trade = await res.json();
  expect(trade.responses.map((r) => r.userId)).toEqual(['u-admin', 'u-bea']);
  await cy.dispose();
});
