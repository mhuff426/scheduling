// MySQL schema: one table set per Db collection (fully normalized — child
// tables rather than JSON columns). Conventions, chosen for byte-exact
// round-trips of the in-memory Db object:
//
// - Temporal values are stored as strings (CHAR(10) 'YYYY-MM-DD' dates,
//   CHAR(5) 'HH:MM' times, VARCHAR(32) ISO-8601 timestamps) because the app
//   compares them lexicographically. Never DATE/DATETIME.
// - Array-backed tables carry a `position` column; loads ORDER BY position so
//   array order (palette assignment, rotation, response ordering) survives.
// - BOOLEAN columns (MySQL stores these as TINYINT(1) and returns 0/1 — the
//   loader coerces back to real booleans).
// - Child tables FK their same-collection parent ON DELETE CASCADE so a
//   collection replace is DELETE-parent + re-INSERT. NO cross-collection FKs:
//   the app logic owns referential integrity (as it did with the JSON file),
//   which keeps collection replacement order irrelevant.
// - `read` -> `is_read`, awayTime `start`/`end` -> `start_date`/`end_date`
//   (reserved words); all identifiers backtick-quoted.
import type { Pool } from 'mysql2/promise';

const TABLE_SUFFIX = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

export const SCHEMA_STATEMENTS: string[] = [
  // Single-row lock table: every mutation SELECT ... FOR UPDATEs this row so
  // writes serialize across requests AND app instances (see db.ts withAppLock).
  `CREATE TABLE IF NOT EXISTS \`app_lock\` (
    \`id\` TINYINT NOT NULL PRIMARY KEY CHECK (\`id\` = 1)
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`users\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`name\` VARCHAR(255) NOT NULL,
    \`vacation_days\` INT NOT NULL,
    \`color\` VARCHAR(16) NOT NULL,
    \`required_shifts\` INT NULL,
    \`max_shifts_override\` INT NULL,
    \`max_consecutive_nights\` INT NULL,
    \`start_date\` CHAR(10) NULL,
    \`theme\` VARCHAR(8) NULL,
    \`version\` INT NOT NULL DEFAULT 1,
    \`position\` INT NOT NULL
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`user_roles\` (
    \`user_id\` VARCHAR(64) NOT NULL,
    \`role_id\` VARCHAR(64) NOT NULL,
    \`position\` INT NOT NULL,
    PRIMARY KEY (\`user_id\`, \`role_id\`),
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`roles\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`name\` VARCHAR(255) NOT NULL,
    \`system\` BOOLEAN NOT NULL DEFAULT FALSE,
    \`version\` INT NOT NULL DEFAULT 1,
    \`position\` INT NOT NULL,
    UNIQUE KEY \`uq_roles_name\` (\`name\`)
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`shift_types\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`name\` VARCHAR(255) NOT NULL,
    \`start_time\` CHAR(5) NOT NULL,
    \`end_time\` CHAR(5) NOT NULL,
    \`frequency\` VARCHAR(8) NOT NULL,
    \`day_of_week\` TINYINT NULL,
    \`staff_required\` INT NOT NULL,
    \`min_run\` INT NULL,
    \`max_run\` INT NULL,
    \`weight\` DOUBLE NULL,
    \`version\` INT NOT NULL DEFAULT 1,
    \`position\` INT NOT NULL
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`shift_type_allowed_roles\` (
    \`shift_type_id\` VARCHAR(64) NOT NULL,
    \`role_id\` VARCHAR(64) NOT NULL,
    \`position\` INT NOT NULL,
    PRIMARY KEY (\`shift_type_id\`, \`role_id\`),
    FOREIGN KEY (\`shift_type_id\`) REFERENCES \`shift_types\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`settings\` (
    \`id\` TINYINT NOT NULL PRIMARY KEY CHECK (\`id\` = 1),
    \`max_vacation_per_day\` INT NOT NULL,
    \`holidays_required_per_year\` INT NOT NULL DEFAULT 0,
    \`cadence_anchor_date\` CHAR(10) NULL,
    \`cadence_length_unit\` VARCHAR(10) NULL,
    \`cadence_length_value\` INT NULL,
    \`version\` INT NOT NULL DEFAULT 1
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`meta\` (
    \`id\` TINYINT NOT NULL PRIMARY KEY CHECK (\`id\` = 1),
    \`rotation_cursor\` INT NOT NULL
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`time_off\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`date\` CHAR(10) NOT NULL,
    \`type\` VARCHAR(10) NOT NULL,
    \`position\` INT NOT NULL,
    INDEX \`idx_time_off_user\` (\`user_id\`),
    INDEX \`idx_time_off_date_type\` (\`date\`, \`type\`),
    UNIQUE KEY \`uq_time_off_user_date\` (\`user_id\`, \`date\`)
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`away_time\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`start_date\` CHAR(10) NOT NULL,
    \`end_date\` CHAR(10) NOT NULL,
    \`version\` INT NOT NULL DEFAULT 1,
    \`position\` INT NOT NULL
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`holidays\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`name\` VARCHAR(255) NOT NULL,
    \`workable\` BOOLEAN NOT NULL,
    \`recurrence_type\` VARCHAR(12) NOT NULL,
    \`month\` TINYINT NULL,
    \`day_of_month\` TINYINT NULL,
    \`weekday\` TINYINT NULL,
    \`ordinal\` TINYINT NULL,
    \`date\` CHAR(10) NULL,
    \`version\` INT NOT NULL DEFAULT 1,
    \`position\` INT NOT NULL
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedules\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`start_date\` CHAR(10) NOT NULL,
    \`end_date\` CHAR(10) NOT NULL,
    \`created_at\` VARCHAR(32) NOT NULL,
    \`preference_median\` DOUBLE NULL,
    \`position\` INT NOT NULL,
    UNIQUE KEY \`uq_schedules_start\` (\`start_date\`)
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_users\` (
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`position\` INT NOT NULL,
    PRIMARY KEY (\`schedule_id\`, \`user_id\`),
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  // Surrogate PK: duplicate (date, shiftTypeId) rows are legal when a shift
  // needs more than one person.
  `CREATE TABLE IF NOT EXISTS \`assignments\` (
    \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`date\` CHAR(10) NOT NULL,
    \`shift_type_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`position\` INT NOT NULL,
    INDEX \`idx_assignments_schedule\` (\`schedule_id\`),
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_unfilled\` (
    \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`date\` CHAR(10) NOT NULL,
    \`shift_type_id\` VARCHAR(64) NOT NULL,
    \`position\` INT NOT NULL,
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_counts\` (
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`shift_count\` DOUBLE NOT NULL,
    PRIMARY KEY (\`schedule_id\`, \`user_id\`),
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_warnings\` (
    \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`message\` TEXT NOT NULL,
    \`position\` INT NOT NULL,
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_vacation_charged\` (
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`days\` DOUBLE NOT NULL,
    PRIMARY KEY (\`schedule_id\`, \`user_id\`),
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_extra_elections\` (
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`vacation\` DOUBLE NOT NULL,
    \`incentive\` DOUBLE NOT NULL,
    PRIMARY KEY (\`schedule_id\`, \`user_id\`),
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`schedule_preference_asks\` (
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`asks\` DOUBLE NOT NULL,
    PRIMARY KEY (\`schedule_id\`, \`user_id\`),
    FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedules\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`trades\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`schedule_id\` VARCHAR(64) NOT NULL,
    \`type\` VARCHAR(10) NOT NULL,
    \`status\` VARCHAR(10) NOT NULL,
    \`from_user_id\` VARCHAR(64) NOT NULL,
    \`offered_date\` CHAR(10) NOT NULL,
    \`offered_shift_type_id\` VARCHAR(64) NOT NULL,
    \`to_user_id\` VARCHAR(64) NULL,
    \`requested_date\` CHAR(10) NULL,
    \`requested_shift_type_id\` VARCHAR(64) NULL,
    \`claimed_by\` VARCHAR(64) NULL,
    \`created_at\` VARCHAR(32) NOT NULL,
    \`resolved_at\` VARCHAR(32) NULL,
    \`position\` INT NOT NULL
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`trade_responses\` (
    \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`trade_id\` VARCHAR(64) NOT NULL,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`date\` CHAR(10) NOT NULL,
    \`shift_type_id\` VARCHAR(64) NOT NULL,
    \`at\` VARCHAR(32) NOT NULL,
    \`position\` INT NOT NULL,
    FOREIGN KEY (\`trade_id\`) REFERENCES \`trades\`(\`id\`) ON DELETE CASCADE
  ) ${TABLE_SUFFIX}`,
  `CREATE TABLE IF NOT EXISTS \`notifications\` (
    \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`user_id\` VARCHAR(64) NOT NULL,
    \`message\` TEXT NOT NULL,
    \`trade_id\` VARCHAR(64) NULL,
    \`is_read\` BOOLEAN NOT NULL DEFAULT FALSE,
    \`dismissed\` BOOLEAN NULL,
    \`created_at\` VARCHAR(32) NOT NULL,
    \`position\` INT NOT NULL,
    INDEX \`idx_notifications_user\` (\`user_id\`)
  ) ${TABLE_SUFFIX}`,
];

