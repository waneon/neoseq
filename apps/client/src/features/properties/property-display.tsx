// How a property key presents itself.
//
// Storage names are contracts (`builtin.task-scheduled`, `user.effort`); what a
// person reads is a product word with a glyph. A builtin key has a localized
// name and its feature's own mark; a user key is the user's own word, shown
// without the `user.` routing prefix it is stored under. Every surface that
// prints a key — the picker, the chips under a block, the page strip — goes
// through here, so a key can never read two different ways.

import type { ReactNode } from "react";
import {
  AlarmClockIcon,
  CalendarIcon,
  ClockIcon,
  FileTextIcon,
  HashIcon,
  PlusIcon,
  RepeatIcon,
  SearchCodeIcon,
  SquareCheckIcon,
  TypeIcon,
} from "lucide-react";
import type { PropertyValueType } from "../../core-port/snapshot";
import {
  TASK_DEADLINE_KEY,
  TASK_DEADLINE_TIME_KEY,
  TASK_PRIORITY_KEY,
  TASK_REPEAT_KEY,
  TASK_SCHEDULED_KEY,
  TASK_SCHEDULED_TIME_KEY,
  TASK_STATUS_KEY,
} from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";

const USER_PREFIX = "user.";

/** The name a key goes by on screen. Falls back to the raw key for unknowns. */
export function propertyDisplayName(key: string, message: MessageFunction): string {
  switch (key) {
    case TASK_STATUS_KEY:
      return message("task.status");
    case TASK_PRIORITY_KEY:
      return message("task.priority");
    case TASK_SCHEDULED_KEY:
      return message("task.scheduled");
    case TASK_DEADLINE_KEY:
      return message("task.deadline");
    case TASK_SCHEDULED_TIME_KEY:
      return message("task.scheduledTime");
    case TASK_DEADLINE_TIME_KEY:
      return message("task.deadlineTime");
    case TASK_REPEAT_KEY:
      return message("task.repeat");
    case "builtin.query":
      return message("properties.builtin.query");
    default:
      return key.startsWith(USER_PREFIX) ? key.slice(USER_PREFIX.length) : key;
  }
}

/** One glyph per value type, so a key reads as its kind before its name. */
export function TypeGlyph({ type }: { type: PropertyValueType | undefined }) {
  switch (type) {
    case "number":
      return <HashIcon data-type-glyph aria-hidden />;
    case "checkbox":
      return <SquareCheckIcon data-type-glyph aria-hidden />;
    case "date":
      return <CalendarIcon data-type-glyph aria-hidden />;
    case "page":
      return <FileTextIcon data-type-glyph aria-hidden />;
    case "string":
      return <TypeIcon data-type-glyph aria-hidden />;
    case "document":
      return <SearchCodeIcon data-type-glyph aria-hidden />;
    default:
      return <PlusIcon data-type-glyph aria-hidden />;
  }
}

/**
 * The mark that stands beside a key's name: the feature's own glyph for a
 * builtin, the value-type glyph for everything else.
 */
export function propertyGlyph(key: string, valueType?: PropertyValueType): ReactNode {
  switch (key) {
    // `data-plain` because these stand for the *key*, not for a value it holds:
    // a red "high" glyph beside the word "Priority" would name a priority the
    // property does not have (designs/foundations.md § Semantic Color on a glyph).
    case TASK_STATUS_KEY:
      return <TaskStatusGlyph status="todo" data-plain />;
    case TASK_PRIORITY_KEY:
      return <PriorityGlyph priority="high" data-plain />;
    case TASK_SCHEDULED_KEY:
      return <CalendarIcon data-type-glyph aria-hidden />;
    case TASK_DEADLINE_KEY:
      return <AlarmClockIcon data-type-glyph aria-hidden />;
    case TASK_SCHEDULED_TIME_KEY:
    case TASK_DEADLINE_TIME_KEY:
      return <ClockIcon data-type-glyph aria-hidden />;
    case TASK_REPEAT_KEY:
      return <RepeatIcon data-type-glyph aria-hidden />;
    case "builtin.query":
      return <SearchCodeIcon data-type-glyph aria-hidden />;
    default:
      return <TypeGlyph type={valueType} />;
  }
}

/**
 * The stored key a picker query means. A bare name is a user property — typing
 * `effort` creates `user.effort` — while a dotted name is taken literally so
 * full keys keep working.
 */
export function storageKeyForQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.includes(".")) return trimmed;
  return `${USER_PREFIX}${trimmed.toLocaleLowerCase().replace(/\s+/gu, "-")}`;
}
