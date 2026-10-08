import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

// Playwright owns every server a run needs: it builds fresh artifacts, serves
// them, and runs a synchronization server on a throwaway database. Ports are
// chosen per run, so concurrent runs (other checkouts or agents) never collide.
// The config is evaluated again in each worker; the environment carries the
// first evaluation's choices into them.
function freePort(): number {
  const script = `const s = require("node:net").createServer();
s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });`;
  return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
}

function runPort(name: string): number {
  process.env[name] ??= String(freePort());
  return Number(process.env[name]);
}

const port = runPort("NEOSEQ_E2E_PREVIEW_PORT");
const contractPort = runPort("NEOSEQ_E2E_CONTRACT_PORT");
const syncPort = runPort("NEOSEQ_E2E_SYNC_PORT");
const origin = `http://127.0.0.1:${port}`;
const contractOrigin = `http://127.0.0.1:${contractPort}`;
const syncOrigin = `http://127.0.0.1:${syncPort}`;
const adminPassword = (process.env.NEOSEQ_E2E_ADMIN_PASSWORD ??= "browser admin password");
process.env.NEOSEQ_E2E_SYNC_ORIGIN = syncOrigin;
// A low threshold lets journeys reach checkpoint compaction in a few edits.
process.env.NEOSEQ_E2E_CHECKPOINT_TAIL_UPDATES = "16";

// Build steps live inside the server commands because Playwright starts its
// web servers, in order, before anything else runs. Timeouts below are budgets
// for a cold build, not synchronization.
const gracefulShutdown = { signal: "SIGTERM", timeout: 10_000 } as const;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: 4,
  retries: 0,
  repeatEach: process.env.CI ? 2 : 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: origin,
    locale: "en-US",
    timezoneId: "Asia/Seoul",
    colorScheme: "light",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testDir: "./tests/e2e",
      testIgnore: /(?:collaboration|remote)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testDir: "./tests/e2e",
      testMatch: "usability.spec.ts",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "dark",
      testDir: "./tests/e2e",
      testMatch: "usability.spec.ts",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
    {
      name: "reduced-motion",
      testDir: "./tests/e2e",
      testMatch: "usability.spec.ts",
      use: { ...devices["Desktop Chrome"], contextOptions: { reducedMotion: "reduce" } },
    },
    {
      name: "sync",
      testDir: "./tests/e2e",
      testMatch: /(?:collaboration|remote)\.spec\.ts/,
      timeout: 90_000,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "contracts",
      testDir: "./tests/contracts",
      use: { ...devices["Desktop Chrome"], baseURL: contractOrigin },
    },
  ],
  webServer: [
    {
      name: "product",
      command: `../../scripts/build-wasm-dev.sh && pnpm vite build && pnpm vite preview --host 127.0.0.1 --port ${port} --strictPort`,
      url: origin,
      reuseExistingServer: false,
      timeout: 600_000,
      gracefulShutdown,
    },
    {
      name: "contracts",
      command: `pnpm vite build --mode test --outDir dist-contracts && pnpm vite preview --outDir dist-contracts --host 127.0.0.1 --port ${contractPort} --strictPort`,
      url: contractOrigin,
      reuseExistingServer: false,
      timeout: 300_000,
      gracefulShutdown,
    },
    {
      name: "sync",
      command: "../../scripts/e2e-sync-server.sh",
      url: `${syncOrigin}/readyz`,
      env: {
        NEOSEQ_BIND: `127.0.0.1:${syncPort}`,
        NEOSEQ_BOOTSTRAP_ADMIN_USERNAME: "e2e-admin",
        NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
        NEOSEQ_CHECKPOINT_TAIL_UPDATES: process.env.NEOSEQ_E2E_CHECKPOINT_TAIL_UPDATES,
      },
      reuseExistingServer: false,
      timeout: 900_000,
      gracefulShutdown,
    },
  ],
});
