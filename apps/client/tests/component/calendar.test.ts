import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayDifference,
  dayOfWeek,
  isValidLocalDate,
} from "../../src/entities/calendar";
import { resolveDateIntent } from "../../src/entities/temporal";

describe("domain local dates", () => {
  it("preserves the full four-digit year range across input and arithmetic", () => {
    for (const date of ["0001-01-01", "0099-12-31", "0100-01-01", "9999-12-31"]) {
      expect(isValidLocalDate(date)).toBe(true);
      expect(resolveDateIntent({ kind: "absolute", date }, { today: "2026-09-05" })).toBe(date);
    }
    expect(addDays("0001-01-01", 1)).toBe("0001-01-02");
    expect(addDays("0099-12-31", 1)).toBe("0100-01-01");
    expect(addMonths("0099-12-31", 1)).toBe("0100-01-31");
    expect(dayDifference("0100-01-01", "0099-12-31")).toBe(1);
    expect(dayOfWeek("0001-01-01")).toBe(1);
  });

  it("rejects non-domain dates and applies Gregorian leap and month-end rules", () => {
    for (const date of [
      "0000-01-01",
      "10000-01-01",
      "100-01-01",
      "2026-2-01",
      "1900-02-29",
      "2026-04-31",
    ]) {
      expect(isValidLocalDate(date)).toBe(false);
    }
    expect(isValidLocalDate("2000-02-29")).toBe(true);
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
