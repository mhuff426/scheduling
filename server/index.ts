import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, readState, withMutation, newId, resetDbForTests, getPool } from './db.js';
import type { CollectionKey } from './mysql.js';
import { needsConfirmation, parseConfirmedWarnings } from './eligibility.js';
import { confirmationRefusal } from '../shared/confirmation.js';
import type { ConfirmationRefusal, EligibilityWarning } from '../shared/confirmation.js';
import {
  createTrade, respondToOpenTrade, withdrawResponse, acceptTrade, rejectDirect, claimGiveaway, cancelTrade,
  setExtraElection, tradeOptions, swapPartners,
} from './trades.js';
import { runCommand, mapOutcome, type Command, type CommandContext, type Outcome } from './outcome.js';
import { updateSettings } from './cadence.js';
import { createShiftType, editShiftType, deleteShiftType } from './shiftTypes.js';
import { createHoliday, editHoliday, deleteHoliday } from './holidays.js';
import { createAwayTime, editAwayTime, deleteAwayTime } from './awayTime.js';
import { buildIcs } from './ics.js';
import { requestMustOff, withdrawMustOff } from './mustOff.js';
import { createPerson, editPerson, removePerson, createRole, renameRole, deleteRole } from './people.js';
import { project, tradeSeenBy, type ReadRequest, type Refusal } from './projection.js';
import { can, capabilitiesOf, type Capability } from './capabilities.js';
import type { Db, Trade, User } from '../shared/types.js';
import { buildSchedule, deleteSchedule, reassignShift } from './schedules.js';
import { isValidCadence, todayYmd } from '../shared/blocks.js';
import {
  passwordProblem, verifyPassword, ensureCredentialRows, getCredential,
  setPassword, createInvite, findUserIdByInviteToken, registeredMap,
} from './auth.js';
import { attachSession, sessionUserId, createSession, destroySession, sessionCookie, clearedSessionCookie, parseCookies } from './sessions.js';
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
// outcomes are domain commands returning an Outcome instead (see sendCommand).
class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

// Confirmation contract (ADR 0001): refuse a mutation whose eligibility
// warnings the request hasn't confirmed, carrying the warnings so the client
// can ask and resend with `confirmedWarnings` (the warning messages).
class ConfirmationRequired extends Error {
  constructor(public refusal: ConfirmationRefusal) {
    super(refusal.error);
  }
}
function requireConfirmed(warnings: EligibilityWarning[], confirmedWarnings: string[]): void {
  if (needsConfirmation(warnings, confirmedWarnings)) throw new ConfirmationRequired(confirmationRefusal(warnings));
}

// Express 4 doesn't catch rejected async handlers — every route goes through
// this wrapper.
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      if (e instanceof ConfirmationRequired) return res.status(409).json(e.refusal);
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

