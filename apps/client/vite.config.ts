import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const clientPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

// Generates the application-shell Service Worker with the built asset list
// precached, so an offline reload can boot the full shell (including the
// Wasm core and its Worker chunk). Data is never cached — shell only.
function shellServiceWorker(): Plugin {
  return {
    name: "neoseq-shell-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map"))
        .map((name) => `/${name}`);
      const urls = ["/", ...assets];
      const template = readFileSync(
        fileURLToPath(new URL("./sw-template.js", import.meta.url)),
        "utf8",
      );
      const version = createHash("sha256").update(JSON.stringify(urls)).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replace("__CACHE_NAME__", `neoseq-shell-${version}`)
          .replace("__PRECACHE__", JSON.stringify(urls)),
      });
    },
  };
}

function testRoutes(mode: string): Plugin {
  const virtualId = "virtual:neoseq-test-routes";
  const resolvedId = `\0${virtualId}`;
  const implementation = fileURLToPath(new URL("./src/app/test-routes.tsx", import.meta.url));
  return {
    name: "neoseq-test-routes",
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      if (id === implementation) return implementation;
      return undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      return mode === "test"
        ? `export { testRoutes } from ${JSON.stringify(implementation)};`
        : "export const testRoutes = [];";
    },
  };
}

function workerFactory(mode: string): Plugin {
  const virtualId = "virtual:neoseq-worker-factory";
  const resolvedId = `\0${virtualId}`;
  const productionWorker = fileURLToPath(new URL("./src/core-worker.ts", import.meta.url));
  const testWorker = fileURLToPath(new URL("./src/test-core-worker.ts", import.meta.url));
  return {
    name: "neoseq-worker-factory",
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      if (id === productionWorker || id === testWorker) return id;
      return undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      return mode === "test"
        ? `import { TestCoreWorker } from ${JSON.stringify(testWorker)};
           export const createCoreWorker = () => new TestCoreWorker();
           export const injectStorageFault = (worker, graphHandle, fault) =>
             worker.injectFault(graphHandle, fault);
           export const clearTestHook = () => { delete window.__neoseqTest; };`
        : `import { CoreWorker } from ${JSON.stringify(productionWorker)};
           export const createCoreWorker = () => new CoreWorker();
           export const injectStorageFault = undefined;
           export const clearTestHook = () => {};`;
    },
  };
}

export default defineConfig(({ mode }) => ({
  cacheDir: process.env.NEOSEQ_VITE_CACHE_DIR,
  plugins: [testRoutes(mode), workerFactory(mode), react(), tailwindcss(), shellServiceWorker()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  define: {
    __NEOSEQ_APP_VERSION__: JSON.stringify(clientPackage.version),
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
}));
