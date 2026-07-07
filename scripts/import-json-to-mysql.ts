// One-time (re-runnable) import of the legacy JSON datastore into MySQL.
// Usage: npm run db:import [-- path/to/data.json]
// Fully replaces the target database's contents with the file's, so it is
// idempotent. Connection comes from the usual DB_* env vars (dev defaults
// point at docker-compose's ShiftlyDev0).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Db } from '../shared/types.js';
import { getDbConfig } from '../server/config.js';
import { normalizeDb } from '../server/db.js';
import {
  COLLECTION_KEYS, createDbPool, ensureDatabase, ensureSchema,
  replaceAllCollections, waitForDb,
} from '../server/mysql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const source = process.argv[2] || path.join(__dirname, '..', 'data', 'data.json');
  if (!fs.existsSync(source)) {
    console.error(`Source file not found: ${source}`);
    process.exit(1);
  }
  const db = normalizeDb(JSON.parse(fs.readFileSync(source, 'utf8')) as Db);

  const cfg = getDbConfig();
  console.log(`Importing ${source}`);
  console.log(`     into ${cfg.host}:${cfg.port}/${cfg.database}`);
  for (const k of COLLECTION_KEYS) {
    const v = db[k];
    console.log(`  ${k}: ${Array.isArray(v) ? v.length : 1}`);
  }

  await ensureDatabase(cfg);
  const pool = createDbPool(cfg);
  try {
    await waitForDb(pool, 3);
    await ensureSchema(pool);
    await replaceAllCollections(pool, db);
    const [rows] = await pool.query(
      'SELECT table_name AS t, table_rows AS n FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
      [cfg.database]
    );
    console.log('Imported. Table row counts (approximate, from information_schema):');
    for (const r of rows as { t: string; n: number }[]) console.log(`  ${r.t}: ${r.n}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
