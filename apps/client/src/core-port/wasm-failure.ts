import { CORE_PORT_ERROR_CODES, type CorePortError } from "../generated/core-port";

export type WasmFailureFallback = "invalid_query" | "invalid_archive" | "internal";

export function isCorePortError(error: unknown): error is CorePortError {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    (CORE_PORT_ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

/** Decode the stable JSON error envelope thrown through wasm-bindgen. */
export function normalizeWasmFailure(
  error: unknown,
  fallbackCode: WasmFailureFallback,
): CorePortError {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const decoded: unknown = JSON.parse(message);
    if (isCorePortError(decoded)) return decoded;
  } catch {
    // A malformed or legacy Wasm exception has no trustworthy classification.
  }
  return { code: fallbackCode, message, retryable: false };
}
