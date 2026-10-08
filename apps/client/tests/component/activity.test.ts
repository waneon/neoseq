import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivityHold,
  isIdle,
  scheduleActivity,
  trackActivity,
  whenIdle,
} from "../../src/lib/activity";

function busyAttribute(): boolean {
  return document.documentElement.hasAttribute("data-busy");
}

describe("application activity", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is busy while tracked work runs and publishes that on the document", async () => {
    let finish!: () => void;
    const work = trackActivity(new Promise<void>((resolve) => (finish = resolve)));
    expect(isIdle()).toBe(false);
    expect(busyAttribute()).toBe(true);
    finish();
    await work;
    await whenIdle();
    expect(isIdle()).toBe(true);
    expect(busyAttribute()).toBe(false);
  });

  it("counts a rejected piece of work as settled", async () => {
    const work = trackActivity(Promise.reject(new Error("rejected")));
    await expect(work).rejects.toThrow("rejected");
    await whenIdle();
    expect(isIdle()).toBe(true);
  });

  it("holds a condition until it is cleared, idempotently", () => {
    const hold = new ActivityHold();
    hold.set(true);
    hold.set(true);
    expect(isIdle()).toBe(false);
    hold.set(false);
    hold.set(false);
    expect(isIdle()).toBe(true);
  });

  it("treats a debounce as busy and hands over to the work it starts without a gap", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const observed: boolean[] = [];
    scheduleActivity(() => {
      observed.push(isIdle());
      return new Promise<void>((resolve) => (finish = resolve));
    }, 300);
    expect(isIdle()).toBe(false);
    let settled = false;
    void whenIdle().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(300);
    expect(observed).toEqual([false]);
    expect(isIdle()).toBe(false);
    expect(settled).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("releases a cancelled debounce", () => {
    const scheduled = scheduleActivity(() => undefined, 300);
    expect(isIdle()).toBe(false);
    scheduled.cancel();
    scheduled.cancel();
    expect(isIdle()).toBe(true);
  });

  it("does not report settled for a handover inside one synchronous task", async () => {
    const hold = new ActivityHold();
    hold.set(true);
    let settled = false;
    const idle = whenIdle().then(() => (settled = true));
    // An effect cleanup releases a timer and the next setup schedules another.
    hold.set(false);
    const next = scheduleActivity(() => undefined, 1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    next.cancel();
    await idle;
    expect(settled).toBe(true);
  });
});
