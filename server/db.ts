import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Db, RoleTag, User } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
// DATA_FILE may be overridden via env (e2e points it at an isolated, seeded
// file so tests never touch the real dev datastore).
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');

// The two roles the system always provides; they can't be renamed or deleted.
const SYSTEM_ROLES: RoleTag[] = [
  { id: 'role-admin', name: 'Admin', system: true },
  { id: 'role-employee', name: 'Employee', system: true },
];

const DEFAULT_DATA: Db = {
  users: [
    { id: 'u-admin', name: 'Admin', roles: ['role-admin', 'role-employee'], vacationDays: 15, color: '#6366f1', requiredShifts: null },
  ],
  roles: SYSTEM_ROLES.map((r) => ({ ...r })),
  shiftTypes: [],
  settings: { maxVacationPerDay: 2, cadence: null },
  timeOff: [],
  schedules: [],
  trades: [],
  notifications: [],
  awayTime: [],
  meta: { rotationCursor: 0 },
};

let cache: Db | null = null;

export function loadDb(): Db {
  if (cache) return cache;
  if (!fs.existsSync(DATA_FILE)) {
    cache = structuredClone(DEFAULT_DATA);
    saveDb();
    return cache;
  }
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Db;
  // Defaults for fields added after the data file was first created.
  loaded.settings.cadence ??= null;
  loaded.meta ??= { rotationCursor: 0 };
  loaded.trades ??= [];
  loaded.notifications ??= [];
  loaded.awayTime ??= [];
  // Roles: ensure the list exists and both system roles are always present.
  loaded.roles ??= [];
  for (const sys of SYSTEM_ROLES) {
    if (!loaded.roles.some((r) => r.id === sys.id)) loaded.roles.push({ ...sys });
  }
  for (const u of loaded.users) {
    u.requiredShifts ??= null;
    // Migrate the legacy single `role` field into role tags (then it's dead).
    u.roles ??= [];
    if ((u as any).role === 'admin' && !u.roles.includes('role-admin')) u.roles.push('role-admin');
    if (!u.roles.includes('role-employee')) u.roles.push('role-employee');
    u.theme ??= 'light';
    u.othersColorMode ??= 'distinct';
    u.othersSharedColor ??= '#9ca3af';
    u.shiftColors ??= {};
  }
  for (const st of loaded.shiftTypes) st.allowedRoles ??= [];
  cache = loaded;
  return loaded;
}

export function saveDb(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Test-only: overwrite the (isolated) data file with a known seed and drop the
// in-memory cache so the next loadDb() reads it fresh. Used by the e2e reset
// endpoint to give each test a deterministic starting state.
export function installDbForTests(newDb: Db): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(newDb, null, 2));
  cache = null;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