// CREATE TABLE IF NOT EXISTS skips existing tables, so columns/indexes added
// after a database was first created need explicit, idempotent ALTERs.
async function ensureColumn(pool: Pool, table: string, column: string, ddl: string): Promise<void> {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (!(rows as unknown[]).length) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  }
}

async function ensureIndex(pool: Pool, table: string, index: string, ddl: string): Promise<void> {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [table, index]
  );
  // A unique ALTER failing on dirty pre-existing data fails boot loudly on
  // purpose — clean the duplicates rather than tolerating them silently.
  if (!(rows as unknown[]).length) {
    await pool.query(`ALTER TABLE \`${table}\` ADD ${ddl}`);
  }
}

const VERSIONED_TABLES = ['users', 'roles', 'shift_types', 'settings', 'away_time', 'holidays'];

export async function ensureSchema(pool: Pool): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) await pool.query(stmt);
  // The lock row every mutation FOR UPDATEs (idempotent).
  await pool.query('INSERT IGNORE INTO `app_lock` (`id`) VALUES (1)');
  // Migrations for databases created before these columns/keys existed.
  for (const t of VERSIONED_TABLES) {
    await ensureColumn(pool, t, 'version', '`version` INT NOT NULL DEFAULT 1');
  }
  await ensureIndex(pool, 'time_off', 'uq_time_off_user_date', 'UNIQUE KEY `uq_time_off_user_date` (`user_id`, `date`)');
  await ensureIndex(pool, 'schedules', 'uq_schedules_start', 'UNIQUE KEY `uq_schedules_start` (`start_date`)');
  await ensureIndex(pool, 'roles', 'uq_roles_name', 'UNIQUE KEY `uq_roles_name` (`name`)');
}
