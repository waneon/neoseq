// The task lens over well-known properties.
//
// A task is not a storage shape: it is any block or page whose bag carries one
// of the `builtin.task-*` keys. The value lists here are derived from the
// property registry, so the UI can never offer a status the domain does not
// suggest — and an arbitrary stored string remains valid and stays listed,
// because `suggested` values are hints, not restrictions.
//
// A moment is stored as a calendar date plus an optional time of day in its own
// key, not as one combined string. The date keys stay `date`-typed, which is
// what keeps them comparable as `xsd:date` in the query index; a time is a
// refinement of that date and reads only beside it.

import { addDays, addMonths, dayDifference } from "./journal";
import { stringChoicesOf } from "./properties";
import type { DueTierSettings, ToneValue } from "./settings";
import type { TemporalRecurrenceIntent } from "./temporal";

export const TASK_STATUS_KEY = "builtin.task-status";
export const TASK_SCHEDULED_KEY = "builtin.task-scheduled";
export const TASK_SCHEDULED_TIME_KEY = "builtin.task-scheduled-time";
export const TASK_DEADLINE_KEY = "builtin.task-deadline";
export const TASK_DEADLINE_TIME_KEY = "builtin.task-deadline-time";
export const TASK_PRIORITY_KEY = "builtin.task-priority";
export const TASK_REPEAT_KEY = "builtin.task-repeat";

const TASK_KEYS = [
  TASK_STATUS_KEY,
  TASK_SCHEDULED_KEY,
  TASK_SCHEDULED_TIME_KEY,
  TASK_DEADLINE_KEY,
  TASK_DEADLINE_TIME_KEY,
  TASK_PRIORITY_KEY,
  TASK_REPEAT_KEY,
] as const;

/** The two moments a task can carry, each with the key its time of day lives in. */
export const TASK_DATE_KEYS = [TASK_SCHEDULED_KEY, TASK_DEADLINE_KEY] as const;

export type TaskDateKey = (typeof TASK_DATE_KEYS)[number];

export function isTaskDateKey(key: string): key is TaskDateKey {
  return (TASK_DATE_KEYS as readonly string[]).includes(key);
}

/** Where the time of day for a task date is stored. */
export function timeKeyFor(key: TaskDateKey): string {
  return key === TASK_SCHEDULED_KEY ? TASK_SCHEDULED_TIME_KEY : TASK_DEADLINE_TIME_KEY;
}

export const TASK_STATUSES: readonly string[] = stringChoicesOf(TASK_STATUS_KEY);
export const TASK_PRIORITIES: readonly string[] = stringChoicesOf(TASK_PRIORITY_KEY);

export function isTaskKey(key: string): boolean {
  return (TASK_KEYS as readonly string[]).includes(key);
}

/** Strongest first, because raising something is why a priority list is opened. */
const PRIORITY_OFFER_ORDER: readonly string[] = ["high", "medium", "low"];

/**
 * The order a choice list offers a property's suggested values in.
 *
 * The registry states its values in the domain's own ascending order, which is
 * the right order to *store* and the wrong order to *read*: `low` arrived at the
 * top of the priority list, one row further from the pointer than the answer
 * almost every reader is reaching for. Status keeps the registry's progression
 * (todo → doing → done → cancelled) because that is the order the work moves in.
 * A stored value outside the suggested set keeps its place at the end.
 */
export function offeredChoices(key: string, choices: readonly string[]): string[] {
  if (key !== TASK_PRIORITY_KEY) return [...choices];
  const rank = (value: string) => {
    const index = PRIORITY_OFFER_ORDER.indexOf(value);
    return index < 0 ? PRIORITY_OFFER_ORDER.length : index;
  };
  return [...choices].sort((left, right) => rank(left) - rank(right));
}

/** Done and cancelled are settled: their text reads as struck through. */
export function isSettledStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}

// ── Time of day ──

