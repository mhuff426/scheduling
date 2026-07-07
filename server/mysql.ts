// Row <-> object mapping between MySQL and the Db shape, plus the pool
// factory. The unit of persistence is a whole collection (a top-level Db
// key): replacing one means DELETE from its parent table(s) — children go via
// FK CASCADE — and bulk re-INSERT from the object. Row counts are tiny, so
// this stays simple and atomic. Transaction ownership lives with the caller
// (db.ts readState/withMutation) via writeCollections/loadAllFromMysql; the
// pool-based replaceCollections wrappers exist for offline tooling.
//
// Conventions (see schema.ts): strings for all temporal values, `position`
// preserves array order, BOOLEAN comes back from mysql2 as 0/1 and is coerced
// with !! on load, `undefined` is never passed as a parameter (mysql2 throws)
// — always `?? null`.
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type {
  AwayTime, Db, Holiday, HolidayRecurrence, Notification, RoleTag, Schedule,
  Settings, ShiftType, TimeOff, Trade, User,
} from '../shared/types.js';
import type { DbConfig } from './config.js';
import { ensureSchema } from './schema.js';

export type CollectionKey = keyof Db;
export const COLLECTION_KEYS: CollectionKey[] = [
  'users', 'roles', 'shiftTypes', 'settings', 'timeOff', 'schedules',
  'trades', 'notifications', 'awayTime', 'holidays', 'meta',
];

export function createDbPool(cfg: DbConfig): Pool {
  return mysql.createPool({
    ...cfg,
    connectionLimit: 5,
    // Backstop: no DATE/DATETIME columns exist, but if one ever appears it
    // must come back as a string, never a JS Date.
    dateStrings: true,
  });
}

// Dev/e2e convenience: create the target database when it doesn't exist yet
// (the docker-entrypoint init script only runs on first volume creation).
// Production never calls this — Aurora databases are provisioned explicitly.
export async function ensureDatabase(cfg: DbConfig): Promise<void> {
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, ssl: cfg.ssl as any,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  } finally {
    await conn.end();
  }
}

