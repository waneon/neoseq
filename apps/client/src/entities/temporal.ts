import { addDays, addMonths } from "./journal";

export type TemporalUnit = "day" | "week" | "month";

/** Locale-independent meaning produced by a language pack. */
export type TemporalDateIntent =
  | { readonly kind: "absolute"; readonly date: string }
  | {
      readonly kind: "calendar";
      readonly year?: number;
      readonly month: number;
      readonly day: number;
    }
  | {
      readonly kind: "relative";
      readonly unit: TemporalUnit;
      readonly amount: number;
    }
  | {
      readonly kind: "weekday";
      readonly weekday: number;
      readonly direction: "future" | "past";
      readonly includeToday?: boolean;
    };

export interface TemporalTimeIntent {
  readonly hour: number;
  readonly minute: number;
}

export type TemporalRecurrenceUnit = "day" | "week" | "month" | "year";

export interface TemporalRecurrenceIntent {
  readonly count: number;
  readonly unit: TemporalRecurrenceUnit;
}

export interface TemporalMomentIntent {
  readonly date?: TemporalDateIntent;
  readonly time?: TemporalTimeIntent;
  readonly recurrence?: TemporalRecurrenceIntent;
}

export interface TemporalContext {
  readonly today: string;
}

export interface ResolvedMoment {
  readonly date: string;
  readonly time?: string;
  readonly recurrence?: TemporalRecurrenceIntent;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Resolve language-neutral calendar meaning against an explicit local day. */
export function resolveDateIntent(
  intent: TemporalDateIntent,
  context: TemporalContext,
): string | null {
  if (!isCalendarDate(context.today)) return null;

  switch (intent.kind) {
    case "absolute":
      return isCalendarDate(intent.date) ? intent.date : null;
    case "calendar": {
      const year = intent.year ?? Number(context.today.slice(0, 4));
      const candidate = `${String(year).padStart(4, "0")}-${pad(intent.month)}-${pad(intent.day)}`;
      return isCalendarDate(candidate) ? candidate : null;
    }
    case "relative":
      if (!Number.isInteger(intent.amount)) return null;
      if (intent.unit === "month") return addMonths(context.today, intent.amount);
      return addDays(context.today, intent.amount * (intent.unit === "week" ? 7 : 1));
    case "weekday": {
      if (!Number.isInteger(intent.weekday) || intent.weekday < 0 || intent.weekday > 6) {
        return null;
      }
      const current = dayOfWeek(context.today);
      const distance =
        intent.direction === "future"
          ? (intent.weekday - current + 7) % 7
          : -((current - intent.weekday + 7) % 7);
      const delta =
        distance === 0 && !intent.includeToday
          ? intent.direction === "future"
            ? 7
            : -7
          : distance;
      return addDays(context.today, delta);
    }
  }
}

export function resolveMomentIntent(
  intent: TemporalMomentIntent,
  context: TemporalContext,
): ResolvedMoment | null {
  if (!isCalendarDate(context.today) || (!intent.date && !intent.time && !intent.recurrence)) {
    return null;
  }
  const date = intent.date ? resolveDateIntent(intent.date, context) : context.today;
  if (!date) return null;
  let time: string | undefined;
  if (intent.time) {
    const { hour, minute } = intent.time;
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    time = `${pad(hour)}:${pad(minute)}`;
  }
  if (intent.recurrence) {
    const { count, unit } = intent.recurrence;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 999 ||
      !(["day", "week", "month", "year"] as const).includes(unit)
    ) {
      return null;
    }
  }
  return {
    date,
    ...(time ? { time } : {}),
    ...(intent.recurrence ? { recurrence: intent.recurrence } : {}),
  };
}
