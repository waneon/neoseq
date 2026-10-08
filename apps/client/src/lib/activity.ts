/**
 * Application-owned work that has started but not settled.
 *
 * The client knows when a gesture left something unfinished: unsaved input in an
 * editor buffer, a debounced save or query run that has not fired, graph work
 * queued or running in the core. This module is the one place that counts it,
 * so "has everything the reader did settled?" has one answer instead of every
 * caller (or test) inferring it from a particular save indicator.
 *
 * The answer is published on the document element as `data-busy` while any work
 * is outstanding. Work must be registered synchronously by the code path that
 * starts it, so a gesture is busy before its event handler returns.
 */

let outstanding = 0;
let waiters: (() => void)[] = [];

function publish(): void {
  if (typeof document !== "undefined") {
    document.documentElement.toggleAttribute("data-busy", outstanding > 0);
  }
  if (outstanding > 0 || waiters.length === 0) return;
  // A finished piece of work often hands over to the next one synchronously
  // (a timer firing a save, an effect replacing its timer). Resolve only if the
  // count is still zero once the current task's synchronous work is done.
  queueMicrotask(() => {
    if (outstanding > 0) return;
    const settled = waiters;
    waiters = [];
    for (const resolve of settled) resolve();
  });
}

function begin(): () => void {
  outstanding += 1;
  publish();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    outstanding -= 1;
    publish();
  };
}

/** Counts `work` as outstanding until it settles, and returns it unchanged. */
export function trackActivity<T>(work: Promise<T>): Promise<T> {
  const end = begin();
  work.then(end, end);
  return work;
}

/** A condition that is outstanding while it holds, such as unsaved input. */
export class ActivityHold {
  private end: (() => void) | null = null;

  set(outstandingWork: boolean): void {
    if (outstandingWork && !this.end) this.end = begin();
    else if (!outstandingWork && this.end) {
      this.end();
      this.end = null;
    }
  }
}

export interface ScheduledActivity {
  cancel(): void;
}

/**
 * A debounce timer whose waiting period is outstanding work. Whatever `run`
 * returns is tracked before the timer's own hold is released, so the hand-over
 * from "scheduled" to "running" never reads as settled.
 */
export function scheduleActivity(run: () => unknown, delay: number): ScheduledActivity {
  const end = begin();
  const timer = setTimeout(() => {
    try {
      const result = run();
      if (result instanceof Promise) trackActivity(result);
    } finally {
      end();
    }
  }, delay);
  return {
    cancel: () => {
      clearTimeout(timer);
      end();
    },
  };
}

export function isIdle(): boolean {
  return outstanding === 0;
}

/** Resolves once no application work is outstanding. */
export function whenIdle(): Promise<void> {
  if (outstanding === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}
