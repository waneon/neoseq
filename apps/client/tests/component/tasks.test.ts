import { describe, expect, it } from "vitest";
import { dueTierOf } from "../../src/entities/tasks";
import type { DueTierSettings } from "../../src/entities/settings";

const tiers: DueTierSettings = {
  soonDays: 1,
  upcomingDays: 7,
  overdueTone: "danger",
  soonTone: "attention",
  upcomingTone: "info",
  laterTone: "neutral",
};

describe("due calendar-day tiers", () => {
  it("counts today as the first day of each configured span", () => {
    expect(dueTierOf("2026-08-25", undefined, "2026-08-25", "12:00", tiers)).toBe(
      "soon",
    );
    expect(dueTierOf("2026-08-26", undefined, "2026-08-25", "12:00", tiers)).toBe(
      "upcoming",
    );
    expect(dueTierOf("2026-08-31", undefined, "2026-08-25", "12:00", tiers)).toBe(
      "upcoming",
    );
    expect(dueTierOf("2026-09-01", undefined, "2026-08-25", "12:00", tiers)).toBe("later");
  });
});
