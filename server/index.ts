import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, readState, withMutation, newId, vacationCountForDate, resetDbForTests, DEFAULT_DATA, getPool } from './db.js';
import type { CollectionKey } from './mysql.js';
import {
  generateSchedule, summarizeSchedule, preferenceStandings,
  effectiveMaximums, weightOf,
} from './scheduler.js';
import {
  canTakeShift, createTrade, respondToOpenTrade, withdrawResponse,
  acceptOpenResponse, acceptDirect, rejectDirect, claimGiveaway, cancelTrade,
  setExtraElection, tradeOptions, swapPartners,
} from './trades.js';
import { buildIcs } from './ics.js';
import { isValidCadence, blockRange, currentBlockIndex, todayYmd } from '../shared/blocks.js';
import { isValidRecurrence } from '../shared/holidays.js';
import type { AppState, Db, ShiftType, User } from '../shared/types.js';
import {
  passwordProblem, verifyPassword, ensureCredentialRows, getCredential,
  setPassword, createInvite, findUserIdByInviteToken, registeredMap,
} from './auth.js';
import { attachSession, createSession, destroySession, sessionCookie, clearedSessionCookie, parseCookies } from './sessions.js';
import { sendInviteEmail, inviteLink } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Attach the session middleware. We defer pool resolution to per-request so
// the app can import this module before initDb() completes.
app.use((req: Request, res: Response, next) => {
  attachSession(getPool())(req, res, next);
});

// Validation failures inside withMutation() THROW one of these (rolls the
// transaction back — they always happen before any mutation). Business
// outcomes that must persist even on failure (trades) use return values.
class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

// Express 4 doesn't catch rejected async handlers — every route goes through
// this wrapper.
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      if (e instanceof HttpError) {
        return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
      }
      const code = (e as { code?: string })?.code;
      if (code === 'ER_LOCK_WAIT_TIMEOUT') {
        return res.status(503).json({ error: 'The server is busy — please try again in a moment.' });
      }
      if (code === 'ECONNREFUSED' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ETIMEDOUT') {
        return res.status(503).json({ error: 'The database is unreachable — please try again in a moment.' });
      }
      console.error(e);
      res.status(500).json({ error: 'Unexpected server error.' });
    });
  };

// Optimistic-concurrency check: clients echo the `version` they read as
// `expectedVersion`; a mismatch means someone else changed the record since.
// Absent expectedVersion skips the check (curl / legacy callers).
function checkVersion(entity: { version?: number }, expected: unknown, what: string): void {
  if (expected === undefined) return;
  if (Number(expected) !== (entity.version ?? 1)) {
    throw new HttpError(
      409,
      `${what} was changed by someone else — the view has been refreshed with the latest data. Please retry.`,
      'version_conflict'
    );
  }
}
const bumpVersion = (entity: { version?: number }) => {
  entity.version = (entity.version ?? 1) + 1;
};

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Returns the authed User, or throws 401. */
function authedUser(db: Db, req: Request): User {
  const uid = (req as any).authUserId as string | null | undefined;
  if (!uid) throw new HttpError(401, 'Please log in.', 'unauthenticated');
  const u = db.users.find((x) => x.id === uid);
  if (!u) throw new HttpError(401, 'Please log in.', 'unauthenticated');
  return u;
}

/** Returns the authed User if they are an admin, else throws 403. */
function requireAdmin(db: Db, req: Request): User {
  const u = authedUser(db, req);
  if (!(u.roles || []).includes('role-admin')) throw new HttpError(403, 'Admin access required.');
  return u;
}

/** User fields safe to send to the client (no credentials). Merges optional `registered`. */
function redactUser(u: User, registered?: boolean): object {
  const base = { ...u };
  if (registered !== undefined) return { ...base, registered };
  return base;
}

// Single-instance in-memory login throttle. Acceptable: single-instance only.
const loginAttempts = new Map<string, { fails: number; lockedUntil: number }>();

function checkLoginThrottle(ip: string): void {
  const entry = loginAttempts.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    throw new HttpError(429, 'Too many attempts — try again shortly.');
  }
}

function recordLoginFailure(ip: string): void {
  const entry = loginAttempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= 5) entry.lockedUntil = Date.now() + 30_000;
  loginAttempts.set(ip, entry);
}

function recordLoginSuccess(ip: string): void {
  loginAttempts.delete(ip);
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/login', handle(async (req, res) => {
  const ip = req.ip || 'unknown';
  checkLoginThrottle(ip);
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const db = await readState();
  const user = db.users.find((u) => u.email?.toLowerCase() === email);
  if (!user) {
    recordLoginFailure(ip);
    throw new HttpError(401, 'Invalid email or password.');
  }
  const cred = await getCredential(getPool(), user.id);
  if (!cred || !cred.registered) {
    // User exists but has not set a password.
    return res.json({ needsRegistration: true });
  }
  const ok = await verifyPassword(password, cred.password_hash || '');
  if (!ok) {
    recordLoginFailure(ip);
    throw new HttpError(401, 'Invalid email or password.');
  }
  recordLoginSuccess(ip);
  const { id, expiresAt } = await createSession(getPool(), user.id);
  res.setHeader('Set-Cookie', sessionCookie(id));
  return res.json({ user: redactUser(user, true) });
}));

