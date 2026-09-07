import { test as base, expect } from "@playwright/test";
import { NeoseqApp } from "./app";

export const FIXED_TIME = "2026-09-07T03:00:00Z";

export const test = base.extend<{ app: NeoseqApp; browserChecks: void }>({
  page: async ({ page }, use) => {
    // Pin calendar time while animations, debounce, and network timers run normally.
    await page.clock.setFixedTime(new Date(FIXED_TIME));
    await use(page);
  },
  app: async ({ page }, use) => {
    await use(new NeoseqApp(page));
  },
  browserChecks: [
    async ({ context, baseURL }, use, testInfo) => {
      const errors: string[] = [];
      const consoleMessages: string[] = [];
      const network: string[] = [];
      context.on("weberror", (error) => errors.push(error.error().message));
      context.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          consoleMessages.push(message.type() + ": " + message.text());
        }
      });
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (
          testInfo.project.name !== "sync" &&
          (url.origin !== new URL(baseURL!).origin || url.pathname.startsWith("/v1/"))
        ) {
          network.push(request.url());
        }
      });
      await use();
      if (consoleMessages.length)
        await testInfo.attach("browser-console", {
          body: consoleMessages.join("\n"),
          contentType: "text/plain",
        });
      expect(errors, "uncaught browser errors").toEqual([]);
      expect(network, "local graphs must not contact remote services").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
