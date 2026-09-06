import type { DueTierSettings, ToneValue } from "../../entities/settings";
import { dayDifference } from "../../entities/calendar";
import {
  dueTierOf,
  dueToneOf,
  isTimeOfDay,
  minutesOfDay,
  TASK_SCHEDULED_KEY,
  type DueTier,
  type TaskDateKey,
} from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";

export interface TaskMomentDuePresentation {
  tier: DueTier;
  tone: ToneValue;
  distance: { unit: "day" | "minute"; value: number };
}

export interface TaskMomentPresentation {
  kind: "scheduled" | "deadline";
  label: string;
  dateLabel: string;
  timeLabel: string | null;
  relativeLabel: string | null;
  due: TaskMomentDuePresentation | null;
  repeating: boolean;
  title: string;
}

/** One urgency calculation shared by every surface that projects a moment. */
export function taskMomentDue({
  date,
  time,
  settled,
  today,
  now,
  tiers,
}: {
  date: string;
  time?: string;
  settled: boolean;
  today: string;
  now: string;
  tiers: DueTierSettings;
}): TaskMomentDuePresentation | null {
  if (settled) return null;
  const tier = dueTierOf(date, time, today, now, tiers);
  const days = dayDifference(date, today);
  const distance: TaskMomentDuePresentation["distance"] =
    days === 0 && time && isTimeOfDay(time)
      ? { unit: "minute", value: minutesOfDay(time) - minutesOfDay(now) }
      : { unit: "day", value: days };
  return { tier, tone: dueToneOf(tier, tiers), distance };
}

function relativeMomentLabel(
  key: TaskDateKey,
  due: TaskMomentDuePresentation,
  message: MessageFunction,
): string {
  const { unit, value } = due.distance;
  const kind = key === TASK_SCHEDULED_KEY ? "scheduled" : "deadline";
  if (value === 0) return message(unit === "day" ? "task.relative.today" : "task.relative.now");
  if (unit === "day") {
    if (value === 1) return message("task.relative.tomorrow");
    return message(value > 0 ? "task.relative.daysFuture" : "task.relative.daysPast", {
      kind,
      count: Math.abs(value),
    });
  }
  const minutes = Math.abs(value);
  return message(value > 0 ? "task.relative.timeFuture" : "task.relative.timePast", {
    kind,
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

/** Locale-dependent words are resolved once, before chip and cell diverge. */
export function presentTaskMoment({
  key,
  date,
  time,
  due,
  repeating,
  message,
  formatDate,
  formatTime,
}: {
  key: TaskDateKey;
  date: string;
  time?: string;
  due: TaskMomentDuePresentation | null;
  repeating: boolean;
  message: MessageFunction;
  formatDate: (value: string) => string;
  formatTime: (value: string) => string;
}): TaskMomentPresentation {
  const scheduled = key === TASK_SCHEDULED_KEY;
  const dateLabel = formatDate(date);
  const timeLabel = time ? formatTime(time) : null;
  const relativeLabel = due ? relativeMomentLabel(key, due, message) : null;
  return {
    kind: scheduled ? "scheduled" : "deadline",
    label: message(scheduled ? "task.scheduled" : "task.deadline"),
    dateLabel,
    timeLabel,
    relativeLabel,
    due,
    repeating,
    title: [dateLabel, timeLabel, relativeLabel].filter(Boolean).join(" · "),
  };
}
