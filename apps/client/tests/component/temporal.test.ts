import { describe, expect, it } from "vitest";
import { createLocaleRuntime, LOCALE_DEFINITIONS, type TemporalRecognition } from "../../src/i18n";

function matched<T>(recognition: TemporalRecognition<T>): T {
  expect(recognition.kind).toBe("match");
  if (recognition.kind !== "match") throw new Error("expected one temporal match");
  return recognition.value;
}

function expectNoMatch(recognition: TemporalRecognition<unknown>): void {
  expect(recognition.kind).toBe("none");
}

describe("localized temporal input", () => {
  const today = "2026-08-04"; // a Tuesday
  const context = { today };
  const en = createLocaleRuntime("en").temporal;
  const ko = createLocaleRuntime("ko").temporal;

  it("resolves English relative, weekday, and calendar forms", () => {
    expect(matched(en.parseDate("today", context))).toBe("2026-08-04");
    expect(matched(en.parseDate("tomorrow", context))).toBe("2026-08-05");
    expect(matched(en.parseDate("yesterday", context))).toBe("2026-08-03");
    expect(matched(en.parseDate("3 days ago", context))).toBe("2026-08-01");
    expect(matched(en.parseDate("in 2 weeks", context))).toBe("2026-08-18");
    expect(matched(en.parseDate("next friday", context))).toBe("2026-08-07");
    expect(matched(en.parseDate("tue", context))).toBe("2026-08-11");
    expect(matched(en.parseDate("last friday", context))).toBe("2026-07-31");
    expect(matched(en.parseDate("aug 5", context))).toBe("2026-08-05");
    expect(matched(en.parseDate("5 august", context))).toBe("2026-08-05");
    expect(matched(en.parseDate("august 5, 2027", context))).toBe("2027-08-05");
  });

  it("resolves Korean relative, weekday, and calendar forms", () => {
    expect(matched(ko.parseDate("오늘", context))).toBe("2026-08-04");
    expect(matched(ko.parseDate("3일 전", context))).toBe("2026-08-01");
    expect(matched(ko.parseDate("2주 후", context))).toBe("2026-08-18");
    expect(matched(ko.parseDate("다음 금요일", context))).toBe("2026-08-07");
    expect(matched(ko.parseDate("지난 금요일", context))).toBe("2026-07-31");
    expect(matched(ko.parseDate("8월 5일", context))).toBe("2026-08-05");
    expect(matched(ko.parseDate("2027년 8월 5일", context))).toBe("2027-08-05");
  });

  it("keeps calendar months distinct from fixed day counts", () => {
    const monthEnd = { today: "2026-01-31" };
    expect(matched(en.parseDate("in 1 month", monthEnd))).toBe("2026-02-28");
    expect(matched(ko.parseDate("1개월 후", monthEnd))).toBe("2026-02-28");
  });

  it("resolves a day and optional 24-hour clock as one moment", () => {
    expect(matched(en.parseMoment("tomorrow 14:30", context))).toEqual({
      date: "2026-08-05",
      time: "14:30",
    });
    expect(matched(en.parseMoment("next friday 3:05 pm", context))).toEqual({
      date: "2026-08-07",
      time: "15:05",
    });
    expect(matched(en.parseMoment("18:00", context))).toEqual({ date: today, time: "18:00" });
    expect(matched(ko.parseMoment("내일 오후 3시 5분", context))).toEqual({
      date: "2026-08-05",
      time: "15:05",
    });
    expect(matched(ko.parseMoment("8월 5일 9시", context))).toEqual({
      date: "2026-08-05",
      time: "09:00",
    });
  });

  it("recognizes recurrence in either suffix order without exposing storage codes", () => {
    expect(matched(en.parseMoment("2026-08-24 09:30 every 3 days", context))).toEqual({
      date: "2026-08-24",
      time: "09:30",
      recurrence: { count: 3, unit: "day" },
    });
    expect(matched(en.parseMoment("tomorrow 3:05 pm every 2 weeks", context))).toEqual({
      date: "2026-08-05",
      time: "15:05",
      recurrence: { count: 2, unit: "week" },
    });
    expect(matched(en.parseMoment("tomorrow monthly 09:00", context))).toEqual({
      date: "2026-08-05",
      time: "09:00",
      recurrence: { count: 1, unit: "month" },
    });
    expect(matched(ko.parseMoment("내일 오후 3시 2주마다", context))).toEqual({
      date: "2026-08-05",
      time: "15:00",
      recurrence: { count: 2, unit: "week" },
    });
    expect(matched(ko.parseMoment("내일 매 2주 오후 3시", context))).toEqual({
      date: "2026-08-05",
      time: "15:00",
      recurrence: { count: 2, unit: "week" },
    });
  });

  it("keeps invariant ISO input available in every language", () => {
    expect(matched(en.parseDate("2026-08-05", context))).toBe("2026-08-05");
    expect(matched(ko.parseMoment("2026-08-05 21:30", context))).toEqual({
      date: "2026-08-05",
      time: "21:30",
    });
  });

  it("rejects prose and impossible values rather than guessing", () => {
    expectNoMatch(en.parseDate("reading list", context));
    expectNoMatch(en.parseDate("2026-02-30", context));
    expectNoMatch(en.parseDate("feb 30", context));
    expectNoMatch(en.parseDate("", context));
    expectNoMatch(ko.parseDate("2월 30일", context));
    expectNoMatch(ko.parseMoment("내일 오후 13시", context));
    expectNoMatch(ko.parseMoment("내일 2주", context));
    expectNoMatch(en.parseMoment("tomorrow every 0 weeks", context));
  });

  it("holds every declared language pack to executable examples", () => {
    for (const definition of LOCALE_DEFINITIONS) {
      const parser = createLocaleRuntime(definition.tag).temporal;
      for (const example of parser.examples.dates) {
        expect(parser.parseDate(example, context).kind, `${definition.tag}: ${example}`).toBe(
          "match",
        );
      }
      for (const example of parser.examples.moments) {
        expect(parser.parseMoment(example, context).kind, `${definition.tag}: ${example}`).toBe(
          "match",
        );
      }
    }
  });
});
