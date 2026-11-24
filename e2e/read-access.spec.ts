import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Who may read at all (ADR 0002): nobody signed in is refused every data read,
// and an employee is refused the admin tab and the full state dump.
//
// Under E2E_TESTING a request with NO sid cookie is auto-authenticated as the
// first admin, so "nobody signed in" is a context carrying the logged-out
// sentinel cookie (what logout leaves behind). Seed: u-admin, u-bea, u-cy.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const BASE = 'http://localhost:5173';
const TABS = ['schedule', 'preferences', 'trades', 'admin'];

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

const anonymous = (playwright) =>
  playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: 'sid=logged-out' } });

const signedInAs = async (playwright, userId: string) => {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  expect((await ctx.post('/api/dev/impersonate', { data: { userId } })).ok()).toBeTruthy();
  return ctx;
};

test('nobody signed in gets 401 on every named tab, the user list and the full dump', async ({ playwright }) => {
  const anon = await anonymous(playwright);
  for (const url of [...TABS.map((t) => `/api/tabs/${t}`), '/api/users', '/api/state']) {
    const res = await anon.get(url);
    expect(res.status(), url).toBe(401);
    expect(await res.text(), url).not.toContain('bea@shiftly.local');
  }
  await anon.dispose();
});

test('an employee gets 403 on the admin tab and the full dump, and the other reads as before', async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  expect((await bea.get('/api/tabs/admin')).status()).toBe(403);
  expect((await bea.get('/api/state')).status()).toBe(403);

  for (const tab of ['schedule', 'preferences', 'trades']) {
    expect((await bea.get(`/api/tabs/${tab}`)).status(), tab).toBe(200);
  }
  const { users } = await (await bea.get('/api/users')).json();
  expect(users.map((u) => u.id)).toEqual(['u-admin', 'u-bea', 'u-cy']);
  await bea.dispose();
});

test('an admin still gets the full dump and the admin tab', async ({ playwright }) => {
  const admin = await signedInAs(playwright, 'u-admin');
  const state = await (await admin.get('/api/state')).json();
  expect(state.users.length).toBe(3);
  expect(state.preferenceStandings).toBeDefined();

  const tab = await admin.get('/api/tabs/admin');
  expect(tab.status()).toBe(200);
  expect((await tab.json()).roles.length).toBe(2);
  await admin.dispose();
});
