import { defineConfig, devices } from "@playwright/test";

// The gate serves its own build, so it needs a port nothing else is on. A dev
// server on the default one is the ordinary case while somebody is working, and
// a suite that cannot run beside it is a suite that gets skipped.
const previewPort = Number(process.env.NEOSEQ_PREVIEW_PORT ?? 4173);

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  // Keep the gate reproducible everywhere; focused runs can opt into more.
  workers: 2,
  retries: 1,
  reporter: "line",
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${previewPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /(?:a11y|mobile)\.spec\.ts/,
    },
    {
      // Dark mode ships from the same token declaration, so it needs the same
      // gate: contrast is a property of the pair, not of the light values.
      name: "chromium-dark",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
      testMatch: /a11y\.spec\.ts/,
    },
  ],
  webServer: {
    command: `pnpm vite preview --host 127.0.0.1 --port ${previewPort}`,
    port: previewPort,
    reuseExistingServer: false,
  },
});