// The route adapter for domain commands (ADR 0003): runs `command` in one
// transaction as the session user, as of today, and sends its outcome. A
// refusal rolls back unless it persists; outcome.ts maps reasons to statuses.
// Call it inside handle(), which still turns thrown errors into 500/503.
const sendCommand = async <T>(req: Request, res: Response, command: Command<T>) => {
  const { status, body } = await runCommand(withMutation, sessionUserId(req), todayYmd(), command);
  res.status(status).json(body);
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

// One refusal per reason, shared by the projection's refusals and the
// capability checks, so a read and a write refuse the same way.
const REFUSALS: Record<Refusal, HttpError> = {
  unauthenticated: new HttpError(401, 'Please log in.', 'unauthenticated'),
  forbidden: new HttpError(403, 'Admin access required.'),
  not_found: new HttpError(404, 'Unknown tab.'),
};

/** Returns the authed User, or throws 401. */
function authedUser(db: Db, req: Request): User {
  const uid = sessionUserId(req);
  const u = uid ? db.users.find((x) => x.id === uid) : undefined;
  if (!u) throw REFUSALS.unauthenticated;
  return u;
}

/**
 * Returns the authed User if they have the named capability, else throws 403.
 * Capabilities come from the viewer's current roles, read fresh on every request.
 */
function requireCapability(db: Db, req: Request, capability: Capability): User {
  const u = authedUser(db, req);
  if (!can(u, capability)) throw REFUSALS.forbidden;
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
  const uid = sessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in.' });
  const db = await readState();
  const user = db.users.find((u) => u.id === uid);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const map = await registeredMap(getPool());
  // The viewer's capabilities ride with their user record: the UI's hint for
  // which controls to show. The server still checks every request.
  return res.json({ user: redactUser(user, !!map[user.id]), capabilities: capabilitiesOf(user) });
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

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ---- whole app state (kept for debugging/tooling; the client fetches per tab) ----
// ---- reads: thin adapters over the read projection (ADR 0002) ----
// Each tab fetches only the collections it renders. Cross-tab data (users,
// notifications) deliberately has its OWN endpoints — fetched alongside
// every tab and easy to upgrade to an SSE stream later.
async function projectRead(req: Request, request: ReadRequest): Promise<object> {
  const db = await readState();
  const out = project(db, sessionUserId(req), request);
  if ('refused' in out) throw REFUSALS[out.refused];
  return 'state' in out ? out.state : out;
}

// Whole app state, for debugging/tooling (admin-only); the client fetches per tab.
app.get('/api/state', handle(async (req, res) => {
  res.json(await projectRead(req, { kind: 'state' }));
}));

app.get('/api/tabs/:tab', handle(async (req, res) => {
  res.json(await projectRead(req, { kind: 'tab', tab: req.params.tab }));
}));

app.get('/api/users', handle(async (req, res) => {
  // Refuse before touching the credential store.
  if (!sessionUserId(req)) throw REFUSALS.unauthenticated;
  res.json(await projectRead(req, { kind: 'users', registered: await registeredMap(getPool()) }));
}));

app.get('/api/notifications', handle(async (req, res) => {
  const db = await readState();
  const user = authedUser(db, req);
  res.json({ notifications: db.notifications.filter((n) => n.userId === user.id) });
}));

// ---- roster (commands in ./people.ts) ----
// Creating a person commits the data first; the credential row and invite
// are made after, outside the transaction.
app.post('/api/users', handle(async (req, res) => {
  const out = await runCommand(withMutation, sessionUserId(req), todayYmd(), (db, ctx) => createPerson(db, ctx, req.body));
  if (out.status !== 200) return res.status(out.status).json(out.body);
  const user = out.body as User;
  const pool = getPool();
  await ensureCredentialRows(pool, [user.id]);
  const rawToken = await createInvite(pool, user.id);
  const link = inviteLink(rawToken);
  const { delivered } = await sendInviteEmail({ to: user.email!, name: user.name, link });
  res.json({ ...redactUser(user, false), ...(delivered ? {} : { inviteLink: link }) });
}));

app.put('/api/users/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => editPerson(db, ctx, { ...req.body, id: req.params.id }))));

app.delete('/api/users/:id', handle(async (req, res) => {
  const out = await runCommand(withMutation, sessionUserId(req), todayYmd(), (db, ctx) => removePerson(db, ctx, { id: req.params.id }));
  if (out.status === 200) {
    // Explicit cleanup of auth tables (no FK cascade — see schema comments).
    const pool = getPool();
    await pool.query('DELETE FROM `user_credentials` WHERE `user_id` = ?', [req.params.id]);
    await pool.query('DELETE FROM `sessions` WHERE `user_id` = ?', [req.params.id]);
  }
  res.status(out.status).json(out.body);
}));

// ---- resend invite ----
app.post('/api/users/:id/resend-invite', handle(async (req, res) => {
  const db = await readState();
  requireCapability(db, req, 'managePeople');
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

// ---- employee roles (commands in ./people.ts) ----
app.post('/api/roles', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => createRole(db, ctx, req.body))));

app.put('/api/roles/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => renameRole(db, ctx, { ...req.body, id: req.params.id }))));

app.delete('/api/roles/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => deleteRole(db, ctx, { id: req.params.id }))));

// ---- shift types (./shiftTypes.ts) ----
app.post('/api/shift-types', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => createShiftType(db, ctx, req.body))));

app.put('/api/shift-types/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => editShiftType(db, ctx, { ...req.body, id: req.params.id }))));

app.delete('/api/shift-types/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => deleteShiftType(db, ctx, { id: req.params.id }))));

// ---- settings ----
app.put('/api/settings', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => updateSettings(db, ctx, req.body ?? {}))));

// ---- time off requests ----
app.post('/api/timeoff', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => requestMustOff(db, ctx, req.body))));

app.delete('/api/timeoff/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => withdrawMustOff(db, ctx, { id: req.params.id }))));

// ---- away time (./awayTime.ts; admin-managed, never counts against vacation) ----
app.post('/api/awaytime', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => createAwayTime(db, ctx, req.body))));

app.put('/api/awaytime/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => editAwayTime(db, ctx, { ...req.body, id: req.params.id }))));

app.delete('/api/awaytime/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => deleteAwayTime(db, ctx, { id: req.params.id }))));

// ---- holidays (./holidays.ts) ----
app.post('/api/holidays', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => createHoliday(db, ctx, req.body))));

app.put('/api/holidays/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => editHoliday(db, ctx, { ...req.body, id: req.params.id }))));

app.delete('/api/holidays/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => deleteHoliday(db, ctx, { id: req.params.id }))));

// ---- schedules ----
app.post('/api/schedules', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => buildSchedule(db, ctx, req.body))));

app.post('/api/schedules/:id/reassign', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => reassignShift(db, ctx, { ...req.body, id: req.params.id }))));

