import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Coworkers appear by name and colour only (ADR 0002): an employee's reads
// carry nobody else's email. Seed: u-admin, u-bea, u-cy; normalizeDb gives
// them admin@ / bea@ / cy@shiftly.local.

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

test("an employee's responses contain no one else's email", async ({ playwright }) => {
  const bea = await signedInAs(playwright, 'u-bea');
  for (const url of ['/api/users', '/api/tabs/schedule', '/api/tabs/preferences', '/api/tabs/trades']) {
    const res = await bea.get(url);
    expect(res.status(), url).toBe(200);
    const body = await res.text();
    expect(body, url).not.toContain('admin@shiftly.local');
    expect(body, url).not.toContain('cy@shiftly.local');
  }

  const { users } = await (await bea.get('/api/users')).json();
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  expect(Object.keys(byId['u-cy']).sort()).toEqual(['color', 'id', 'name']);
  expect(byId['u-bea'].email).toBe('bea@shiftly.local');
  expect(byId['u-bea']).not.toHaveProperty('registered');
  await bea.dispose();
});

test('an admin still gets every full user record with registration status', async ({ playwright }) => {
  const admin = await signedInAs(playwright, 'u-admin');
  const { users } = await (await admin.get('/api/users')).json();
  const cy = users.find((u) => u.id === 'u-cy');
  expect(cy.email).toBe('cy@shiftly.local');
  expect(cy.registered).toBe(false);
  await admin.dispose();
});
