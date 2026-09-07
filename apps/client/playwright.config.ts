import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.NEOSEQ_PREVIEW_PORT ?? 14173);
const contractPort = Number(process.env.NEOSEQ_CONTRACT_PORT ?? 14174);
const origin = `http://127.0.0.1:${port}`;
const contractOrigin = `http://127.0.0.1:${contractPort}`;

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
  // devenv owns ready processes. Direct runs build fresh artifacts and refuse
  // to borrow an unrelated development server.
  webServer:
    process.env.NEOSEQ_E2E_MANAGED_PREVIEW === "1"
      ? undefined
      : [
          {
            command: `pnpm vite build && pnpm vite preview --host 127.0.0.1 --port ${port} --strictPort`,
            url: origin,
            reuseExistingServer: false,
            timeout: 120_000,
          },
          {
            command: `pnpm vite build --mode test --outDir dist-contracts && pnpm vite preview --outDir dist-contracts --host 127.0.0.1 --port ${contractPort} --strictPort`,
            url: contractOrigin,
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ],
});