app.post('/api/auth/register', handle(async (req, res) => {
  const { token, email, password } = req.body;
  const prob = passwordProblem(password);
  if (prob) throw new HttpError(400, prob);

  const pool = getPool();
  let userId: string;

  if (token) {
    const uid = await findUserIdByInviteToken(pool, String(token));
    if (!uid) throw new HttpError(400, 'This invite link is invalid or has expired.');
    userId = uid;
  } else if (email) {
    const emailNorm = String(email).toLowerCase().trim();
    const db = await readState();
    const user = db.users.find((u) => u.email?.toLowerCase() === emailNorm);
    if (!user) throw new HttpError(404, 'No account found with that email.');
    const cred = await getCredential(pool, user.id);
    if (cred?.registered) throw new HttpError(400, 'This account is already set up — log in instead.');
    userId = user.id;
  } else {
    throw new HttpError(400, 'token or email is required.');
  }

  await setPassword(pool, userId, String(password));
  const db = await readState();
  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new HttpError(404, 'User not found.');
  const { id } = await createSession(pool, userId);
  res.setHeader('Set-Cookie', sessionCookie(id));
  return res.json({ user: redactUser(user, true) });
}));

app.post('/api/auth/logout', handle(async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies['sid'];
  if (sid && sid !== 'logged-out') {
    await destroySession(getPool(), sid).catch(() => {});
  }
  res.setHeader('Set-Cookie', clearedSessionCookie());
  return res.json({ ok: true });
}));

app.get('/api/auth/me', handle(async (req, res) => {
  const uid = (req as any).authUserId as string | null | undefined;
  if (!uid) return res.status(401).json({ error: 'Not logged in.' });
  const db = await readState();
  const user = db.users.find((u) => u.id === uid);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const map = await registeredMap(getPool());
  return res.json({ user: redactUser(user, !!map[user.id]) });
}));

// Dev/test-only impersonation (never in production).
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/impersonate', handle(async (req, res) => {
    const { userId } = req.body;
    const db = await readState();
    const user = db.users.find((u) => u.id === userId);
    if (!user) throw new HttpError(404, 'User not found.');
    const { id } = await createSession(getPool(), user.id);
    res.setHeader('Set-Cookie', sessionCookie(id));
    return res.json({ user: redactUser(user) });
  }));
}

// ---------------------------------------------------------------------------
// Test-only reset hook
// ---------------------------------------------------------------------------

// Test-only reset hook: e2e seeds a known DB state before each test so cases
// never depend on ambient dev data. Gated behind E2E_TESTING so it never
// exists in normal runs.
if (process.env.E2E_TESTING === '1') {
  app.post('/api/test/reset', handle(async (req, res) => {
    await resetDbForTests(req.body as Db);
    res.json({ ok: true });
  }));
}

// Pastel assignment colors. Each pairs with near-black chip text at >= 7:1
// (WCAG AAA) — see client/src/contrast.ts (safeBg/CHIP_INK) and the chip styles.
const PALETTE = [
  '#fca5a5', '#fdba74', '#fcd34d', '#bef264', '#86efac',
  '#5eead4', '#67e8f9', '#7dd3fc', '#93c5fd', '#a5b4fc',
  '#c4b5fd', '#d8b4fe', '#f0abfc', '#f9a8d4', '#fda4af',
];

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s: string) => /^\d{2}:\d{2}$/.test(s || '');

// ---- whole app state (kept for debugging/tooling; the client fetches per tab) ----
app.get('/api/state', handle(async (req, res) => {
  const db = await readState();
  // Derived, never persisted or editable — shown only in the admin roster UI.
  res.json({ ...db, preferenceStandings: preferenceStandings(db) });
}));

// ---- per-tab reads ----
// Each tab fetches only the collections it renders. Cross-tab data (users,
// notifications) deliberately has its OWN endpoints below — fetched alongside
// every tab and easy to upgrade to an SSE stream later.
const TAB_KEYS: Record<string, CollectionKey[]> = {
  schedule: ['schedules', 'shiftTypes', 'holidays', 'trades', 'settings'],
  preferences: ['timeOff', 'awayTime', 'holidays', 'settings', 'schedules'],
  trades: ['schedules', 'trades', 'shiftTypes'],
  admin: ['roles', 'shiftTypes', 'settings', 'timeOff', 'schedules', 'awayTime', 'holidays'],
};

// Responses keep the full AppState shape (components index collections
// without guards) — unrequested keys are empty/default.
function emptyState(): AppState {
  return {
    users: [], roles: [], shiftTypes: [], timeOff: [], schedules: [],
    trades: [], notifications: [], awayTime: [], holidays: [],
    settings: structuredClone(DEFAULT_DATA.settings),
    meta: { rotationCursor: 0 },
  };
}

app.get('/api/tabs/:tab', handle(async (req, res) => {
  const keys = TAB_KEYS[req.params.tab];
  if (!keys) throw new HttpError(404, 'Unknown tab.');
  const db = await readState();
  const out = emptyState();
  for (const k of keys) (out as any)[k] = db[k];
  if (req.params.tab === 'admin') out.preferenceStandings = preferenceStandings(db);
  res.json(out);
}));

app.get('/api/users', handle(async (req, res) => {
  const db = await readState();
  const map = await registeredMap(getPool());
  res.json({ users: db.users.map((u) => ({ ...u, registered: !!map[u.id] })) });
}));

