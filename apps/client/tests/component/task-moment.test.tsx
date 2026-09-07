import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DUE_TIERS, resetAppSettingsCache } from "../../src/entities/settings";
import { setConfiguredTimezone } from "../../src/entities/journal";
import { TASK_DEADLINE_KEY, TASK_SCHEDULED_KEY, type TaskDateKey } from "../../src/entities/tasks";
import { createLocaleRuntime, type SupportedLocale } from "../../src/i18n";
import { presentTaskMoment, taskMomentDue } from "../../src/features/tasks/moment-presentation";
import { useLocalClock, useToday } from "../../src/features/time/use-local-clock";

function presentation(
  locale: SupportedLocale,
  key: TaskDateKey,
  date: string,
  time?: string,
  settled = false,
  today = "2026-09-06",
  now = "12:00",
) {
  const runtime = createLocaleRuntime(locale);
  return presentTaskMoment({
    key,
    date,
    time,
    repeating: false,
    due: taskMomentDue({ date, time, settled, today, now, tiers: DEFAULT_DUE_TIERS }),
    message: runtime.message,
    formatDate: runtime.formatLocalDate,
    formatTime: runtime.formatTimeOfDay,
  });
}

describe("relative task moments", () => {
  it.each([
    ["2026-09-12", undefined, "6일 후", "6일 남음", "In 6 days", "6 days left"],
    ["2026-09-04", undefined, "2일 전", "2일 지남", "2 days ago", "2 days overdue"],
    ["2026-09-05", undefined, "1일 전", "1일 지남", "1 day ago", "1 day overdue"],
    ["2026-09-07", "00:01", "내일", "내일", "Tomorrow", "Tomorrow"],
    ["2026-09-06", undefined, "오늘", "오늘", "Today", "Today"],
    [
      "2026-09-06",
      "14:30",
      "2시간 30분 후",
      "2시간 30분 남음",
      "In 2 hours 30 minutes",
      "2 hours 30 minutes left",
    ],
    ["2026-09-06", "13:00", "1시간 후", "1시간 남음", "In 1 hour", "1 hour left"],
    ["2026-09-06", "12:01", "1분 후", "1분 남음", "In 1 minute", "1 minute left"],
    ["2026-09-06", "11:59", "1분 전", "1분 지남", "1 minute ago", "1 minute overdue"],
    [
      "2026-09-06",
      "10:30",
      "1시간 30분 전",
      "1시간 30분 지남",
      "1 hour 30 minutes ago",
      "1 hour 30 minutes overdue",
    ],
    ["2026-09-06", "12:00", "지금", "지금", "Now", "Now"],
    ["2026-09-06", "25:00", "오늘", "오늘", "Today", "Today"],
  ])(
    "describes %s %s in both locales and task kinds",
    (date, time, koScheduled, koDeadline, enScheduled, enDeadline) => {
      expect(presentation("ko", TASK_SCHEDULED_KEY, date!, time).relativeLabel).toBe(koScheduled);
      expect(presentation("ko", TASK_DEADLINE_KEY, date!, time).relativeLabel).toBe(koDeadline);
      expect(presentation("en", TASK_SCHEDULED_KEY, date!, time).relativeLabel).toBe(enScheduled);
      expect(presentation("en", TASK_DEADLINE_KEY, date!, time).relativeLabel).toBe(enDeadline);
    },
  );

  it("counts calendar days across leap days and year boundaries", () => {
    expect(
      presentation("ko", TASK_DEADLINE_KEY, "2024-03-01", undefined, false, "2024-02-28")
        .relativeLabel,
    ).toBe("2일 남음");
    expect(
      presentation("en", TASK_DEADLINE_KEY, "2027-01-02", undefined, false, "2026-12-31")
        .relativeLabel,
    ).toBe("2 days left");
  });

  it("keeps the absolute value and removes all relative urgency when settled", () => {
    for (const key of [TASK_SCHEDULED_KEY, TASK_DEADLINE_KEY]) {
      const active = presentation("ko", key, "2026-09-06", "10:30");
      const settled = presentation("ko", key, "2026-09-06", "10:30", true);
      expect(settled.dateLabel).toBe(active.dateLabel);
      expect(settled.timeLabel).toBe("10:30");
      expect(settled.relativeLabel).toBeNull();
      expect(settled.due).toBeNull();
      expect(active.title).toContain(active.relativeLabel);
      expect(settled.title).not.toContain(active.relativeLabel);
    }
  });
});

describe("shared local clock", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    resetAppSettingsCache();
  });

  it("shares a minute timer, rolls over midnight and responds to timezone changes and resume", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-06T14:59:30Z"));
    setConfiguredTimezone("Asia/Seoul");
    vi.advanceTimersByTime(0);
    const first = renderHook(() => useLocalClock(true));
    const second = renderHook(() => useLocalClock(true));
    expect(vi.getTimerCount()).toBe(1);
    expect(first.result.current).toEqual({ today: "2026-09-06", now: "23:59" });
    act(() => vi.advanceTimersByTime(30_000));
    expect(first.result.current).toEqual({ today: "2026-09-07", now: "00:00" });
    expect(second.result.current).toEqual(first.result.current);
    act(() => {
      setConfiguredTimezone("UTC");
      vi.advanceTimersByTime(0);
    });
    expect(first.result.current).toEqual({ today: "2026-09-06", now: "15:00" });
    vi.setSystemTime(new Date("2026-09-08T12:34:00Z"));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(first.result.current).toEqual({ today: "2026-09-08", now: "12:34" });
    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a clock for an inactive surface", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { rerender } = renderHook(({ active }) => useLocalClock(active), {
      initialProps: { active: false },
    });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ active: true });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares its timer with journals and renders date consumers only when the day changes", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-06T14:58:30Z"));
    setConfiguredTimezone("Asia/Seoul");
    vi.advanceTimersByTime(0);
    const clock = renderHook(() => useLocalClock(true));
    const renderToday = vi.fn(useToday);
    const today = renderHook(renderToday);
    const initialRenders = renderToday.mock.calls.length;
    expect(vi.getTimerCount()).toBe(1);
    expect(today.result.current).toBe("2026-09-06");
    act(() => vi.advanceTimersByTime(30_000));
    expect(renderToday).toHaveBeenCalledTimes(initialRenders);
    act(() => vi.advanceTimersByTime(60_000));
    expect(today.result.current).toBe("2026-09-07");
    act(() => {
      setConfiguredTimezone("UTC");
      vi.advanceTimersByTime(0);
    });
    expect(today.result.current).toBe("2026-09-06");
    clock.unmount();
    today.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
