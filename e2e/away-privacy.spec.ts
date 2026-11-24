import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Away time is private to the person and the admins, and the away memo is
// admin-only (ADR 0002). Checks what the HTTP responses contain.
// Seed: u-admin, u-bea, u-cy.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
const BASE = 'http://localhost:5173';

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

const signedInAs = async (playwright, userId: string) => {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  expect((await ctx.post('/api/dev/impersonate', { data: { userId } })).ok()).toBeTruthy();
  return ctx;
};

const addAway = async (ctx, body) => {
  const res = await ctx.post('/api/awaytime', { data: body });
  expect(res.ok(), await res.text()).toBeTruthy();
};

test("an employee's responses carry only their own away time, with its label and no away memo", async ({ playwright }) => {
  const admin = await signedInAs(playwright, 'u-admin');
  await addAway(admin, { userId: 'u-bea', start: '2026-12-10', end: '2026-12-12', label: 'Training', memo: 'bea-secret-memo' });
  await addAway(admin, { userId: 'u-cy', start: '2026-12-20', end: '2026-12-22', label: 'Conference', memo: 'cy-secret-memo' });

  const bea = await signedInAs(playwright, 'u-bea');
  for (const url of ['/api/tabs/schedule', '/api/tabs/preferences', '/api/tabs/trades', '/api/users', '/api/auth/me']) {
    const res = await bea.get(url);
    const text = await res.text();
    expect(text, url).not.toContain('memo');
    expect(text, url).not.toContain('Conference');
  }
  const prefs = await (await bea.get('/api/tabs/preferences')).json();
  expect(prefs.awayTime.map((a) => [a.userId, a.label])).toEqual([['u-bea', 'Training']]);

  // The admin still sees every away time with its memo.
  const state = await (await admin.get('/api/state')).json();
  expect(state.awayTime.map((a) => [a.userId, a.memo])).toEqual([['u-bea', 'bea-secret-memo'], ['u-cy', 'cy-secret-memo']]);
  const adminTab = await (await admin.get('/api/tabs/admin')).json();
  expect(adminTab.awayTime.length).toBe(2);

  await bea.dispose();
  await admin.dispose();
});
