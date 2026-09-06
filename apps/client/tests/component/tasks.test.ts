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
  it("includes the calendar date at each configured number of days ahead", () => {
    expect(dueTierOf("2026-08-25", undefined, "2026-08-25", "12:00", tiers)).toBe("today");
    expect(dueTierOf("2026-08-26", undefined, "2026-08-25", "12:00", tiers)).toBe("soon");
    expect(dueTierOf("2026-08-27", undefined, "2026-08-25", "12:00", tiers)).toBe("soon");
    expect(dueTierOf("2026-08-28", undefined, "2026-08-25", "12:00", tiers)).toBe("soon");
    expect(dueTierOf("2026-08-29", undefined, "2026-08-25", "12:00", tiers)).toBe("upcoming");
    expect(dueTierOf("2026-08-31", undefined, "2026-08-25", "12:00", tiers)).toBe("upcoming");
    expect(dueTierOf("2026-09-01", undefined, "2026-08-25", "12:00", tiers)).toBe("upcoming");
    expect(dueTierOf("2026-09-02", undefined, "2026-08-25", "12:00", tiers)).toBe("later");
  });

  it("includes tomorrow within one day and the day after within two days", () => {
    const narrow = { ...tiers, soonDays: 1, upcomingDays: 2 };
    expect(dueTierOf("2026-12-31", undefined, "2026-12-31", "12:00", narrow)).toBe("today");
    expect(dueTierOf("2027-01-01", undefined, "2026-12-31", "12:00", narrow)).toBe("soon");
    expect(dueTierOf("2027-01-02", undefined, "2026-12-31", "12:00", narrow)).toBe("upcoming");
    expect(dueTierOf("2027-01-03", undefined, "2026-12-31", "12:00", narrow)).toBe("later");
  });

  it("leaves zero-day future tiers empty", () => {
    const zero = { ...tiers, soonDays: 0, upcomingDays: 0 };
    expect(dueTierOf("2026-08-25", undefined, "2026-08-25", "12:00", zero)).toBe("today");
    expect(dueTierOf("2026-08-26", undefined, "2026-08-25", "12:00", zero)).toBe("later");
  });

  it("keeps a time that already passed today overdue", () => {
    expect(dueTierOf("2026-08-25", "11:59", "2026-08-25", "12:00", tiers)).toBe("overdue");
    expect(dueTierOf("2026-08-25", "12:01", "2026-08-25", "12:00", tiers)).toBe("today");
  });
});