app.delete('/api/schedules/:id', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => deleteSchedule(db, ctx, { id: req.params.id }))));

// ---- shift trading ----
// Trade commands (./trades.ts) run through sendCommand. The trade in a
// response is the one the actor's projection would show, never the raw row
// (an employee never receives a coworker's responses).
const seenByActor = (db: Db, ctx: CommandContext, o: Outcome<Trade>) =>
  mapOutcome(o, (trade) => tradeSeenBy(db, ctx.actor.id, trade));

// A trade request's body with its `confirmedWarnings` read into messages, and
// the trade named in the path.
const tradeInput = (req: Request) => ({
  ...req.body, tradeId: req.params.id,
  confirmedWarnings: parseConfirmedWarnings(req.body?.confirmedWarnings),
});

app.post('/api/trades', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, createTrade(db, ctx, tradeInput(req))))));

app.post('/api/trades/:id/respond', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, respondToOpenTrade(db, ctx, tradeInput(req))))));

app.post('/api/trades/:id/withdraw', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, withdrawResponse(db, ctx, tradeInput(req))))));

app.post('/api/trades/:id/accept', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, acceptTrade(db, ctx, tradeInput(req))))));

app.post('/api/trades/:id/reject', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, rejectDirect(db, ctx, tradeInput(req))))));

app.post('/api/trades/:id/claim', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, claimGiveaway(db, ctx, tradeInput(req))))));

app.post('/api/trades/:id/cancel', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => seenByActor(db, ctx, cancelTrade(db, ctx, tradeInput(req))))));

// Read-only eligibility lookups so the UI only offers feasible trades.
app.get('/api/schedules/:id/trade-options', handle(async (req, res) => {
  const db = await readState();
  const authed = authedUser(db, req);
  return res.json(tradeOptions(db, req.params.id, authed.id, todayYmd()));
}));

app.get('/api/schedules/:id/swap-partners', handle(async (req, res) => {
  const db = await readState();
  const authed = authedUser(db, req);
  return res.json(
    swapPartners(db, req.params.id, authed.id, {
      date: req.query.date as string,
      shiftTypeId: req.query.shiftTypeId as string,
    }, todayYmd())
  );
}));

// Split your extra days (worked beyond required) into extra vacation and
// incentive pay. Repeatable — the new split replaces the old one.
app.put('/api/schedules/:id/extra-election', handle((req, res) =>
  sendCommand(req, res, (db, ctx) => setExtraElection(db, ctx, { ...req.body, scheduleId: req.params.id }))));

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
  // Without "see everyone's records" a viewer always gets their own ICS;
  // with it they may pass ?userId for someone else.
  const targetId = can(authed, 'seeEveryonesRecords') && req.query.userId ? req.query.userId as string : authed.id;
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
    const admins = db.users.filter((u) => can(u, 'managePeople'));
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
