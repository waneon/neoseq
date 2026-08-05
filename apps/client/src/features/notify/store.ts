// The toast queue. Framework-agnostic on purpose: React subscribes through
// `useSyncExternalStore`, and nothing here knows how a toast is drawn.
//
// A toast reports something the user cannot see from where they are standing.
// Anything with a home on screen — a field error, a query diagnostic, the save
// slot, a tombstone — keeps that home. See DESIGN.md § Toasts.

export type ToastTone = "info" | "success" | "danger";

export interface ToastAction {
  label: string;
  run(): void;
}

export interface ToastInput {
  /** One line, in the user's terms, naming what happened. */
  title: string;
  /** The reason, when there is one worth reading. */
  detail?: string;
  tone?: ToastTone;
  /**
   * A second route to the same verb — never the only one. Clicking it dismisses
   * the toast; whatever it starts reports its own outcome.
   */
  action?: ToastAction;
  /** Repeats of this key collapse onto one toast and raise its counter. */
  key?: string;
  /** Milliseconds, or `null` to stay until dismissed. Defaults by tone. */
  duration?: number | null;
}

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ToastAction;
  readonly key?: string;
  /** How many times this key has fired. Rendered only above 1. */
  readonly count: number;
  readonly duration: number | null;
  /** Bumped by a repeat so the visible dismissal timer restarts. */
  readonly nonce: number;
}

/**
 * An error waits for the user; a notice states a condition and leaves. Nothing
 * that a user must act on is ever taken off the screen by a timer.
 */
const DEFAULT_DURATION: Record<ToastTone, number | null> = {
  info: 6000,
  success: 4000,
  danger: null,
};

/** Four is already more than anyone reads at once; beyond it, older goes. */
const LIMIT = 4;

export class ToastStore {
  private toasts: readonly Toast[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly Toast[] => this.toasts;

  show = (input: ToastInput): string => {
    const tone = input.tone ?? "info";
    const duration = input.duration === undefined ? DEFAULT_DURATION[tone] : input.duration;
    const existing = input.key
      ? this.toasts.find((toast) => toast.key === input.key)
      : undefined;

    if (existing) {
      // A repeat raises the counter where the toast already sits. Re-queueing it
      // at the bottom would reshuffle a stack the user is part-way through
      // reading, for no new information.
      this.commit(
        this.toasts.map((toast) =>
          toast.id === existing.id
            ? {
                ...toast,
                tone,
                duration,
                title: input.title,
                detail: input.detail,
                action: input.action,
                count: toast.count + 1,
                nonce: toast.nonce + 1,
              }
            : toast,
        ),
      );
      return existing.id;
    }

    this.sequence += 1;
    const toast: Toast = {
      id: `toast-${this.sequence}`,
      tone,
      title: input.title,
      detail: input.detail,
      action: input.action,
      key: input.key,
      count: 1,
      duration,
      nonce: 0,
    };
    this.commit(withinLimit([...this.toasts, toast]));
    return toast.id;
  };

  dismiss = (id: string): void => {
    if (!this.toasts.some((toast) => toast.id === id)) return;
    this.commit(this.toasts.filter((toast) => toast.id !== id));
  };

  clear = (): void => {
    if (this.toasts.length > 0) this.commit([]);
  };

  private commit(next: readonly Toast[]): void {
    this.toasts = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Trims the stack oldest-first, but an unacknowledged error is the last thing to
 * go: a burst of notices must never push a failure off the screen unread.
 */
function withinLimit(toasts: Toast[]): Toast[] {
  if (toasts.length <= LIMIT) return toasts;
  const victim = toasts.find((toast) => toast.tone !== "danger") ?? toasts[0];
  return toasts.filter((toast) => toast !== victim);
}
