import type { DueTierSettings, ToneValue } from "../../entities/settings";
import {
  dueTierOf,
  dueToneOf,
  TASK_SCHEDULED_KEY,
  type DueTier,
  type TaskDateKey,
} from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";

export interface TaskMomentDuePresentation {
  tier: DueTier;
  tone: ToneValue;
}

export interface TaskMomentPresentation {
  kind: "scheduled" | "deadline";
  label: string;
  dateLabel: string;
  timeLabel: string | null;
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
  return { tier, tone: dueToneOf(tier, tiers) };
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
  return {
    kind: scheduled ? "scheduled" : "deadline",
    label: message(scheduled ? "task.scheduled" : "task.deadline"),
    dateLabel,
    timeLabel,
    due,
    repeating,
    title: [dateLabel, timeLabel].filter(Boolean).join(" · "),
  };
}
