// Database connection config, resolved from env vars (optionally via a .env
// file — see .env.example). Dev defaults match docker-compose.yml, so a plain
// `npm run dev` works with zero configuration. In production (Aurora MySQL)
// every value must be provided explicitly — the defaults would silently point
// a prod deploy at localhost, so we fail fast instead.
//
// Validation happens inside getDbConfig(), never at module scope: db.ts is
// imported by business logic and unit tests that must load without any
// database configured.
import 'dotenv/config';
import fs from 'fs';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: { minVersion: string; ca?: string };
}

export function getDbConfig(): DbConfig {
  const prod = process.env.NODE_ENV === 'production';
  const req = (name: string, devDefault: string): string => {
    const v = process.env[name];
    if (!v && prod) throw new Error(`${name} is required when NODE_ENV=production`);
    return v || devDefault;
  };
  return {
    host: req('DB_HOST', '127.0.0.1'),
    port: Number(process.env.DB_PORT || 3306),
    user: req('DB_USER', 'root'),
    password: req('DB_PASSWORD', 'shiftly'),
    database: req('DB_NAME', 'ShiftlyDev0'),
    // Aurora requires TLS in transit; set DB_SSL=true and point DB_SSL_CA at
    // the RDS CA bundle (details to be established at prod setup time).
    ssl: process.env.DB_SSL === 'true'
      ? {
          minVersion: 'TLSv1.2',
          ca: process.env.DB_SSL_CA ? fs.readFileSync(process.env.DB_SSL_CA, 'utf8') : undefined,
        }
      : undefined,
  };
}