app.get('/api/notifications', handle(async (req, res) => {
  const db = await readState();
  const user = authedUser(db, req);
  res.json({ notifications: db.notifications.filter((n) => n.userId === user.id) });
}));

// ---- roster ----
app.post('/api/users', handle(async (req, res) => {
  const user = await withMutation((db) => {
    requireAdmin(db, req);
    const { firstName, lastName, email, employeeId, roles, vacationDays, startDate } = req.body;
    const firstTrim = String(firstName || '').trim();
    const lastTrim = String(lastName || '').trim();
    if (!firstTrim || !lastTrim) throw new HttpError(400, 'First and last name are required.');
    const emailTrim = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) throw new HttpError(400, 'A valid email is required.');
    if (db.users.some((u) => u.email?.toLowerCase() === emailTrim))
      throw new HttpError(409, 'A user with that email already exists.');
    const valid = new Set(db.roles.map((r) => r.id));
    const reqRoles = (Array.isArray(roles) ? roles : []).filter((id: string) => valid.has(id));
    if (!reqRoles.includes('role-employee')) reqRoles.push('role-employee');
    const empId = employeeId ? String(employeeId).trim() || null : null;
    const u: User = {
      id: newId('u'),
      firstName: firstTrim,
      lastName: lastTrim,
      name: `${firstTrim} ${lastTrim}`.trim(),
      email: emailTrim,
      employeeId: empId,
      roles: reqRoles,
      vacationDays: Math.max(0, Number(vacationDays) || 0),
      color: PALETTE[db.users.length % PALETTE.length],
      startDate: isDate(startDate) ? startDate : null,
    };
    db.users.push(u);
    return u;
  });
  // After the mutation commits, create credential row + invite.
  const pool = getPool();
  await ensureCredentialRows(pool, [user.id]);
  const rawToken = await createInvite(pool, user.id);
  const link = inviteLink(rawToken);
  const { delivered } = await sendInviteEmail({ to: user.email!, name: user.name, link });
  res.json({ ...redactUser(user, false), ...(delivered ? {} : { inviteLink: link }) });
}));

const isAdminUser = (u: User) => (u.roles || []).includes('role-admin');
const isLastAdmin = (db: Db, user: User) =>
  isAdminUser(user) && db.users.filter(isAdminUser).length === 1;

app.put('/api/users/:id', handle(async (req, res) => {
  const user = await withMutation((db) => {
    requireAdmin(db, req);
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) throw new HttpError(404, 'User not found.');
    checkVersion(user, req.body.expectedVersion, `${user.name}'s profile`);
    const { name, roles, vacationDays } = req.body;
    // Handle firstName/lastName edits.
    let nameChanged = false;
    if (req.body.firstName !== undefined) {
      const f = String(req.body.firstName).trim();
      if (!f) throw new HttpError(400, 'First name cannot be empty.');
      user.firstName = f;
      nameChanged = true;
    }
    if (req.body.lastName !== undefined) {
      user.lastName = String(req.body.lastName).trim();
      nameChanged = true;
    }
    if (nameChanged) user.name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.name;
    if (req.body.email !== undefined) {
      const emailTrim = String(req.body.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) throw new HttpError(400, 'A valid email is required.');
      if (db.users.some((u) => u.id !== user.id && u.email?.toLowerCase() === emailTrim))
        throw new HttpError(409, 'A user with that email already exists.');
      user.email = emailTrim;
    }
    if (req.body.employeeId !== undefined) {
      const empId = req.body.employeeId === null || req.body.employeeId === '' ? null : String(req.body.employeeId).trim() || null;
      user.employeeId = empId;
    }
    if (name !== undefined && !req.body.firstName && !req.body.lastName) user.name = String(name).trim() || user.name;
    if (roles !== undefined) {
      const valid = new Set(db.roles.map((r) => r.id));
      const next = (Array.isArray(roles) ? roles : []).filter((id: string) => valid.has(id));
      if (!next.includes('role-employee')) next.push('role-employee'); // Employee always implied
      // Can't strip the Admin tag (admin access) from the only admin.
      if (isAdminUser(user) && !next.includes('role-admin') && isLastAdmin(db, user)) {
        throw new HttpError(400, `${user.name} is the only admin. Make someone else an admin first.`);
      }
      user.roles = next;
    }
    if (vacationDays !== undefined) user.vacationDays = Math.max(0, Number(vacationDays) || 0);
    if (req.body.requiredShifts !== undefined) {
      const r = req.body.requiredShifts;
      user.requiredShifts = r === null || r === '' ? null : Math.max(0, Number(r) || 0);
    }
    if (req.body.maxConsecutiveNights !== undefined) {
      const n = req.body.maxConsecutiveNights;
      user.maxConsecutiveNights = n === null || n === '' ? null : Math.max(1, Number(n) || 1);
    }
    if (req.body.maxShiftsOverride !== undefined) {
      const n = req.body.maxShiftsOverride;
      user.maxShiftsOverride = n === null || n === '' ? null : Math.max(1, Number(n) || 1);
    }
    if (req.body.startDate !== undefined) {
      const d = req.body.startDate;
      user.startDate = d === null || d === '' ? null : (isDate(d) ? d : user.startDate);
    }
    if (req.body.color !== undefined && typeof req.body.color === 'string') user.color = req.body.color;
    if (req.body.theme !== undefined) user.theme = req.body.theme === 'dark' ? 'dark' : 'light';
    bumpVersion(user);
    return user;
  });
  res.json(user);
}));