// Retry initial connectivity: covers the window where the MySQL container was
// just started (db:up --wait normally closes it, but be forgiving).
export async function waitForDb(pool: Pool, attempts = 10, delayMs = 1000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export { ensureSchema };

// ---------------------------------------------------------------------------
// Save: object -> rows
// ---------------------------------------------------------------------------

interface TableRows { table: string; columns: string[]; rows: unknown[][] }

// The parent table(s) to DELETE for a collection replace; child tables clear
// via ON DELETE CASCADE.
const PARENT_TABLES: Record<CollectionKey, string[]> = {
  users: ['users'],
  roles: ['roles'],
  shiftTypes: ['shift_types'],
  settings: ['settings'],
  timeOff: ['time_off'],
  schedules: ['schedules'],
  trades: ['trades'],
  notifications: ['notifications'],
  awayTime: ['away_time'],
  holidays: ['holidays'],
  meta: ['meta'],
};

function rowsFor(key: CollectionKey, db: Db): TableRows[] {
  switch (key) {
    case 'users': {
      const users: unknown[][] = [];
      const userRoles: unknown[][] = [];
      db.users.forEach((u, i) => {
        users.push([
          u.id, u.name, u.vacationDays, u.color,
          u.requiredShifts ?? null, u.maxShiftsOverride ?? null,
          u.maxConsecutiveNights ?? null, u.startDate ?? null, u.theme ?? null,
          u.version ?? 1, i,
        ]);
        (u.roles || []).forEach((rid, j) => userRoles.push([u.id, rid, j]));
      });
      return [
        { table: 'users', columns: ['id', 'name', 'vacation_days', 'color', 'required_shifts', 'max_shifts_override', 'max_consecutive_nights', 'start_date', 'theme', 'version', 'position'], rows: users },
        { table: 'user_roles', columns: ['user_id', 'role_id', 'position'], rows: userRoles },
      ];
    }
    case 'roles':
      return [{
        table: 'roles', columns: ['id', 'name', 'system', 'version', 'position'],
        rows: db.roles.map((r, i) => [r.id, r.name, r.system ? 1 : 0, r.version ?? 1, i]),
      }];
    case 'shiftTypes': {
      const types: unknown[][] = [];
      const allowed: unknown[][] = [];
      db.shiftTypes.forEach((st, i) => {
        types.push([
          st.id, st.name, st.startTime, st.endTime, st.frequency,
          st.dayOfWeek ?? null, st.staffRequired, st.minRun ?? null,
          st.maxRun ?? null, st.weight ?? null, st.version ?? 1, i,
        ]);
        (st.allowedRoles || []).forEach((rid, j) => allowed.push([st.id, rid, j]));
      });
      return [
        { table: 'shift_types', columns: ['id', 'name', 'start_time', 'end_time', 'frequency', 'day_of_week', 'staff_required', 'min_run', 'max_run', 'weight', 'version', 'position'], rows: types },
        { table: 'shift_type_allowed_roles', columns: ['shift_type_id', 'role_id', 'position'], rows: allowed },
      ];
    }
    case 'settings': {
      const s = db.settings;
      return [{
        table: 'settings',
        columns: ['id', 'max_vacation_per_day', 'holidays_required_per_year', 'cadence_anchor_date', 'cadence_length_unit', 'cadence_length_value', 'version'],
        rows: [[1, s.maxVacationPerDay, s.holidaysRequiredPerYear ?? 0, s.cadence?.anchorDate ?? null, s.cadence?.lengthUnit ?? null, s.cadence?.lengthValue ?? null, s.version ?? 1]],
      }];
    }
    case 'meta':
      return [{
        table: 'meta', columns: ['id', 'rotation_cursor'],
        rows: [[1, db.meta?.rotationCursor ?? 0]],
      }];
    case 'timeOff':
      return [{
        table: 'time_off', columns: ['id', 'user_id', 'date', 'type', 'position'],
        rows: db.timeOff.map((t, i) => [t.id, t.userId, t.date, t.type, i]),
      }];
    case 'awayTime':
      return [{
        table: 'away_time', columns: ['id', 'user_id', 'start_date', 'end_date', 'version', 'position'],
        rows: db.awayTime.map((a, i) => [a.id, a.userId, a.start, a.end, a.version ?? 1, i]),
      }];
    case 'holidays':
      return [{
        table: 'holidays',
        columns: ['id', 'name', 'workable', 'recurrence_type', 'month', 'day_of_month', 'weekday', 'ordinal', 'date', 'version', 'position'],
        rows: db.holidays.map((h, i) => {
          const r = h.recurrence;
          return [
            h.id, h.name, h.workable ? 1 : 0, r.type,
            r.type === 'one-off' ? null : r.month,
            r.type === 'yearly' ? r.day : null,
            r.type === 'nth-weekday' ? r.weekday : null,
            r.type === 'nth-weekday' ? r.ordinal : null,
            r.type === 'one-off' ? r.date : null,
            h.version ?? 1,
            i,
          ];
        }),
      }];
    case 'schedules': {
      const schedules: unknown[][] = [];
      const schedUsers: unknown[][] = [];
      const assignments: unknown[][] = [];
      const unfilled: unknown[][] = [];
      const counts: unknown[][] = [];
      const warnings: unknown[][] = [];
      const vacCharged: unknown[][] = [];
      const elections: unknown[][] = [];
      const prefAsks: unknown[][] = [];
      db.schedules.forEach((s, i) => {
        schedules.push([s.id, s.startDate, s.endDate, s.createdAt, s.preferenceStats?.median ?? null, i]);
        (s.userIds || []).forEach((uid, j) => schedUsers.push([s.id, uid, j]));
        (s.assignments || []).forEach((a, j) => assignments.push([s.id, a.date, a.shiftTypeId, a.userId, j]));
        (s.unfilled || []).forEach((u, j) => unfilled.push([s.id, u.date, u.shiftTypeId, j]));
        for (const [uid, n] of Object.entries(s.counts || {})) counts.push([s.id, uid, n]);
        (s.warnings || []).forEach((w, j) => warnings.push([s.id, w, j]));
        for (const [uid, n] of Object.entries(s.vacationCharged || {})) vacCharged.push([s.id, uid, n]);
        for (const [uid, e] of Object.entries(s.extraElections || {})) elections.push([s.id, uid, e.vacation, e.incentive]);
        for (const [uid, n] of Object.entries(s.preferenceStats?.asks || {})) prefAsks.push([s.id, uid, n]);
      });
      return [
        { table: 'schedules', columns: ['id', 'start_date', 'end_date', 'created_at', 'preference_median', 'position'], rows: schedules },
        { table: 'schedule_users', columns: ['schedule_id', 'user_id', 'position'], rows: schedUsers },
        { table: 'assignments', columns: ['schedule_id', 'date', 'shift_type_id', 'user_id', 'position'], rows: assignments },
        { table: 'schedule_unfilled', columns: ['schedule_id', 'date', 'shift_type_id', 'position'], rows: unfilled },
        { table: 'schedule_counts', columns: ['schedule_id', 'user_id', 'shift_count'], rows: counts },
        { table: 'schedule_warnings', columns: ['schedule_id', 'message', 'position'], rows: warnings },
        { table: 'schedule_vacation_charged', columns: ['schedule_id', 'user_id', 'days'], rows: vacCharged },
        { table: 'schedule_extra_elections', columns: ['schedule_id', 'user_id', 'vacation', 'incentive'], rows: elections },
        { table: 'schedule_preference_asks', columns: ['schedule_id', 'user_id', 'asks'], rows: prefAsks },
      ];
    }
    case 'trades': {
      const trades: unknown[][] = [];
      const responses: unknown[][] = [];
      db.trades.forEach((t, i) => {
        trades.push([
          t.id, t.scheduleId, t.type, t.status, t.fromUserId,
          t.offered.date, t.offered.shiftTypeId,
          t.toUserId ?? null, t.requested?.date ?? null, t.requested?.shiftTypeId ?? null,
          t.claimedBy ?? null, t.createdAt, t.resolvedAt ?? null, i,
        ]);
        (t.responses || []).forEach((r, j) => responses.push([t.id, r.userId, r.date, r.shiftTypeId, r.at, j]));
      });
      return [
        { table: 'trades', columns: ['id', 'schedule_id', 'type', 'status', 'from_user_id', 'offered_date', 'offered_shift_type_id', 'to_user_id', 'requested_date', 'requested_shift_type_id', 'claimed_by', 'created_at', 'resolved_at', 'position'], rows: trades },
        { table: 'trade_responses', columns: ['trade_id', 'user_id', 'date', 'shift_type_id', 'at', 'position'], rows: responses },
      ];
    }
    case 'notifications':
      return [{
        table: 'notifications',
        columns: ['id', 'user_id', 'message', 'trade_id', 'is_read', 'dismissed', 'created_at', 'position'],
        rows: db.notifications.map((n, i) => [
          n.id, n.userId, n.message, n.tradeId ?? null, n.read ? 1 : 0,
          n.dismissed === undefined ? null : (n.dismissed ? 1 : 0), n.createdAt, i,
        ]),
      }];
  }
}

async function writeCollection(conn: PoolConnection, key: CollectionKey, db: Db): Promise<void> {
  for (const table of PARENT_TABLES[key]) await conn.query(`DELETE FROM \`${table}\``);
  for (const { table, columns, rows } of rowsFor(key, db)) {
    if (!rows.length) continue;
    const cols = columns.map((c) => `\`${c}\``).join(', ');
    // Bulk `VALUES ?` expansion requires .query(), not .execute().
    await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ?`, [rows]);
  }
}

// Replace the given collections on an EXISTING connection — the caller owns
// the transaction (db.ts withMutation runs this inside its lock transaction).
export async function writeCollections(conn: PoolConnection, db: Db, keys: CollectionKey[]): Promise<void> {
  for (const key of keys) await writeCollection(conn, key, db);
}

// Pool-based wrapper: replace the given collections in their own transaction.
// Used by offline tooling (import script, seed) — the app itself goes through
// db.ts withMutation.
export async function replaceCollections(pool: Pool, db: Db, keys: CollectionKey[]): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await writeCollections(conn, db, keys);
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

export function replaceAllCollections(pool: Pool, db: Db): Promise<void> {
  return replaceCollections(pool, db, COLLECTION_KEYS);
}

// ---------------------------------------------------------------------------
// Load: rows -> object
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
type Queryable = Pool | PoolConnection;

async function all(conn: Queryable, table: string, orderBy = '`position`'): Promise<Row[]> {
  const [rows] = await conn.query(`SELECT * FROM \`${table}\` ORDER BY ${orderBy}`);
  return rows as Row[];
}

function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

function recordOf(rows: Row[], valueOf: (r: Row) => any, key = 'user_id'): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of rows) out[r[key]] = valueOf(r);
  return out;
}

