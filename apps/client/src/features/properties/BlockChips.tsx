// The metadata strip under a block: quiet chips, not a form.
//
// Everything typed the block carries beyond its text renders here as one
// wrapping row — the task moments first (scheduled, deadline, repeat; status and
// priority live at the head of the line as their own controls), then every
// generic property, task or user alike, in the same chip language. Each chip is a
// pointer route into the property picker on its own key. An empty set renders
// nothing at all.
//
// A moment carries a tone for how far off it is (designs/metadata.md § Moments). The tone
// is the second reading of a fact the chip already writes out — the date, and the
// word `Overdue` when one has passed — so nothing here is colour-only, and both
// the thresholds and the tones belong to the user (designs/metadata.md § Moments).

import { AlarmClockIcon, CalendarIcon, RepeatIcon } from "lucide-react";
import type { BlockSnapshot, PropertyValue } from "../../core-port/snapshot";
import {
  dateValue,
  findPage,
  isDeleted,
  pageTitle,
  stringValue,
} from "../../core-port/snapshot";
import { nowLocalTime, todayLocalDate } from "../../entities/journal";
import { isGenericProperty } from "../../entities/properties";
import {
  dueTierOf,
  dueToneOf,
  isSettledStatus,
  isTaskKey,
  isTimeOfDay,
  parseRepeat,
  TASK_DEADLINE_KEY,
  TASK_REPEAT_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
  timeKeyFor,
  type TaskDateKey,
} from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useSessionState } from "../shell/session-context";
import { useDueTiers } from "../settings/preferences";
import { repeatLabel } from "../tasks/labels";
import { tonePresentation } from "../tasks/tone-presentation";
import { propertyDisplayName, propertyGlyph } from "./property-display";

export function BlockChips({
  block,
  onEdit,
  representedKeys = [],
}: {
  block: BlockSnapshot;
  onEdit: (key: string, anchor: HTMLElement) => void;
  /** Fields already rendered by the owning surface as dedicated controls. */
  representedKeys?: readonly string[];
}) {
  const state = useSessionState();
  const { message, formatJournalDate, formatTimeOfDay } = useI18n();
  const tiers = useDueTiers();
  const status = stringValue(block.properties, TASK_STATUS_KEY);
  const scheduled = dateValue(block.properties, TASK_SCHEDULED_KEY);
  const deadline = dateValue(block.properties, TASK_DEADLINE_KEY);
  // An interval that does not parse is still the user's own string: it stays on
  // screen and stays editable, it simply does not recur.
  const repeatRaw = stringValue(block.properties, TASK_REPEAT_KEY);
  const repeat = repeatRaw !== undefined ? parseRepeat(repeatRaw) : null;
  // Task keys have their own positioned controls. Feature-owned documents such
  // as queries are excluded by the shared property visibility policy rather
  // than by a surface-specific denylist.
  const generic = block.properties.filter(
    (field) =>
      isGenericProperty(field.key) &&
      !representedKeys.includes(field.key) &&
      (!isTaskKey(field.key) || field.values.length === 0),
  );
  const hasTaskFacts =
    scheduled !== undefined || deadline !== undefined || repeatRaw !== undefined;
  if (!hasTaskFacts && generic.length === 0) return null;

  // A settled task has no urgency left to report: the strike through its line is
  // the whole reading, and a red date on a finished job is noise.
  const settled = status !== undefined && isSettledStatus(status);
  const today = todayLocalDate();
  const nowTime = nowLocalTime();

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

  const momentChip = (key: TaskDateKey, date: string) => {
    const scheduledKey = key === TASK_SCHEDULED_KEY;
    const rawTime = stringValue(block.properties, timeKeyFor(key));
    const time = rawTime !== undefined && isTimeOfDay(rawTime) ? rawTime : undefined;
    const tier = settled ? undefined : dueTierOf(date, time, today, nowTime, tiers);
    const tone = tier ? dueToneOf(tier, tiers) : undefined;
    const Glyph = scheduledKey ? CalendarIcon : AlarmClockIcon;
    return (
      <button
        type="button"
        className="task-chip"
        data-due={tier}
        {...(tone ? tonePresentation(tone) : {})}
        data-testid={scheduledKey ? "task-chip-scheduled" : "task-chip-deadline"}
        onClick={(event) => onEdit(key, event.currentTarget)}
      >
        <Glyph aria-hidden />
        <span className="task-chip-name">
          {message(scheduledKey ? "task.scheduled" : "task.deadline")}
        </span>
        <span className="task-chip-value">
          {formatJournalDate(date)}
          {time && <span className="task-chip-time">{formatTimeOfDay(time)}</span>}
        </span>
        {repeat && <RepeatIcon className="task-chip-repeat" aria-hidden />}
      </button>
    );
  };

  return (
    <div className="block-chips" aria-label={message("task.section")} data-testid="block-chips">
      {scheduled !== undefined && momentChip(TASK_SCHEDULED_KEY, scheduled)}
      {deadline !== undefined && momentChip(TASK_DEADLINE_KEY, deadline)}
      {repeatRaw !== undefined && (
        <button
          type="button"
          className="task-chip"
          data-testid="task-chip-repeat"
          onClick={(event) => onEdit(TASK_REPEAT_KEY, event.currentTarget)}
        >
          <RepeatIcon aria-hidden />
          <span className="task-chip-name">{message("task.repeat")}</span>
          <span className="task-chip-value">
            {repeat ? repeatLabel(repeat, message) : repeatRaw}
          </span>
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