app.delete('/api/users/:id', handle(async (req, res) => {
  await withMutation((db) => {
    requireAdmin(db, req);
    const idx = db.users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'User not found.');
    if (isLastAdmin(db, db.users[idx])) {
      throw new HttpError(400, `${db.users[idx].name} is the only admin and can't be removed. Make someone else an admin first.`);
    }
    db.users.splice(idx, 1);
    db.timeOff = db.timeOff.filter((t) => t.userId !== req.params.id);
    db.awayTime = db.awayTime.filter((a) => a.userId !== req.params.id);
  });
  // Explicit cleanup of auth tables (no FK cascade — see schema comments).
  const pool = getPool();
  await pool.query('DELETE FROM `user_credentials` WHERE `user_id` = ?', [req.params.id]);
  await pool.query('DELETE FROM `sessions` WHERE `user_id` = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- resend invite ----
app.post('/api/users/:id/resend-invite', handle(async (req, res) => {
  const db = await readState();
  requireAdmin(db, req);
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) throw new HttpError(404, 'User not found.');
  const pool = getPool();
  const cred = await getCredential(pool, user.id);
  if (cred?.registered) throw new HttpError(400, 'This user has already registered.');
  await ensureCredentialRows(pool, [user.id]);
  const rawToken = await createInvite(pool, user.id);
  const link = inviteLink(rawToken);
  const { delivered } = await sendInviteEmail({ to: user.email || '', name: user.name, link });
  return res.json({ ok: true, ...(delivered ? {} : { inviteLink: link }) });
}));

// ---- employee roles (capability tags; Admin/Employee are system roles) ----
app.post('/api/roles', handle(async (req, res) => {
  const role = await withMutation((db) => {
    requireAdmin(db, req);
    const name = String(req.body.name || '').trim();
    if (!name) throw new HttpError(400, 'Role name is required.');
    if (db.roles.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      throw new HttpError(400, 'A role with that name already exists.');
    const role = { id: newId('role'), name };
    db.roles.push(role);
    return role;
  });
  res.json(role);
}));

app.put('/api/roles/:id', handle(async (req, res) => {
  const role = await withMutation((db) => {
    requireAdmin(db, req);
    const role = db.roles.find((r) => r.id === req.params.id);
    if (!role) throw new HttpError(404, 'Role not found.');
    if (role.system) throw new HttpError(400, 'System roles cannot be renamed.');
    checkVersion(role, req.body.expectedVersion, `The role "${role.name}"`);
    const name = String(req.body.name || '').trim();
    if (!name) throw new HttpError(400, 'Role name is required.');
    if (db.roles.some((r) => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase()))
      throw new HttpError(400, 'A role with that name already exists.');
    role.name = name;
    bumpVersion(role);
    return role;
  });
  res.json(role);
}));

app.delete('/api/roles/:id', handle(async (req, res) => {
  await withMutation((db) => {
    requireAdmin(db, req);
    const role = db.roles.find((r) => r.id === req.params.id);
    if (!role) throw new HttpError(404, 'Role not found.');
    if (role.system) throw new HttpError(400, 'System roles cannot be deleted.');
    // Cascade: drop the role id from every user and every shift type.
    for (const u of db.users) u.roles = (u.roles || []).filter((r) => r !== role.id);
    for (const st of db.shiftTypes) st.allowedRoles = (st.allowedRoles || []).filter((r) => r !== role.id);
    db.roles = db.roles.filter((r) => r.id !== role.id);
  });
  res.json({ ok: true });
}));

// ---- shift types ----
// Validate and normalize the shift-type fields shared by create and edit.
// Returns { error } on failure or { fields } on success.
function parseShiftType(body: any): { error: string; fields?: undefined } | { error?: undefined; fields: Omit<ShiftType, 'id'> } {
  const { name, startTime, endTime, frequency, dayOfWeek, staffRequired, minRun, maxRun, weight, allowedRoles } = body;
  if (!name || !name.trim()) return { error: 'Shift name is required.' };
  if (!isTime(startTime) || !isTime(endTime))
    return { error: 'Start and end times are required (HH:MM).' };
  const freq = frequency === 'weekly' ? 'weekly' : 'daily';
  // Run target: a person stays on this shift type between minRun and maxRun
  // consecutive days. Blank = no grouping (min 1, no max).
  const min = Math.max(1, Number(minRun) || 1);
  const maxNum = Number(maxRun);
  const max = Number.isFinite(maxNum) && maxNum >= 1 ? Math.max(min, maxNum) : null;
  // Fairness weight: blank = automatic (1, or the overnight default for
  // overnight shifts). 0 is allowed and means standby duty that doesn't count
  // toward anyone's shift count.
  const wNum = Number(weight);
  const w = weight === '' || weight == null || !Number.isFinite(wNum) ? null : Math.max(0, wNum);
  return {
    fields: {
      weight: w,
      name: name.trim(),
      startTime,
      endTime,
      frequency: freq,
      dayOfWeek: freq === 'weekly' ? Math.min(6, Math.max(0, Number(dayOfWeek) || 0)) : null,
      staffRequired: Math.max(1, Number(staffRequired) || 1),
      minRun: min,
      maxRun: max,
      allowedRoles: Array.isArray(allowedRoles) ? allowedRoles.filter((r: any) => typeof r === 'string') : [],
    },
  };
}

app.post('/api/shift-types', handle(async (req, res) => {
  const st = await withMutation((db) => {
    requireAdmin(db, req);
    const { error, fields } = parseShiftType(req.body);
    if (error) throw new HttpError(400, error);
    const st: ShiftType = { id: newId('s'), ...fields! };
    db.shiftTypes.push(st);
    return st;
  });
  res.json(st);
}));

app.put('/api/shift-types/:id', handle(async (req, res) => {
  const st = await withMutation((db) => {
    requireAdmin(db, req);
    const st = db.shiftTypes.find((s) => s.id === req.params.id);
    if (!st) throw new HttpError(404, 'Shift type not found.');
    checkVersion(st, req.body.expectedVersion, `The shift type "${st.name}"`);
    const { error, fields } = parseShiftType(req.body);
    if (error) throw new HttpError(400, error);
    // Mutate in place so existing schedules keep referencing the same id.
    Object.assign(st, fields!);
    bumpVersion(st);
    return st;
  });
  res.json(st);
}));

app.delete('/api/shift-types/:id', handle(async (req, res) => {
  await withMutation((db) => {
    requireAdmin(db, req);
    const idx = db.shiftTypes.findIndex((s) => s.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'Shift type not found.');
    db.shiftTypes.splice(idx, 1);
  });
  res.json({ ok: true });
}));

// ---- settings ----
app.put('/api/settings', handle(async (req, res) => {
  const settings = await withMutation((db) => {
    requireAdmin(db, req);
    checkVersion(db.settings, req.body.expectedVersion, 'Settings');
    const { maxVacationPerDay } = req.body;
    if (maxVacationPerDay !== undefined)
      db.settings.maxVacationPerDay = Math.max(1, Number(maxVacationPerDay) || 1);
    if (req.body.holidaysRequiredPerYear !== undefined)
      db.settings.holidaysRequiredPerYear = Math.max(0, Number(req.body.holidaysRequiredPerYear) || 0);
    if (req.body.cadence !== undefined) {
      const c = req.body.cadence;
      if (!isValidCadence(c))
        throw new HttpError(400, 'Invalid cadence: need an anchor date, a positive whole number, and a unit.');
      const existing = db.settings.cadence;
      const changed = !existing
        || existing.anchorDate !== c.anchorDate
        || existing.lengthUnit !== c.lengthUnit
        || existing.lengthValue !== c.lengthValue;
      // Changing an existing cadence requires a strictly-future anchor; the very
      // first setup may start today or later.
      if (changed && existing && c.anchorDate <= todayYmd())
        throw new HttpError(400, 'A new schedule start date must be in the future.');
      if (changed && !existing && c.anchorDate < todayYmd())
        throw new HttpError(400, 'The schedule start date cannot be in the past.');
      db.settings.cadence = { anchorDate: c.anchorDate, lengthUnit: c.lengthUnit, lengthValue: c.lengthValue };
    }
    bumpVersion(db.settings);
    return db.settings;
  });
  res.json(settings);
}));

// ---- time off requests ----
app.post('/api/timeoff', handle(async (req, res) => {
  const entry = await withMutation((db) => {
    const authed = authedUser(db, req);
    const userId = authed.id; // ignore client-sent userId; use session identity
    const { date, type } = req.body;
    const user = authed;
    if (!isDate(date)) throw new HttpError(400, 'Invalid date.');
    if (type !== 'vacation' && type !== 'preferred')
      throw new HttpError(400, 'Type must be vacation or preferred.');

    const existing = db.timeOff.find((t) => t.userId === userId && t.date === date);
    if (existing)
      throw new HttpError(409, 'You already have a request on that day. Remove it first.');

    // Must-have-off requests are free at request time — vacation is only
    // charged after a schedule is generated, if the days kept the person under
    // their required shifts. The per-day cap still protects coverage. Both
    // checks run against fresh state under the write lock, so concurrent
    // requests can't slip past them.
    if (type === 'vacation') {
      const dayCount = vacationCountForDate(db, date);
      if (dayCount >= db.settings.maxVacationPerDay) {
        throw new HttpError(400, `That day is full: ${dayCount} people already have it off (max ${db.settings.maxVacationPerDay}).`);
      }
    }

    const e = { id: newId('t'), userId, date, type };
    db.timeOff.push(e);
    return e;
  });
  res.json(entry);
}));

app.delete('/api/timeoff/:id', handle(async (req, res) => {
  await withMutation((db) => {
    const authed = authedUser(db, req);
    const idx = db.timeOff.findIndex((t) => t.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'Request not found.');
    const entry = db.timeOff[idx];
    const isAdmin = (authed.roles || []).includes('role-admin');
    if (entry.userId !== authed.id && !isAdmin)
      throw new HttpError(403, 'You can only delete your own time-off requests.');
    db.timeOff.splice(idx, 1);
  });
  res.json({ ok: true });
}));

// ---- away time (admin-managed; never counts against vacation) ----
// Optional free-text fields: `label` is shown to the employee (calendar chip,
// away card); `memo` is an admin-only note. Blank collapses to absent.
const awayText = (v: unknown, max: number): string | undefined => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || undefined;
};

app.post('/api/awaytime', handle(async (req, res) => {
  const entry = await withMutation((db) => {
    requireAdmin(db, req);
    const { userId, start, end } = req.body;
    const user = db.users.find((u) => u.id === userId);
    if (!user) throw new HttpError(404, 'User not found.');
    if (!isDate(start) || !isDate(end)) throw new HttpError(400, 'Away time needs a valid start and end date.');
    if (end < start) throw new HttpError(400, 'The away end date must be on or after the start date.');
    const e = {
      id: newId('aw'), userId, start, end,
      ...(awayText(req.body.label, 255) ? { label: awayText(req.body.label, 255) } : {}),
      ...(awayText(req.body.memo, 10000) ? { memo: awayText(req.body.memo, 10000) } : {}),
    };
    db.awayTime.push(e);
    return e;
  });
  res.json(entry);
}));

app.put('/api/awaytime/:id', handle(async (req, res) => {
  const entry = await withMutation((db) => {
    requireAdmin(db, req);
    const entry = db.awayTime.find((a) => a.id === req.params.id);
    if (!entry) throw new HttpError(404, 'Away time not found.');
    checkVersion(entry, req.body.expectedVersion, 'This away-time range');
    const newStart = req.body.start !== undefined ? req.body.start : entry.start;
    const newEnd = req.body.end !== undefined ? req.body.end : entry.end;
    if (!isDate(newStart) || !isDate(newEnd)) throw new HttpError(400, 'Away time needs a valid start and end date.');
    if (newEnd < newStart) throw new HttpError(400, 'The away end date must be on or after the start date.');
    entry.start = newStart;
    entry.end = newEnd;
    if (req.body.label !== undefined) entry.label = awayText(req.body.label, 255);
    if (req.body.memo !== undefined) entry.memo = awayText(req.body.memo, 10000);
    bumpVersion(entry);
    return entry;
  });
  res.json(entry);
}));

app.delete('/api/awaytime/:id', handle(async (req, res) => {
  await withMutation((db) => {
    requireAdmin(db, req);
    const idx = db.awayTime.findIndex((a) => a.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'Away time not found.');
    db.awayTime.splice(idx, 1);
  });
  res.json({ ok: true });
}));

// ---- holidays ----
app.post('/api/holidays', handle(async (req, res) => {
  const entry = await withMutation((db) => {
    requireAdmin(db, req);
    const { name, recurrence } = req.body;
    if (!name || typeof name !== 'string') throw new HttpError(400, 'A holiday needs a name.');
    if (!isValidRecurrence(recurrence)) throw new HttpError(400, 'A holiday needs a valid recurrence.');
    const e = { id: newId('hol'), name: name.trim(), workable: !!req.body.workable, recurrence };
    db.holidays.push(e);
    return e;
  });
  res.json(entry);
}));

app.put('/api/holidays/:id', handle(async (req, res) => {
  const entry = await withMutation((db) => {
    requireAdmin(db, req);
    const entry = db.holidays.find((h) => h.id === req.params.id);
    if (!entry) throw new HttpError(404, 'Holiday not found.');
    checkVersion(entry, req.body.expectedVersion, `The holiday "${entry.name}"`);
    if (req.body.name !== undefined) {
      if (!req.body.name || typeof req.body.name !== 'string') throw new HttpError(400, 'A holiday needs a name.');
      entry.name = req.body.name.trim();
    }
    if (req.body.recurrence !== undefined) {
      if (!isValidRecurrence(req.body.recurrence)) throw new HttpError(400, 'A holiday needs a valid recurrence.');
      entry.recurrence = req.body.recurrence;
    }
    if (req.body.workable !== undefined) entry.workable = !!req.body.workable;
    bumpVersion(entry);
    return entry;
  });
  res.json(entry);
}));

app.delete('/api/holidays/:id', handle(async (req, res) => {
  await withMutation((db) => {
    requireAdmin(db, req);
    const idx = db.holidays.findIndex((h) => h.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'Holiday not found.');
    db.holidays.splice(idx, 1);
  });
  res.json({ ok: true });
}));

// ---- schedules ----
app.post('/api/schedules', handle(async (req, res) => {
  const schedule = await withMutation((db) => {
    requireAdmin(db, req);
    const cadence = db.settings.cadence;
    if (!cadence) throw new HttpError(400, 'Configure a schedule cadence in Settings first.');
    if (db.shiftTypes.length === 0)
      throw new HttpError(400, 'Configure at least one shift type first.');
    if (db.users.length === 0)
      throw new HttpError(400, 'Add employees to the roster first.');
    const blockIndex = Number(req.body.blockIndex);
    if (!Number.isInteger(blockIndex) || blockIndex < 0)
      throw new HttpError(400, 'Pick a schedule block.');
    // Only the offered window (current block + next 4) may be generated.
    const firstBlock = currentBlockIndex(cadence, todayYmd());
    if (blockIndex < firstBlock || blockIndex > firstBlock + 4)
      throw new HttpError(400, 'That block is outside the selectable window.');
    const { startDate, endDate } = blockRange(cadence, blockIndex);
    // Fresh-state check under the lock (plus a UNIQUE(start_date) backstop in
    // the schema) — two admins generating the same block can't both win.
    if (db.schedules.some((s) => s.startDate === startDate))
      throw new HttpError(400, 'A schedule for this block already exists — delete it first to regenerate.');

    const requested = Array.isArray(req.body.userIds) ? req.body.userIds : null;
    const userIds = (requested || db.users.map((u) => u.id)).filter((id: string) =>
      db.users.some((u) => u.id === id)
    );
    if (userIds.length === 0)
      throw new HttpError(400, 'Include at least one person in the block.');
    const { nextRotationCursor, ...result } = generateSchedule(db, {
      startDate,
      endDate,
      userIds,
    });
    const schedule = {
      id: newId('sch'),
      startDate,
      endDate,
      userIds,
      createdAt: new Date().toISOString(),
      extraElections: {},
      ...result,
    };
    db.schedules.push(schedule);
    db.meta.rotationCursor = nextRotationCursor;
    return schedule;
  });
  res.json(schedule);
}));

// Manual assignment editing: fill an open slot, hand a shift to someone else,
// or unassign a shift back to open. Hard rules (vacation, one shift per day,
// 8h rest) still apply to the receiving employee.
app.post('/api/schedules/:id/reassign', handle(async (req, res) => {
  const schedule = await withMutation((db) => {
    requireAdmin(db, req);
    const schedule = db.schedules.find((s) => s.id === req.params.id);
    if (!schedule) throw new HttpError(404, 'Schedule not found.');
    const { date, shiftTypeId, fromUserId, toUserId } = req.body;
    const st = db.shiftTypes.find((s) => s.id === shiftTypeId);
    if (!st) throw new HttpError(400, 'Shift type no longer exists.');

    if (toUserId) {
      const to = db.users.find((u) => u.id === toUserId);
      if (!to) throw new HttpError(404, 'Employee not found.');
      const moving = fromUserId
        ? schedule.assignments.find(
            (a) => a.date === date && a.shiftTypeId === shiftTypeId && a.userId === fromUserId
          )
        : null;
      // Safety rules (vacation, one-shift-per-day, rest, night cap) are shared
      // with shift trading; admin reassignment additionally enforces the cap.
      const err = canTakeShift(db, schedule, { date, shiftTypeId }, to, moving ? [moving] : []);
      if (err) throw new HttpError(400, err);
      // Weight-0 (standby) shifts don't count toward the shift maximum.
      const shiftById = Object.fromEntries(db.shiftTypes.map((s) => [s.id, s]));
      const maxAllowed = effectiveMaximums(db).get(to.id) ?? Infinity;
      const countingHeld = schedule.assignments.filter(
        (a) =>
          a.userId === toUserId && a !== moving && weightOf(shiftById[a.shiftTypeId]) > 0
      ).length;
      if (weightOf(st) > 0 && countingHeld + 1 > maxAllowed)
        throw new HttpError(400, `${to.name} is already at their maximum of ${maxAllowed} shifts for this schedule.`);
    }

    if (!fromUserId) {
      // Fill an open slot.
      if (!toUserId) throw new HttpError(400, 'Pick an employee for the open shift.');
      const idx = schedule.unfilled.findIndex(
        (s) => s.date === date && s.shiftTypeId === shiftTypeId
      );
      if (idx === -1) throw new HttpError(404, 'Open shift not found.');
      schedule.unfilled.splice(idx, 1);
      schedule.assignments.push({ date, shiftTypeId, userId: toUserId });
    } else {
      const a = schedule.assignments.find(
        (x) => x.date === date && x.shiftTypeId === shiftTypeId && x.userId === fromUserId
      );
      if (!a) throw new HttpError(404, 'Assignment not found.');
      if (toUserId) {
        a.userId = toUserId;
      } else {
        schedule.assignments.splice(schedule.assignments.indexOf(a), 1);
        schedule.unfilled.push({ date, shiftTypeId });
      }
    }

    const { counts, warnings } = summarizeSchedule(db, schedule);
    schedule.counts = counts;
    schedule.warnings = warnings;
    return schedule;
  });
  res.json(schedule);
}));

app.delete('/api/schedules/:id', handle(async (req, res) => {
  await withMutation((db) => {
    requireAdmin(db, req);
    const idx = db.schedules.findIndex((s) => s.id === req.params.id);
    if (idx === -1) throw new HttpError(404, 'Schedule not found.');
    db.schedules.splice(idx, 1);
  });
  res.json({ ok: true });
}));

// ---- shift trading ----
// Trade functions mutate the db and return { trade } or { error, code }.
// withMutation persists whatever changed even when the outcome is an error —
// some failures (like expiring a stale trade) legitimately change state.
const sendTradeResult = (res: Response, r: any) =>
  r.error
    ? res.status(r.code || 400).json({ error: r.error, ...(r.code === 409 ? { code: 'conflict' } : {}) })
    : res.json(r.trade);

app.post('/api/trades', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    return createTrade(db, { ...req.body, fromUserId: authed.id });
  }))));

