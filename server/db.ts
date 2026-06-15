import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Db, User } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_DATA: Db = {
  users: [
    { id: 'u-admin', name: 'Admin', role: 'admin', vacationDays: 15, color: '#6366f1', requiredShifts: null },
  ],
  shiftTypes: [],
  settings: { maxVacationPerDay: 2, cadence: null },
  timeOff: [],
  schedules: [],
  trades: [],
  notifications: [],
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
  for (const u of loaded.users) u.requiredShifts ??= null;
  cache = loaded;
  return loaded;
}

export function saveDb(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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
