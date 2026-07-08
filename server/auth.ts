// Pure auth helpers (top section — zero side effects, no DB access, unit-testable
// without a running database) and DB helpers (bottom section — each takes a pool
// as its first argument, runs direct queries, NOT withMutation).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'mysql2/promise';

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = (await scrypt(plain, salt, 64)) as Buffer;
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 's1') return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = (await scrypt(plain, salt, 64)) as Buffer;
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Returns null when the password is OK; a human-readable message when it isn't. */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== 'string') return 'Password must be a string.';
  if (p.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;

// ---------------------------------------------------------------------------
// DB helpers (direct queries; do NOT go through withMutation)
// ---------------------------------------------------------------------------

/** INSERT IGNORE a credential row (registered=0) for each userId that doesn't already have one. */
export async function ensureCredentialRows(pool: Pool, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const rows = userIds.map((id) => [id, 0]);
  await pool.query('INSERT IGNORE INTO `user_credentials` (`user_id`, `registered`) VALUES ?', [rows]);
}

type CredentialRow = {
  user_id: string;
  password_hash: string | null;
  invite_token_hash: string | null;
  invite_token_expiry: string | null;
  registered: number;
};

export async function getCredential(pool: Pool, userId: string): Promise<CredentialRow | null> {
  const [rows] = await pool.query<any[]>(
    'SELECT * FROM `user_credentials` WHERE `user_id` = ?', [userId]
  );
  return (rows as CredentialRow[])[0] ?? null;
}

export async function setPassword(pool: Pool, userId: string, plain: string): Promise<void> {
  const hash = await hashPassword(plain);
  await pool.query(
    `INSERT INTO \`user_credentials\` (\`user_id\`, \`password_hash\`, \`registered\`, \`invite_token_hash\`, \`invite_token_expiry\`)
     VALUES (?, ?, 1, NULL, NULL)
     ON DUPLICATE KEY UPDATE \`password_hash\` = VALUES(\`password_hash\`), \`registered\` = 1,
       \`invite_token_hash\` = NULL, \`invite_token_expiry\` = NULL`,
    [userId, hash]
  );
}

/** Creates an invite token, stores its hash + expiry, returns the RAW token. */
export async function createInvite(pool: Pool, userId: string): Promise<string> {
  const raw = newToken();
  const hashed = hashToken(raw);
  const expiry = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO \`user_credentials\` (\`user_id\`, \`invite_token_hash\`, \`invite_token_expiry\`, \`registered\`)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE \`invite_token_hash\` = VALUES(\`invite_token_hash\`),
       \`invite_token_expiry\` = VALUES(\`invite_token_expiry\`)`,
    [userId, hashed, expiry]
  );
  return raw;
}

/** Returns the userId whose invite token matches, or null if not found / expired. */
export async function findUserIdByInviteToken(pool: Pool, raw: string): Promise<string | null> {
  const hashed = hashToken(raw);
  const [rows] = await pool.query<any[]>(
    'SELECT `user_id`, `invite_token_expiry` FROM `user_credentials` WHERE `invite_token_hash` = ?',
    [hashed]
  );
  const row = (rows as Array<{ user_id: string; invite_token_expiry: string | null }>)[0];
  if (!row) return null;
  if (!row.invite_token_expiry || new Date(row.invite_token_expiry) < new Date()) return null;
  return row.user_id;
}

/** Returns a map of userId -> !!registered for all rows in user_credentials. */
export async function registeredMap(pool: Pool): Promise<Record<string, boolean>> {
  const [rows] = await pool.query<any[]>('SELECT `user_id`, `registered` FROM `user_credentials`');
  const out: Record<string, boolean> = {};
  for (const r of rows as Array<{ user_id: string; registered: number }>) {
    out[r.user_id] = !!r.registered;
  }
  return out;
}