app.post('/api/trades/:id/respond', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    return respondToOpenTrade(db, req.params.id, { ...req.body, userId: authed.id });
  }))));

app.post('/api/trades/:id/withdraw', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    return withdrawResponse(db, req.params.id, { ...req.body, userId: authed.id });
  }))));

app.post('/api/trades/:id/accept', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    const trade = db.trades.find((t) => t.id === req.params.id);
    if (!trade) return { error: 'Trade not found.', code: 404 };
    const body = { ...req.body, userId: authed.id };
    return trade.type === 'open'
      ? acceptOpenResponse(db, req.params.id, body)
      : acceptDirect(db, req.params.id, body);
  }))));

app.post('/api/trades/:id/reject', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    return rejectDirect(db, req.params.id, { ...req.body, userId: authed.id });
  }))));

app.post('/api/trades/:id/claim', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    return claimGiveaway(db, req.params.id, { ...req.body, userId: authed.id });
  }))));

app.post('/api/trades/:id/cancel', handle(async (req, res) =>
  sendTradeResult(res, await withMutation((db) => {
    const authed = authedUser(db, req);
    return cancelTrade(db, req.params.id, { ...req.body, userId: authed.id });
  }))));

// Read-only eligibility lookups so the UI only offers feasible trades.
app.get('/api/schedules/:id/trade-options', handle(async (req, res) => {
  const db = await readState();
  const authed = authedUser(db, req);
  return res.json(tradeOptions(db, req.params.id, authed.id));
}));

