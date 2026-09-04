import { describe, expect, it } from "vitest";
import { normalizeWasmFailure } from "../../src/core-port/wasm-failure";

describe("graph worker Wasm failures", () => {
  it("preserves a valid typed envelope from raw and Error throws", () => {
    const query = {
      code: "query_budget_exceeded",
      message: "execution stopped",
      retryable: false,
    } as const;
    const archive = {
      code: "archive_checksum_mismatch",
      message: "archive integrity failed",
      retryable: true,
    } as const;

    expect(normalizeWasmFailure(JSON.stringify(query), "invalid_query")).toEqual(query);
    expect(normalizeWasmFailure(new Error(JSON.stringify(archive)), "invalid_archive")).toEqual(
      archive,
    );
  });

  it("uses the operation fallback for malformed or unrecognized envelopes", () => {
    expect(normalizeWasmFailure(new Error("budget exceeded"), "invalid_query")).toEqual({
      code: "invalid_query",
      message: "budget exceeded",
      retryable: false,
    });
    expect(
      normalizeWasmFailure(
        JSON.stringify({ code: "future_archive_error", message: "checksum", retryable: false }),
        "invalid_archive",
      ),
    ).toEqual({
      code: "invalid_archive",
      message: '{"code":"future_archive_error","message":"checksum","retryable":false}',
      retryable: false,
    });
    expect(
      normalizeWasmFailure(
        JSON.stringify({ code: "storage_busy", message: "busy", retryable: "yes" }),
        "internal",
      ),
    ).toEqual({
      code: "internal",
      message: '{"code":"storage_busy","message":"busy","retryable":"yes"}',
      retryable: false,
    });
  });
});
