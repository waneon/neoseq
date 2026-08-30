const RUNTIME_CONFIG_PATH = "/__neoseq/config.json";

interface RuntimeConfig {
  url?: string;
}

let runtimeConfig: RuntimeConfig = {};

export async function loadRuntimeConfig(): Promise<void> {
  runtimeConfig = {};
  try {
    const response = await fetch(RUNTIME_CONFIG_PATH, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const candidate: unknown = await response.json();
    if (!candidate || typeof candidate !== "object") return;
    const url = canonicalHttpOrigin((candidate as { url?: unknown }).url);
    runtimeConfig = url ? { url } : {};
  } catch {
    // Runtime configuration is optional. Static and offline deployments retain
    // the browser origin as their natural server default.
  }
}

export function neoseqUrl(): string {
  return runtimeConfig.url ?? window.location.origin;
}

function canonicalHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