app.get('/api/schedules/:id/swap-partners', handle(async (req, res) => {
  const db = await readState();
  const authed = authedUser(db, req);
  return res.json(
    swapPartners(db, req.params.id, authed.id, {
      date: req.query.date as string,
      shiftTypeId: req.query.shiftTypeId as string,
    })
  );
}));

// Split your extra days (worked beyond required) into extra vacation and
// incentive pay. Repeatable — the new split replaces the old one.
app.put('/api/schedules/:id/extra-election', handle(async (req, res) => {
  const r = await withMutation((db) => {
    const authed = authedUser(db, req);
    return setExtraElection(db, req.params.id, { ...req.body, userId: authed.id });
  });
  return r.error ? res.status((r as any).code || 400).json({ error: r.error }) : res.json(r.election);
}));

app.put('/api/notifications/read', handle(async (req, res) => {
  await withMutation((db) => {
    const authed = authedUser(db, req);
    for (const n of db.notifications) {
      if (n.userId === authed.id) n.read = true;
    }
  });
  res.json({ ok: true });
}));

// Dismissing hides a notification from the Trades inbox for good. The bulk
// route clears the viewer's whole list; the per-id route clears one.
app.put('/api/notifications/dismiss', handle(async (req, res) => {
  await withMutation((db) => {
    const authed = authedUser(db, req);
    for (const n of db.notifications) {
      if (n.userId === authed.id) { n.read = true; n.dismissed = true; }
    }
  });
  res.json({ ok: true });
}));

