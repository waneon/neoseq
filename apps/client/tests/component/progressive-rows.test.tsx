import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useProgressiveRows } from "../../src/features/query/progressive-rows";

const keyOf = (value: number) => String(value);

describe("progressive query rows", () => {
  it("grows in bounded windows and resets immediately for a new answer", () => {
    const first = Array.from({ length: 250 }, (_, index) => index);
    const { result, rerender } = renderHook(
      ({ rows }) => useProgressiveRows(rows, keyOf),
      { initialProps: { rows: first } },
    );
    expect(result.current.rows).toHaveLength(100);
    expect(result.current.remaining).toBe(150);

    act(() => result.current.showMore());
    expect(result.current.rows).toHaveLength(200);

    const second = Array.from({ length: 180 }, (_, index) => index + 1_000);
    rerender({ rows: second });
    expect(result.current.rows).toHaveLength(100);
    expect(result.current.remaining).toBe(80);
  });

  it("keeps an edited row mounted outside the current window", () => {
    const rows = Array.from({ length: 250 }, (_, index) => index);
    const { result } = renderHook(() => useProgressiveRows(rows, keyOf, "220"));
    expect(result.current.rows).toHaveLength(101);
    expect(result.current.rows.at(-1)).toBe(220);
  });
});
