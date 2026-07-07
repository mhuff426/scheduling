// Persistence: MySQL is the single source of truth; there is NO in-memory
// cache. Reads (`readState`) load a consistent snapshot; mutations
// (`withMutation`) run in one transaction that holds a global lock row
// (SELECT ... FOR UPDATE on `app_lock`), so writes serialize across requests
// AND across app instances — every mutation's business logic runs against
// fresh, exclusive state, which is what makes the existing validation guards
// (trade status checks, vacation caps/balances, duplicate checks) genuinely
// race-free. External edits (import script, Workbench, other instances) are
// visible on the next read.
//
// IMPORTANT: this module must stay free of top-level side effects (no pool
// creation, no config validation at import time) — trades.ts, scheduler.ts,
// and the unit tests import its pure helpers and must load with no database
// configured or running.
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Db, RoleTag, User } from '../shared/types.js';
import { getDbConfig } from './config.js';
import {
  COLLECTION_KEYS, createDbPool, ensureDatabase, ensureSchema,
  loadAllFromMysql, writeCollections, waitForDb,
  type CollectionKey,
} from './mysql.js';

// The two roles the system always provides; they can't be renamed or deleted.
const SYSTEM_ROLES: RoleTag[] = [
  { id: 'role-admin', name: 'Admin', system: true },
  { id: 'role-employee', name: 'Employee', system: true },
];

export const DEFAULT_DATA: Db = {
  users: [
    { id: 'u-admin', name: 'Admin', roles: ['role-admin', 'role-employee'], vacationDays: 15, color: '#6366f1', requiredShifts: null },
  ],
  roles: SYSTEM_ROLES.map((r) => ({ ...r })),
  shiftTypes: [],
  settings: { maxVacationPerDay: 2, cadence: null, holidaysRequiredPerYear: 0 },
  timeOff: [],
  schedules: [],
  trades: [],
  notifications: [],
  awayTime: [],
  holidays: [],
  meta: { rotationCursor: 0 },
};

let pool: Pool | null = null;

// Defaults and legacy migrations for data predating newer fields. Pure and
// idempotent — shared by every load, the JSON import script, and test resets.
export function normalizeDb(loaded: Db): Db {
  loaded.settings.cadence ??= null;
  loaded.meta ??= { rotationCursor: 0 };
  loaded.trades ??= [];
  loaded.notifications ??= [];
  loaded.awayTime ??= [];
  loaded.holidays ??= [];
  loaded.settings.holidaysRequiredPerYear ??= 0;
  loaded.settings.version ??= 1;
  // Migrate legacy flat-date holidays to the recurrence shape (as one-offs, so
  // their meaning is preserved exactly; new holidays default to yearly in the UI).
  for (const h of loaded.holidays) {
    if (!h.recurrence && (h as any).date) {
      h.recurrence = { type: 'one-off', date: (h as any).date };
      delete (h as any).date;
    }
    h.version ??= 1;
  }
  // Roles: ensure the list exists and both system roles are always present.
  loaded.roles ??= [];
  for (const sys of SYSTEM_ROLES) {
    if (!loaded.roles.some((r) => r.id === sys.id)) loaded.roles.push({ ...sys });
  }
  for (const r of loaded.roles) r.version ??= 1;
  for (const u of loaded.users) {
    u.requiredShifts ??= null;
    // Migrate the legacy single `role` field into role tags (then it's dead).
    u.roles ??= [];
    if ((u as any).role === 'admin' && !u.roles.includes('role-admin')) u.roles.push('role-admin');
    if (!u.roles.includes('role-employee')) u.roles.push('role-employee');
    u.theme ??= 'light';
    u.version ??= 1;
  }
  for (const st of loaded.shiftTypes) {
    st.allowedRoles ??= [];
    st.version ??= 1;
  }
  for (const a of loaded.awayTime) a.version ??= 1;
  return loaded;
}

