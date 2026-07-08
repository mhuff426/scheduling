import crypto from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { Request, Response, NextFunction } from 'express';
import { SESSION_DAYS } from './auth.js';

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  }
  return out;
}

export async function createSession(pool: Pool, userId: string): Promise<{ id: string; expiresAt: string }> {
  const id = crypto.randomBytes(32).toString('hex');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    'INSERT INTO `sessions` (`id`, `user_id`, `created_at`, `expires_at`) VALUES (?, ?, ?, ?)',
    [id, userId, createdAt, expiresAt]
  );
  return { id, expiresAt };
}

export async function getSession(pool: Pool, id: string): Promise<{ userId: string } | null> {
  const [rows] = await pool.query<any[]>(
    'SELECT `user_id`, `expires_at` FROM `sessions` WHERE `id` = ?', [id]
  );
  const row = (rows as Array<{ user_id: string; expires_at: string }>)[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    // Lazy expiry cleanup — fire-and-forget.
    pool.query('DELETE FROM `sessions` WHERE `id` = ?', [id]).catch(() => {});
    return null;
  }
  return { userId: row.user_id };
}

export async function destroySession(pool: Pool, id: string): Promise<void> {
  await pool.query('DELETE FROM `sessions` WHERE `id` = ?', [id]);
}

const MAX_AGE = SESSION_DAYS * 24 * 60 * 60; // seconds

export function sessionCookie(id: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `sid=logged-out; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}

/**
 * Express middleware that resolves the session and sets (req as any).authUserId.
 *
 * E2E/dev bypass: if there is NO sid cookie at all AND E2E_TESTING==='1',
 * authenticate as the first admin. This keeps the 33 existing Playwright specs
 * working unchanged. Logout uses the 'logged-out' sentinel so the bypass
 * doesn't resurrect a logged-out state.
 */
export function attachSession(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies['sid'];

      if (sid === undefined) {
        // No cookie at all.
        if (process.env.E2E_TESTING === '1') {
          // Bypass: find first admin user.
          const [rows] = await pool.query<any[]>(
            `SELECT u.id FROM \`users\` u
             JOIN \`user_roles\` ur ON ur.user_id = u.id
             WHERE ur.role_id = 'role-admin'
             ORDER BY u.position LIMIT 1`
          );
          const row = (rows as Array<{ id: string }>)[0];
          if (row) (req as any).authUserId = row.id;
        }
        // Otherwise anonymous — authUserId stays undefined.
      } else if (sid === 'logged-out') {
        (req as any).authUserId = null;
      } else {
        const session = await getSession(pool, sid);
        if (session) (req as any).authUserId = session.userId;
        else (req as any).authUserId = null;
      }
    } catch (e) {
      console.error('[session] middleware error:', e);
      // Continue anonymous on DB error.
    }
    next();
  };
}
