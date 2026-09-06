import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer } from "vite";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

for (const app of ["client", "dashboard"]) {
  test(`${app} development server delivers the current browser icon`, async ({ page }) => {
    const root = join(repositoryRoot, "apps", app);
    const server = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "development",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });

    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") {
        throw new Error("The development server did not bind a TCP port");
      }

      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(page.locator("#root")).not.toBeEmpty();

      const icon = page.locator('link[rel="icon"]');
      await expect(icon).toHaveAttribute("type", "image/svg+xml");
      await expect(icon).toHaveAttribute("href", /.+/);
      const href = await icon.getAttribute("href");
      const response = await page.request.get(new URL(href ?? "", page.url()).href);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("image/svg+xml");
      expect(await response.text()).toBe(
        await readFile(join(repositoryRoot, "assets/brand/symbol.svg"), "utf8"),
      );
    } finally {
      await server.close();
    }
  });
}
