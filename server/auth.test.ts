// Smoke test: tsx server/auth.test.ts
// Unit tests for the PURE auth helpers in server/auth.ts — no DB, no network.
import assert from 'assert';
import {
  hashPassword, verifyPassword, newToken, hashToken, passwordProblem,
  SESSION_DAYS, INVITE_DAYS,
} from './auth.js';

const HEX64 = /^[0-9a-f]{64}$/;

// ---- hashPassword/verifyPassword: happy-path round-trip ----
{
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^s1\$[^$]+\$[^$]+$/, 'stored format is s1$<salt>$<hash>');
  assert.strictEqual(stored.split('$').length, 3, 'exactly three parts');
  assert.strictEqual(await verifyPassword('correct horse battery', stored), true, 'right password verifies');
}

// ---- verifyPassword: wrong password returns false ----
{
  const stored = await hashPassword('s3cret-password');
  assert.strictEqual(await verifyPassword('not-the-password', stored), false, 'wrong password rejected');
  // A near-miss (case difference) must also fail.
  assert.strictEqual(await verifyPassword('S3cret-password', stored), false, 'case-sensitive');
}

// ---- hashPassword: random salt -> two hashes of the same password differ, yet both verify ----
{
  const a = await hashPassword('same-password-here');
  const b = await hashPassword('same-password-here');
  assert.notStrictEqual(a, b, 'random salt makes the two stored values differ');
  assert.notStrictEqual(a.split('$')[1], b.split('$')[1], 'salts differ');
  assert.strictEqual(await verifyPassword('same-password-here', a), true, 'first still verifies');
  assert.strictEqual(await verifyPassword('same-password-here', b), true, 'second still verifies');
}

// ---- hashPassword/verifyPassword: empty-string password round-trips (policy enforced elsewhere) ----
{
  const stored = await hashPassword('');
  assert.strictEqual(await verifyPassword('', stored), true, 'empty password round-trips');
  assert.strictEqual(await verifyPassword('x', stored), false, 'non-empty does not match empty');
}

// ---- verifyPassword: malformed stored values return false, never throw ----
{
  for (const bad of ['', 'garbage', 's1$onlyonepart', 's1$$', 'x1$abc$def', 's1$a$b$c']) {
    const r = await verifyPassword('anything', bad);
    assert.strictEqual(r, false, `malformed stored (${JSON.stringify(bad)}) -> false`);
  }
  // Wrong prefix but three parts.
  assert.strictEqual(await verifyPassword('p', 's2$YWJj$ZGVm'), false, 'wrong version tag -> false');
  // Base64 that decodes to a length mismatching the 64-byte scrypt output.
  assert.strictEqual(await verifyPassword('p', 's1$YWJj$ZGVm'), false, 'length-mismatch hash -> false');
  // Non-string-ish stored values coerced by the caller normally, but guard anyway.
  assert.strictEqual(await verifyPassword('p', 's1$!!!$@@@'), false, 'invalid base64 chars -> false');
}

// ---- newToken: 64 lowercase hex chars, two calls differ ----
{
  const t1 = newToken();
  const t2 = newToken();
  assert.match(t1, HEX64, 'token is 64 lowercase hex chars');
  assert.match(t2, HEX64, 'second token is 64 lowercase hex chars');
  assert.notStrictEqual(t1, t2, 'two tokens differ');
}

// ---- hashToken: deterministic, 64 hex chars, differs from input ----
{
  const raw = 'a'.repeat(64);
  const h1 = hashToken(raw);
  const h2 = hashToken(raw);
  assert.strictEqual(h1, h2, 'hashToken is deterministic');
  assert.match(h1, HEX64, 'hashToken output is 64 hex chars (sha256)');
  assert.notStrictEqual(h1, raw, 'hash differs from input');
  assert.notStrictEqual(hashToken('other'), h1, 'different input -> different hash');
}

// ---- passwordProblem: null for OK, message otherwise ----
{
  assert.strictEqual(passwordProblem('12345678'), null, '8 chars is OK');
  assert.strictEqual(passwordProblem('a'.repeat(64)), null, 'long is OK');
  assert.strictEqual(passwordProblem('12345678 '), null, 'exactly 8 (with space) is OK');

  assert.ok(passwordProblem('1234567'), '7 chars rejected');
  assert.ok(passwordProblem(''), 'empty rejected');
  // Non-string inputs: number, null, undefined, object, boolean.
  assert.ok(passwordProblem(12345678 as unknown), 'number rejected (not a string)');
  assert.ok(passwordProblem(null), 'null rejected');
  assert.ok(passwordProblem(undefined), 'undefined rejected');
  assert.ok(passwordProblem({} as unknown), 'object rejected');
  assert.ok(passwordProblem(true as unknown), 'boolean rejected');
  // The rejections return a human-readable string.
  assert.strictEqual(typeof passwordProblem('short'), 'string', 'problem is a message string');
}

// ---- constants ----
{
  assert.strictEqual(SESSION_DAYS, 30, 'SESSION_DAYS is 30');
  assert.strictEqual(INVITE_DAYS, 7, 'INVITE_DAYS is 7');
}

console.log('All auth tests passed.');