// Returns null when the database has never been seeded (no settings row) —
// the caller decides how to initialize (parallels the old missing-file branch).
// Accepts a plain pool (independent reads) or a single connection (mysql2
// serializes queued queries per connection, so the Promise.all works either
// way — on a connection it just runs sequentially inside that transaction).
export async function loadAllFromMysql(conn: Queryable): Promise<Db | null> {
  const [settingsRows, metaRows] = await Promise.all([
    all(conn, 'settings', '`id`'), all(conn, 'meta', '`id`'),
  ]);
  if (!settingsRows.length) return null;

  const [
    userRows, userRoleRows, roleRows, shiftTypeRows, allowedRoleRows, timeOffRows,
    awayRows, holidayRows, scheduleRows, schedUserRows, assignmentRows, unfilledRows,
    countRows, warningRows, vacChargedRows, electionRows, prefAskRows,
    tradeRows, responseRows, notificationRows,
  ] = await Promise.all([
    all(conn, 'users'), all(conn, 'user_roles'), all(conn, 'roles'),
    all(conn, 'shift_types'), all(conn, 'shift_type_allowed_roles'), all(conn, 'time_off'),
    all(conn, 'away_time'), all(conn, 'holidays'), all(conn, 'schedules'),
    all(conn, 'schedule_users'), all(conn, 'assignments'), all(conn, 'schedule_unfilled'),
    all(conn, 'schedule_counts', '`schedule_id`, `user_id`'), all(conn, 'schedule_warnings'),
    all(conn, 'schedule_vacation_charged', '`schedule_id`, `user_id`'),
    all(conn, 'schedule_extra_elections', '`schedule_id`, `user_id`'),
    all(conn, 'schedule_preference_asks', '`schedule_id`, `user_id`'),
    all(conn, 'trades'), all(conn, 'trade_responses'), all(conn, 'notifications'),
  ]);

  const s = settingsRows[0];
  const settings: Settings = {
    maxVacationPerDay: s.max_vacation_per_day,
    cadence: s.cadence_anchor_date == null ? null : {
      anchorDate: s.cadence_anchor_date,
      lengthUnit: s.cadence_length_unit,
      lengthValue: s.cadence_length_value,
    },
    holidaysRequiredPerYear: s.holidays_required_per_year,
    version: s.version ?? 1,
  };

  const rolesByUser = groupBy(userRoleRows, 'user_id');
  const users: User[] = userRows.map((r) => ({
    id: r.id,
    name: r.name,
    roles: (rolesByUser.get(r.id) || []).map((x) => x.role_id),
    vacationDays: r.vacation_days,
    color: r.color,
    requiredShifts: r.required_shifts,
    ...(r.max_shifts_override == null ? {} : { maxShiftsOverride: r.max_shifts_override }),
    ...(r.max_consecutive_nights == null ? {} : { maxConsecutiveNights: r.max_consecutive_nights }),
    ...(r.start_date == null ? {} : { startDate: r.start_date }),
    ...(r.theme == null ? {} : { theme: r.theme }),
    version: r.version ?? 1,
  }));

  // Omit `system` on custom roles (the JSON shape only carries it when true).
  const roles: RoleTag[] = roleRows.map((r) => ({
    id: r.id, name: r.name, ...(r.system ? { system: true } : {}), version: r.version ?? 1,
  }));

  const allowedByType = groupBy(allowedRoleRows, 'shift_type_id');
  const shiftTypes: ShiftType[] = shiftTypeRows.map((r) => ({
    id: r.id,
    name: r.name,
    startTime: r.start_time,
    endTime: r.end_time,
    frequency: r.frequency,
    dayOfWeek: r.day_of_week,
    staffRequired: r.staff_required,
    ...(r.min_run == null ? {} : { minRun: r.min_run }),
    maxRun: r.max_run,
    weight: r.weight,
    allowedRoles: (allowedByType.get(r.id) || []).map((x) => x.role_id),
    version: r.version ?? 1,
  }));

  const timeOff: TimeOff[] = timeOffRows.map((r) => ({
    id: r.id, userId: r.user_id, date: r.date, type: r.type,
  }));

  const awayTime: AwayTime[] = awayRows.map((r) => ({
    id: r.id, userId: r.user_id, start: r.start_date, end: r.end_date, version: r.version ?? 1,
  }));

  const holidays: Holiday[] = holidayRows.map((r) => {
    let recurrence: HolidayRecurrence;
    if (r.recurrence_type === 'yearly') recurrence = { type: 'yearly', month: r.month, day: r.day_of_month };
    else if (r.recurrence_type === 'nth-weekday') recurrence = { type: 'nth-weekday', month: r.month, weekday: r.weekday, ordinal: r.ordinal };
    else recurrence = { type: 'one-off', date: r.date };
    return { id: r.id, name: r.name, workable: !!r.workable, recurrence, version: r.version ?? 1 };
  });

  const usersBySched = groupBy(schedUserRows, 'schedule_id');
  const assignsBySched = groupBy(assignmentRows, 'schedule_id');
  const unfilledBySched = groupBy(unfilledRows, 'schedule_id');
  const countsBySched = groupBy(countRows, 'schedule_id');
  const warningsBySched = groupBy(warningRows, 'schedule_id');
  const chargedBySched = groupBy(vacChargedRows, 'schedule_id');
  const electionsBySched = groupBy(electionRows, 'schedule_id');
  const asksBySched = groupBy(prefAskRows, 'schedule_id');
  const schedules: Schedule[] = scheduleRows.map((r) => ({
    id: r.id,
    startDate: r.start_date,
    endDate: r.end_date,
    userIds: (usersBySched.get(r.id) || []).map((x) => x.user_id),
    assignments: (assignsBySched.get(r.id) || []).map((a) => ({ userId: a.user_id, date: a.date, shiftTypeId: a.shift_type_id })),
    unfilled: (unfilledBySched.get(r.id) || []).map((u) => ({ date: u.date, shiftTypeId: u.shift_type_id })),
    counts: recordOf(countsBySched.get(r.id) || [], (x) => x.shift_count),
    warnings: (warningsBySched.get(r.id) || []).map((w) => w.message),
    createdAt: r.created_at,
    vacationCharged: recordOf(chargedBySched.get(r.id) || [], (x) => x.days),
    extraElections: recordOf(electionsBySched.get(r.id) || [], (x) => ({ vacation: x.vacation, incentive: x.incentive })),
    ...(r.preference_median == null ? {} : {
      preferenceStats: {
        asks: recordOf(asksBySched.get(r.id) || [], (x) => x.asks),
        median: r.preference_median,
      },
    }),
  }));

  const responsesByTrade = groupBy(responseRows, 'trade_id');
  const trades: Trade[] = tradeRows.map((r) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    type: r.type,
    status: r.status,
    fromUserId: r.from_user_id,
    offered: { date: r.offered_date, shiftTypeId: r.offered_shift_type_id },
    toUserId: r.to_user_id,
    requested: r.requested_date == null ? null : { date: r.requested_date, shiftTypeId: r.requested_shift_type_id },
    responses: (responsesByTrade.get(r.id) || []).map((x) => ({ userId: x.user_id, date: x.date, shiftTypeId: x.shift_type_id, at: x.at })),
    claimedBy: r.claimed_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));

  const notifications: Notification[] = notificationRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    message: r.message,
    ...(r.trade_id == null ? {} : { tradeId: r.trade_id }),
    read: !!r.is_read,
    ...(r.dismissed == null ? {} : { dismissed: !!r.dismissed }),
    createdAt: r.created_at,
  }));

  return {
    users, roles, shiftTypes, settings, timeOff, schedules, trades,
    notifications, awayTime, holidays,
    meta: { rotationCursor: metaRows[0]?.rotation_cursor ?? 0 },
  };
}
