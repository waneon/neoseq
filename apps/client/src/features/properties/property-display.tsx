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
  FileTextIcon,
  HashIcon,
  LanguagesIcon,
  PlusIcon,
  SearchCodeIcon,
  SquareCheckIcon,
  TypeIcon,
} from "lucide-react";
import type { PropertyValueType } from "../../core-port/snapshot";
import {
  TASK_DEADLINE_KEY,
  TASK_PRIORITY_KEY,
  TASK_SCHEDULED_KEY,
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
    case "builtin.query-source":
      return message("properties.builtin.querySource");
    case "builtin.query-language":
      return message("properties.builtin.queryLanguage");
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
    case TASK_STATUS_KEY:
      return <TaskStatusGlyph status="todo" />;
    case TASK_PRIORITY_KEY:
      return <PriorityGlyph priority="high" />;
    case TASK_SCHEDULED_KEY:
      return <CalendarIcon data-type-glyph aria-hidden />;
    case TASK_DEADLINE_KEY:
      return <AlarmClockIcon data-type-glyph aria-hidden />;
    case "builtin.query-source":
      return <SearchCodeIcon data-type-glyph aria-hidden />;
    case "builtin.query-language":
      return <LanguagesIcon data-type-glyph aria-hidden />;
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
