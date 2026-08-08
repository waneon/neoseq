// The task lens under a block: quiet chips, not a form.
//
// Status lives at the head of the line (`TaskStatusControl`); what remains here
// are the schedule facts — priority, scheduled, deadline — each rendered as one
// chip that reads as metadata and opens the property picker on its own key when
// pressed. A deadline in the past on an unsettled task says so in words
// ("Overdue"), because a colour alone is not a signal and silence here would be
// false. An empty set renders nothing at all.

import type { BlockSnapshot } from "../../core-port/snapshot";
import { dateValue, stringValue } from "../../core-port/snapshot";
import { AlarmClockIcon, CalendarIcon } from "lucide-react";
import { todayLocalDate } from "../../entities/journal";
import {
  isSettledStatus,
  TASK_DEADLINE_KEY,
  TASK_PRIORITY_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
} from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { PriorityGlyph } from "./glyphs";
import { priorityLabel } from "./labels";

export function TaskProjection({
  block,
  onEdit,
}: {
  block: BlockSnapshot;
  onEdit: (key: string, anchor: HTMLElement) => void;
}) {
  const { message, formatJournalDate } = useI18n();
  const status = stringValue(block.properties, TASK_STATUS_KEY);
  const priority = stringValue(block.properties, TASK_PRIORITY_KEY);
  const scheduled = dateValue(block.properties, TASK_SCHEDULED_KEY);
  const deadline = dateValue(block.properties, TASK_DEADLINE_KEY);
  if (priority === undefined && scheduled === undefined && deadline === undefined) return null;

  const formatDay = formatJournalDate;
  const overdue =
    deadline !== undefined &&
    deadline < todayLocalDate() &&
    (status === undefined || !isSettledStatus(status));

  return (
    <div className="task-chips" aria-label={message("task.section")} data-testid="task-projection">
      {priority !== undefined && (
        <button
          type="button"
          className="task-chip"
          data-testid="task-chip-priority"
          onClick={(event) => onEdit(TASK_PRIORITY_KEY, event.currentTarget)}
        >
          <PriorityGlyph priority={priority} />
          <span className="task-chip-name">{message("task.priority")}</span>
          <span className="task-chip-value">{priorityLabel(priority, message)}</span>
        </button>
      )}
      {scheduled !== undefined && (
        <button
          type="button"
          className="task-chip"
          data-testid="task-chip-scheduled"
          onClick={(event) => onEdit(TASK_SCHEDULED_KEY, event.currentTarget)}
        >
          <CalendarIcon aria-hidden />
          <span className="task-chip-name">{message("task.scheduled")}</span>
          <span className="task-chip-value">{formatDay(scheduled)}</span>
        </button>
      )}
      {deadline !== undefined && (
        <button
          type="button"
          className="task-chip"
          data-overdue={overdue || undefined}
          data-testid="task-chip-deadline"
          onClick={(event) => onEdit(TASK_DEADLINE_KEY, event.currentTarget)}
        >
          <AlarmClockIcon aria-hidden />
          <span className="task-chip-name">{message("task.deadline")}</span>
          <span className="task-chip-value">{formatDay(deadline)}</span>
          {overdue && <span className="task-chip-overdue">{message("task.overdue")}</span>}
        </button>
      )}
    </div>
  );
}
