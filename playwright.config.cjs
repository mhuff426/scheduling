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
const fs = require('fs');
const os = require('os');
const path = require('path');

// e2e runs against an ISOLATED data file (never the real dev datastore). Write
// the known seed to a temp file and point the API at it via DATA_FILE; the
// gated /api/test/reset endpoint (E2E_TESTING=1) re-seeds it before each test.
const E2E_DATA = path.join(os.tmpdir(), 'scheduling-e2e-data.json');
fs.writeFileSync(E2E_DATA, JSON.stringify(require('./e2e/seed.json'), null, 2));

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
      DATA_FILE: E2E_DATA,
      E2E_TESTING: '1',
    },
  },
});
