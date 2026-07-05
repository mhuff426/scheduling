// CommonJS config (.cjs): this repo is "type":"module", and the installed
// Node (18.12) is below Playwright's 18.19 floor for loading an ESM config —
// so the config itself must be CommonJS.
//
// The spec files are ESM TypeScript (.spec.ts). On this Node version Playwright
// hands them to Node's native ESM loader, which can't transpile .ts ("Unknown
// file extension"). Register tsx's ESM loader via NODE_OPTIONS here (before the
// runner spawns its loader/worker processes, which inherit this env) so the
// .ts specs load. Idempotent; harmless if already set.
if (!(process.env.NODE_OPTIONS || '').includes('tsx/esm')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --loader tsx/esm`.trim();
}

const { defineConfig, devices } = require('@playwright/test');

// e2e runs against an ISOLATED MySQL database (ShiftlyE2E0 — never the real
// dev database, ShiftlyDev0). The gated /api/test/reset endpoint
// (E2E_TESTING=1) fully re-seeds it before each test. MySQL must be up:
// `npm run db:up` (the server creates ShiftlyE2E0 if it's missing).

// The dev script boots both the API (server/index.js) and Vite (port 5173).
// NODE_EXTRA_CA_CERTS is forwarded so npm/node calls survive the Norton TLS
// proxy on this dev machine.
module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // Never reuse a stale server: it may be running old code or pointed at the
    // real dev DB, which silently breaks the seeded-isolation the specs rely on.
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS
        || `${process.env.USERPROFILE || process.env.HOME}/.proxy-ca.pem`,
      DB_NAME: 'ShiftlyE2E0',
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_PORT: process.env.DB_PORT || '3306',
      DB_USER: process.env.DB_USER || 'root',
      DB_PASSWORD: process.env.DB_PASSWORD || 'shiftly',
      E2E_TESTING: '1',
    },
  },
});