// Connect and make sure the schema (incl. idempotent migrations) and initial
// data exist. Must complete before the server accepts requests.
export async function initDb(): Promise<void> {
  const cfg = getDbConfig();
  // The docker-entrypoint init script only runs on first volume creation, so
  // create the target database if it's missing (dev/e2e only — Aurora
  // databases are provisioned explicitly).
  if (process.env.NODE_ENV !== 'production') await ensureDatabase(cfg);
  pool = createDbPool(cfg);
  await waitForDb(pool);
  await ensureSchema(pool);
  // Never-seeded database — parallels the old "data file missing" branch.
  await withAppLock(async (conn) => {
    if (!(await loadAllFromMysql(conn))) {
      await writeCollections(conn, normalizeDb(structuredClone(DEFAULT_DATA)), COLLECTION_KEYS);
    }
  });
}

// Connection + open transaction + the exclusive app-wide write lock. Lock
// waiters queue; 10s is generous given mutations hold it for milliseconds.
async function withAppLock<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('Database not initialized — initDb() must complete first.');
  const conn = await pool.getConnection();
  try {
    await conn.query('SET SESSION innodb_lock_wait_timeout = 10');
    await conn.beginTransaction();
    await conn.query('SELECT `id` FROM `app_lock` WHERE `id` = 1 FOR UPDATE');
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// A consistent read snapshot (REPEATABLE READ). Never takes the write lock,
// so reads don't block writers or each other.
export async function readState(): Promise<Db> {
  if (!pool) throw new Error('Database not initialized — initDb() must complete first.');
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const loaded = await loadAllFromMysql(conn);
    await conn.commit();
    if (!loaded) throw new Error('Database is empty — initDb() must complete first.');
    return normalizeDb(loaded);
  } finally {
    conn.release();
  }
}

// Run a mutation against fresh state under the exclusive lock, then persist
// whichever collections it changed — all in one transaction.
//
// Semantics: the mutator's mutations COMMIT even when it reports a business
// error via a return value (trade functions mutate state — e.g. expiring a
// stale trade — before returning { error, code }). To abort with a rollback,
// THROW instead (validation-style failures that happen before any mutation).
export async function withMutation<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  return withAppLock(async (conn) => {
    const loaded = await loadAllFromMysql(conn);
    if (!loaded) throw new Error('Database is empty — initDb() must complete first.');
    const db = normalizeDb(loaded);
    const before: Partial<Record<CollectionKey, string>> = {};
    for (const k of COLLECTION_KEYS) before[k] = JSON.stringify(db[k]);
    const result = await fn(db);
    const dirty = COLLECTION_KEYS.filter((k) => JSON.stringify(db[k]) !== before[k]);
    if (dirty.length) await writeCollections(conn, db, dirty);
    return result;
  });
}

// Test-only: atomically replace the entire database with a known seed. Takes
// the same lock, so it queues behind any in-flight mutation — no torn resets.
export async function resetDbForTests(seed: Db): Promise<void> {
  await withAppLock(async (conn) => {
    await writeCollections(conn, normalizeDb(structuredClone(seed)), COLLECTION_KEYS);
  });
}

export function newId(prefix: string): string {
  // Two random segments: cheap insurance against same-millisecond collisions
  // across app instances (in-process writes are serialized by the app lock).
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${Math.random().toString(36).slice(2, 7)}`;
}

// Vacation accounting is settled from schedule outcomes, not at request time:
// each schedule carries a vacationCharged ledger (must-off days that kept the
// person under their required shifts, plus giveaway charges). A schedule's
// charges and elections belong to the calendar year of its start date.
export function vacationUsed(db: Db, userId: string, year: number): number {
  let used = 0;
  for (const s of db.schedules || []) {
    if (!s.startDate?.startsWith(String(year))) continue;
    used += s.vacationCharged?.[userId] || 0;
  }
  return used;
}

// Allowance for the year: the base grant, plus extra days the user elected to
// convert into vacation, minus what schedules have charged.
export function vacationAvailable(db: Db, user: User, year: number): number {
  let earned = 0;
  for (const s of db.schedules || []) {
    if (!s.startDate?.startsWith(String(year))) continue;
    earned += s.extraElections?.[user.id]?.vacation || 0;
  }
  return user.vacationDays + earned - vacationUsed(db, user.id, year);
}

export function vacationCountForDate(db: Db, date: string): number {
  return db.timeOff.filter((t) => t.date === date && t.type === 'vacation').length;
}
