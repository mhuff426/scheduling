// Seeds the database with demo data. Run: tsx server/seed.ts
// Overwrites any existing data — delete or skip if you have real data.
// Targets the database from the usual DB_* env vars (dev default ShiftlyDev0).
import type { Db } from '../shared/types.js';
import { getDbConfig } from './config.js';
import { normalizeDb } from './db.js';
import { createDbPool, ensureDatabase, ensureSchema, replaceAllCollections, waitForDb } from './mysql.js';

const data = {
  users: [
    { id: 'u-admin', name: 'Morgan (Manager)', role: 'admin', vacationDays: 15, color: '#6366f1' },
    { id: 'u-alice', name: 'Alice Chen', role: 'employee', vacationDays: 10, color: '#ef4444' },
    { id: 'u-bob', name: 'Bob Rivera', role: 'employee', vacationDays: 10, color: '#f97316' },
    { id: 'u-cara', name: 'Cara Okafor', role: 'employee', vacationDays: 12, color: '#22c55e' },
    { id: 'u-dev', name: 'Dev Patel', role: 'employee', vacationDays: 8, color: '#0ea5e9' },
  ],
  shiftTypes: [
    { id: 's-day', name: 'Day', startTime: '08:00', endTime: '16:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 },
    { id: 's-eve', name: 'Evening', startTime: '16:00', endTime: '00:00', frequency: 'daily', dayOfWeek: null, staffRequired: 1 },
    { id: 's-inv', name: 'Inventory', startTime: '10:00', endTime: '14:00', frequency: 'weekly', dayOfWeek: 1, staffRequired: 1 },
  ],
  settings: { maxVacationPerDay: 2 },
  timeOff: [
    { id: 't-1', userId: 'u-alice', date: '2026-06-18', type: 'vacation' },
    { id: 't-2', userId: 'u-alice', date: '2026-06-19', type: 'vacation' },
    { id: 't-3', userId: 'u-bob', date: '2026-06-22', type: 'preferred' },
    { id: 't-4', userId: 'u-cara', date: '2026-06-18', type: 'vacation' },
    { id: 't-5', userId: 'u-dev', date: '2026-06-26', type: 'preferred' },
  ],
  schedules: [],
} as unknown as Db;

async function main() {
  const cfg = getDbConfig();
  await ensureDatabase(cfg);
  const pool = createDbPool(cfg);
  try {
    await waitForDb(pool, 3);
    await ensureSchema(pool);
    // normalizeDb fills the missing collections and migrates the legacy
    // `role` field into role tags.
    await replaceAllCollections(pool, normalizeDb(data));
    console.log(`Seeded demo data into ${cfg.host}:${cfg.port}/${cfg.database}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
