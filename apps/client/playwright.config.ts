import { defineConfig, devices } from "@playwright/test";

// The browser devenv profile supplies an allocated port. The fallback keeps
// direct Playwright runs useful outside that boundary while staying clear of
// Vite's development port.
const previewPort = Number(process.env.NEOSEQ_PREVIEW_PORT ?? 14173);
const preview = `pnpm vite preview --host 127.0.0.1 --port ${previewPort}`;
const managedPreview = process.env.NEOSEQ_E2E_MANAGED_PREVIEW === "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  // Match the public CI runner's four cores and keep scheduling reproducible.
  workers: 4,
  // A retry changes the observed schedule and can hide a race. This gate accepts
  // one result for one run; repeated stress runs belong in verification.
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
      testIgnore: /(?:mobile|motion)\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /(?:a11y|mobile|visual)\.spec\.ts/,
    },
    {
      // Dark mode ships from the same token declaration, so it needs the same
      // gate: contrast is a property of the pair, not of the light values.
      name: "chromium-dark",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
      testMatch: /(?:a11y|visual)\.spec\.ts/,
    },
    {
      name: "chromium-reduced-motion",
      use: {
        ...devices["Desktop Chrome"],
        contextOptions: { reducedMotion: "reduce" },
      },
      testMatch: /motion\.spec\.ts/,
    },
  ],
  // The devenv browser gate owns a ready preview process. A direct Playwright
  // invocation has no such task graph, so it builds and owns a fresh server.
  webServer: managedPreview
    ? undefined
    : {
        command: `pnpm vite build --mode test && ${preview}`,
        port: previewPort,
        reuseExistingServer: false,
      },
});
