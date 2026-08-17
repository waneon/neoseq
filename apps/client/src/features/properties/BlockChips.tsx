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
  queryDocument,
  stringValue,
} from "../../core-port/snapshot";
import { todayLocalDate } from "../../entities/journal";
import { isGenericProperty } from "../../entities/properties";
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
  // Task keys have their own positioned chips above, and a valid query document
  // is presented by the query block itself — a chip would state the same fact
  // twice. The generic rows carry everything else the block states.
  const hasQueryBlock = queryDocument(block.properties) !== undefined;
  const generic = block.properties.filter(
    (field) =>
      isGenericProperty(field.key) &&
      (!isTaskKey(field.key) || field.values.length === 0) &&
      !(field.key === "builtin.query" && hasQueryBlock),
  );
  const hasTaskFacts =
    priority !== undefined || scheduled !== undefined || deadline !== undefined;
  if (!hasTaskFacts && generic.length === 0) return null;

  const overdue =
    deadline !== undefined &&
    deadline < todayLocalDate() &&
    (status === undefined || !isSettledStatus(status));

  const describe = (value: PropertyValue): string => {
    if (value.type === "document") {
      const view = value.value.views.find((item) => item.id === value.value.default_view_id);
      return view?.name ?? value.value.schema;
    }
    if (value.type === "unsupported_document") {
      return `${value.value.schema} v${value.value.version}`;
    }
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
  const describeField = (field: BlockSnapshot["properties"][number]): string =>
    field.values.length === 0
      ? message("properties.noValue")
      : field.values.map(describe).join(", ");

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
      {generic.map((field) => (
        <button
          key={field.key}
          type="button"
          className="task-chip"
          data-testid={`prop-${field.key}`}
          title={`${field.key}: ${describeField(field)}`}
          onClick={(event) => onEdit(field.key, event.currentTarget)}
        >
          {propertyGlyph(field.key, field.value_type)}
          <span className="task-chip-name">{propertyDisplayName(field.key, message)}</span>
          <span className="task-chip-value">{describeField(field)}</span>
          {field.cardinality === "set" && (
            <span className="flag">{message("common.repeated")}</span>
          )}
        </button>
      ))}
    </div>
  );
}
