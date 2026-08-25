import { describe, expect, it } from "vitest";
import { dueTierOf } from "../../src/entities/tasks";
import type { DueTierSettings } from "../../src/entities/settings";

const tiers: DueTierSettings = {
  soonDays: 3,
  upcomingDays: 7,
  overdueTone: "danger",
  todayTone: "attention",
  soonTone: "caution",
  upcomingTone: "info",
  laterTone: "neutral",
};

describe("due calendar-day tiers", () => {
  it("counts today as the first day of each configured span", () => {
    expect(dueTierOf("2026-08-25", undefined, "2026-08-25", "12:00", tiers)).toBe(
      "today",
    );
    expect(dueTierOf("2026-08-26", undefined, "2026-08-25", "12:00", tiers)).toBe("soon");
    expect(dueTierOf("2026-08-27", undefined, "2026-08-25", "12:00", tiers)).toBe("soon");
    expect(dueTierOf("2026-08-28", undefined, "2026-08-25", "12:00", tiers)).toBe(
      "upcoming",
    );
    expect(dueTierOf("2026-08-31", undefined, "2026-08-25", "12:00", tiers)).toBe(
      "upcoming",
    );
    expect(dueTierOf("2026-09-01", undefined, "2026-08-25", "12:00", tiers)).toBe("later");
  });

  it("keeps a time that already passed today overdue", () => {
    expect(dueTierOf("2026-08-25", "11:59", "2026-08-25", "12:00", tiers)).toBe(
      "overdue",
    );
    expect(dueTierOf("2026-08-25", "12:01", "2026-08-25", "12:00", tiers)).toBe(
      "today",
    );
  });
});
