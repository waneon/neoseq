// The metadata strip under a block: quiet chips, not a form.
//
// Everything typed the block carries beyond its text renders here as one
// wrapping row — the task facts first (priority, scheduled, deadline; status
// lives at the head of the line as `TaskStatusControl`), then every generic
// property, task or user alike, in the same chip language. Each chip is a
// pointer route into the property picker on its own key. A deadline in the
// past on an unsettled task says so in words ("Overdue"), because a colour
// alone is not a signal. An empty set renders nothing at all.

import { AlarmClockIcon, CalendarIcon } from "lucide-react";
import type { BlockSnapshot, PropertyValue } from "../../core-port/snapshot";
import {
  dateValue,
  findPage,
  isDeleted,
  pageTitle,
  stringValue,
} from "../../core-port/snapshot";
import { todayLocalDate } from "../../entities/journal";
import { cardinalityOf, isGenericProperty } from "../../entities/properties";
import {
  isSettledStatus,
  isTaskKey,
  TASK_DEADLINE_KEY,
  TASK_PRIORITY_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
} from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useSessionState } from "../shell/session-context";
import { PriorityGlyph } from "../tasks/glyphs";
import { priorityLabel } from "../tasks/labels";
import { propertyDisplayName, propertyGlyph } from "./property-display";

export function BlockChips({
  block,
  onEdit,
}: {
  block: BlockSnapshot;
  onEdit: (key: string, anchor: HTMLElement) => void;
}) {
  const state = useSessionState();
  const { message, formatJournalDate } = useI18n();
  const status = stringValue(block.properties, TASK_STATUS_KEY);
  const priority = stringValue(block.properties, TASK_PRIORITY_KEY);
  const scheduled = dateValue(block.properties, TASK_SCHEDULED_KEY);
  const deadline = dateValue(block.properties, TASK_DEADLINE_KEY);
  // Task keys have their own positioned chips above; the generic rows carry
  // everything else the block states, in the same chip language.
  const generic = block.properties.filter(
    (entry) => isGenericProperty(entry.key) && !isTaskKey(entry.key),
  );
  const hasTaskFacts =
    priority !== undefined || scheduled !== undefined || deadline !== undefined;
  if (!hasTaskFacts && generic.length === 0) return null;

  const overdue =
    deadline !== undefined &&
    deadline < todayLocalDate() &&
    (status === undefined || !isSettledStatus(status));

  const describe = (value: PropertyValue): string => {
    if (value.type === "checkbox") {
      return value.value ? message("common.yes") : message("common.no");
    }
    if (value.type === "date") return formatJournalDate(value.value);
    if (value.type === "page") {
      const page = findPage(state.snapshot, value.value);
      if (!page) return value.value;
      return isDeleted(page)
        ? message("properties.deleted", { name: pageTitle(page) })
        : pageTitle(page);
    }
    return String(value.value);
  };

  return (
    <div className="block-chips" aria-label={message("task.section")} data-testid="block-chips">
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
          <span className="task-chip-value">{formatJournalDate(scheduled)}</span>
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
          <span className="task-chip-value">{formatJournalDate(deadline)}</span>
          {overdue && <span className="task-chip-overdue">{message("task.overdue")}</span>}
        </button>
      )}
      {generic.map((entry, index) => (
        <button
          key={`${entry.key}:${index}`}
          type="button"
          className="task-chip"
          data-testid={`prop-${entry.key}`}
          title={`${entry.key}: ${describe(entry.value)}`}
          onClick={(event) => onEdit(entry.key, event.currentTarget)}
        >
          {propertyGlyph(entry.key, entry.value.type)}
          <span className="task-chip-name">{propertyDisplayName(entry.key, message)}</span>
          <span className="task-chip-value">{describe(entry.value)}</span>
          {cardinalityOf(entry.key) === "repeated" && (
            <span className="flag">{message("common.repeated")}</span>
          )}
        </button>
      ))}
    </div>
  );
}