/** A stored time of day is `HH:MM` on the 24-hour clock, or it is not one. */
export function isTimeOfDay(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return false;
  return Number(match[1]) < 24 && Number(match[2]) < 60;
}

/** Minutes since midnight, for comparing a stored time against the clock. */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// ── Recurrence ──

export const REPEAT_UNITS = ["d", "w", "m", "y"] as const;

export type RepeatUnit = (typeof REPEAT_UNITS)[number];

export interface RepeatInterval {
  count: number;
  unit: RepeatUnit;
}

export const DEFAULT_REPEAT: RepeatInterval = { count: 1, unit: "d" };

/** The longest interval a single field may name, so one typo cannot run away. */
const MAX_REPEAT_COUNT = 999;

/**
 * A repeat is stored as the shortest thing that round-trips: a count and a unit
 * letter, `1d` / `2w` / `3m` / `1y`. Anything else stays readable as the string
 * it is and simply does not recur, which is the same tolerance every other
 * unknown property value gets.
 */
export function parseRepeat(value: string): RepeatInterval | null {
  const match = /^(\d{1,3})([dwmy])$/u.exec(value.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (count < 1 || count > MAX_REPEAT_COUNT) return null;
  return { count, unit: match[2] as RepeatUnit };
}

export function formatRepeat(interval: RepeatInterval): string {
  return `${interval.count}${interval.unit}`;
}

/** Adapt locale-neutral temporal meaning to the task recurrence storage model. */
export function repeatFromTemporalRecurrence(recurrence: TemporalRecurrenceIntent): RepeatInterval {
  const unit: RepeatUnit =
    recurrence.unit === "day"
      ? "d"
      : recurrence.unit === "week"
        ? "w"
        : recurrence.unit === "month"
          ? "m"
          : "y";
  return { count: recurrence.count, unit };
}

/**
 * The next occurrence of a recurring date. It counts from the date that was set,
 * not from today: a weekly task completed three days late is still due on its
 * own weekday.
 */
export function advanceDate(date: string, interval: RepeatInterval): string {
  switch (interval.unit) {
    case "d":
      return addDays(date, interval.count);
    case "w":
      return addDays(date, interval.count * 7);
    case "m":
      return addMonths(date, interval.count);
    default:
      return addMonths(date, interval.count * 12);
  }
}

// ── How far off a date is ──

export const DUE_TIERS = ["overdue", "today", "soon", "upcoming", "later"] as const;

export type DueTier = (typeof DUE_TIERS)[number];

/**
 * Which of the five steps a moment falls in. The two thresholds are the user's
 * (designs/metadata.md § Moments); the boundaries themselves are not, because "already
 * past" and "further out than you asked about" are facts rather than choices. A
 * threshold counts calendar days with today as day one: one day reaches today,
 * seven days reach through six days from today.
 *
 * A time of day only ever decides *today*: a date without one is due for the
 * whole of its day, and a date in the future cannot be overdue no matter what
 * the clock says.
 */
export function dueTierOf(
  date: string,
  time: string | undefined,
  today: string,
  nowTime: string,
  tiers: DueTierSettings,
): DueTier {
  const days = dayDifference(date, today);
  if (days < 0) return "overdue";
  if (days === 0 && time && isTimeOfDay(time) && minutesOfDay(time) < minutesOfDay(nowTime)) {
    return "overdue";
  }
  if (days === 0) return "today";
  if (days < tiers.soonDays) return "soon";
  if (days < tiers.upcomingDays) return "upcoming";
  return "later";
}

/** The tone a tier takes, so the chip and the settings preview cannot disagree. */
export function dueToneOf(tier: DueTier, tiers: DueTierSettings): ToneValue {
  switch (tier) {
    case "overdue":
      return tiers.overdueTone;
    case "today":
      return tiers.todayTone;
    case "soon":
      return tiers.soonTone;
    case "upcoming":
      return tiers.upcomingTone;
    default:
      return tiers.laterTone;
  }
}
