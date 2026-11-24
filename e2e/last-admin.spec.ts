import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The last-admin guard at the API level: someone must always be able to
// manage people. The default `request` fixture is auto-authenticated as the
// first admin (u-admin) under E2E_TESTING. Users: u-admin (the only admin),
// u-bea, u-cy (see seed.json). The rule's edge cases are unit-tested in
// server/people.test.ts; this keeps one happy path and one refusal.

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/reset', { data: SEED });
  expect(res.ok()).toBeTruthy();
});

test('an admin can step down once someone else is an admin', async ({ request }) => {
  const promote = await request.put('/api/users/u-bea', { data: { roles: ['role-admin'] } });
  expect(promote.ok()).toBeTruthy();
  expect((await promote.json()).roles).toEqual(['role-admin', 'role-employee']);

  const stepDown = await request.put('/api/users/u-admin', { data: { roles: [] } });
  expect(stepDown.ok()).toBeTruthy();
  expect((await stepDown.json()).roles).toEqual(['role-employee']);
});

test('the only admin can be neither demoted nor removed', async ({ request }) => {
  const demote = await request.put('/api/users/u-admin', { data: { roles: ['role-employee'] } });
  expect(demote.status()).toBe(400);
  expect((await demote.json()).error).toBe('Admin is the only admin. Make someone else an admin first.');

  const remove = await request.delete('/api/users/u-admin');
  expect(remove.status()).toBe(400);
  expect((await remove.json()).error).toBe("Admin is the only admin and can't be removed. Make someone else an admin first.");
});
