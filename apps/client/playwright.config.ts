import { defineConfig, devices } from "@playwright/test";

const previewPort = Number.parseInt(process.env.NEOSEQ_PLAYWRIGHT_PORT ?? "4173", 10);

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      // The persistence corpus is a contract suite, not a product
      // scenario; one engine run keeps its gate unchanged.
      testIgnore: /persistence\.spec\.ts/,
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