app.put('/api/notifications/:id/dismiss', handle(async (req, res) => {
  await withMutation((db) => {
    const authed = authedUser(db, req);
    const n = db.notifications.find((x) => x.id === req.params.id);
    if (!n) throw new HttpError(404, 'Notification not found.');
    if (n.userId !== authed.id)
      throw new HttpError(403, 'You can only dismiss your own notifications.');
    n.read = true;
    n.dismissed = true;
  });
  res.json({ ok: true });
}));

// ---- personal calendar export ----
app.get('/api/schedules/:id/ics', handle(async (req, res) => {
  const db = await readState();
  const schedule = db.schedules.find((s) => s.id === req.params.id);
  if (!schedule) throw new HttpError(404, 'Schedule not found.');
  const authed = authedUser(db, req);
  const isAdmin = (authed.roles || []).includes('role-admin');
  // Non-admins always get their own ICS; admins may pass ?userId for someone else.
  const targetId = isAdmin && req.query.userId ? req.query.userId as string : authed.id;
  const user = db.users.find((u) => u.id === targetId);
  if (!user) throw new HttpError(404, 'User not found.');
  const mine = schedule.assignments.filter((a) => a.userId === user.id);
  const ics = buildIcs({
    user,
    assignments: mine,
    shiftTypes: db.shiftTypes,
    scheduleId: schedule.id,
  });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="shifts-${user.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ics"`
  );
  res.send(ics);
}));

// ---- static hosting of the built frontend (after `npm run build`) ----
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// API_PORT, not PORT — dev tools (e.g. preview panels) inject PORT for the
// frontend server, and the API must not steal it.
const PORT = process.env.API_PORT || 3001;
initDb()
  .then(async () => {
    const pool = getPool();
    const db = await readState();
    // Ensure every user has a credential row (idempotent).
    await ensureCredentialRows(pool, db.users.map((u) => u.id));
    // Bootstrap: if no admin has registered, print a one-time setup link.
    const map = await registeredMap(pool);
    const admins = db.users.filter((u) => (u.roles || []).includes('role-admin'));
    const anyAdminRegistered = admins.some((u) => map[u.id]);
    if (!anyAdminRegistered && admins.length > 0) {
      const firstAdmin = admins[0];
      const rawToken = await createInvite(pool, firstAdmin.id);
      const link = inviteLink(rawToken);
      console.log(`\n[bootstrap] No admin has a password yet. One-time setup link:\n  ${link}\n`);
    }
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// Every committed transaction is durable — nothing to flush on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0));
}
