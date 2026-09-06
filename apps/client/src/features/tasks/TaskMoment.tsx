import { AlarmClockIcon, CalendarIcon, RepeatIcon } from "lucide-react";
import { tonePresentation } from "./tone-presentation";
import type { TaskMomentPresentation } from "./moment-presentation";

export function TaskMoment({
  value,
  appearance,
  testId,
  onEdit,
}: {
  value: TaskMomentPresentation;
  appearance: "chip" | "cell";
  testId?: string;
  onEdit?: (anchor: HTMLButtonElement) => void;
}) {
  const tone = value.due ? tonePresentation(value.due.tone) : {};
  if (appearance === "cell") {
    return (
      <span
        className="query-due task-moment-value"
        data-task-moment={value.kind}
        data-due={value.due?.tier}
        {...tone}
        title={value.title}
      >
        <span className="query-due-date">{value.dateLabel}</span>
        {value.timeLabel && <span className="query-due-time">{value.timeLabel}</span>}
        {value.relativeLabel && (
          <span className="task-moment-relative">· {value.relativeLabel}</span>
        )}
      </span>
    );
  }

  const Glyph = value.kind === "scheduled" ? CalendarIcon : AlarmClockIcon;
  return (
    <button
      type="button"
      className="task-chip"
      data-task-moment={value.kind}
      data-due={value.due?.tier}
      {...tone}
      data-testid={testId}
      title={value.title}
      aria-label={`${value.label} ${value.title}`}
      onClick={(event) => onEdit?.(event.currentTarget)}
    >
      <Glyph aria-hidden />
      <span className="task-chip-name">{value.label}</span>
      <span className="task-chip-value task-moment-value">
        <span className="task-moment-date">{value.dateLabel}</span>
        {value.timeLabel && <span className="task-chip-time">{value.timeLabel}</span>}
        {value.relativeLabel && (
          <span className="task-moment-relative">· {value.relativeLabel}</span>
        )}
      </span>
      {value.repeating && <RepeatIcon className="task-chip-repeat" aria-hidden />}
    </button>
  );
}
