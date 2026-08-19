// What `/` can say inside a block.
//
// The slash menu is the editor's own command surface: the fast route from a
// line of text to the typed metadata that turns it into a task, a date, or a
// record. Items are declared here — grouped, localized, alias-matched — and the
// Outliner owns detection, keyboard state, and what accepting an item does,
// because only it can remove the token and reconcile pending blocks.
//
// A direct item (`set`) writes one property with one keystroke; an indirect
// item (`picker`) opens the property picker, optionally already on a key. Both
// remove the slash token first, so the command never leaks into the Markdown.

import type { ReactNode } from "react";
import {
  AlarmClockIcon,
  CalendarIcon,
  FileTextIcon,
  HashIcon,
  ListTreeIcon,
  RepeatIcon,
  Settings2Icon,
} from "lucide-react";
import type { PropertyValue } from "../../core-port/snapshot";
import type { PlanSubject } from "../../entities/query-plan";
import {
  TASK_DEADLINE_KEY,
  TASK_PRIORITIES,
  TASK_PRIORITY_KEY,
  TASK_REPEAT_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
  TASK_STATUSES,
} from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";
import { fuzzyScore } from "../commands/registry";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";

type SlashAction =
  | { kind: "set"; key: string; value: PropertyValue }
  | { kind: "picker"; key?: string }
  /** Turns the block into a query and opens the builder on a starting plan. */
  | { kind: "query"; subject: PlanSubject };

export type SlashGroup = "status" | "priority" | "date" | "query" | "property";

/** Groups in the order the menu renders them. */
export const SLASH_GROUP_ORDER: SlashGroup[] = [
  "status",
  "priority",
  "date",
  "query",
  "property",
];

export interface SlashItem {
  id: string;
  group: SlashGroup;
  label: string;
  hint?: string;
  /** Extra match terms, so English and Korean both reach every item. */
  aliases: readonly string[];
  glyph: ReactNode;
  action: SlashAction;
}

const STATUS_ALIASES: Record<string, readonly string[]> = {
  todo: ["todo", "to do", "task", "할일", "할 일"],
  doing: ["doing", "in progress", "task", "진행", "진행 중"],
  done: ["done", "complete", "task", "완료"],
  cancelled: ["cancelled", "canceled", "task", "취소"],
};

const PRIORITY_ALIASES: Record<string, readonly string[]> = {
  low: ["low priority", "priority low", "낮음", "우선순위"],
  medium: ["medium priority", "priority medium", "보통", "우선순위"],
  high: ["high priority", "priority high", "높음", "우선순위"],
};

export function buildSlashItems(message: MessageFunction): SlashItem[] {
  const items: SlashItem[] = [];
  for (const status of TASK_STATUSES) {
    items.push({
      id: `status-${status}`,
      group: "status",
      label: message(`task.status.${status}` as
        | "task.status.todo"
        | "task.status.doing"
        | "task.status.done"
        | "task.status.cancelled"),
      aliases: STATUS_ALIASES[status] ?? [status],
      glyph: <TaskStatusGlyph status={status} />,
      action: { kind: "set", key: TASK_STATUS_KEY, value: { type: "string", value: status } },
    });
  }
  for (const priority of TASK_PRIORITIES) {
    items.push({
      id: `priority-${priority}`,
      group: "priority",
      label: message(`task.priority.${priority}` as
        | "task.priority.low"
        | "task.priority.medium"
        | "task.priority.high"),
      aliases: PRIORITY_ALIASES[priority] ?? [priority],
      glyph: <PriorityGlyph priority={priority} />,
      action: { kind: "set", key: TASK_PRIORITY_KEY, value: { type: "string", value: priority } },
    });
  }
  items.push({
    id: "scheduled",
    group: "date",
    label: message("task.scheduled"),
    hint: message("slash.scheduledHint"),
    aliases: ["scheduled", "schedule", "date", "예정", "예정일", "일정"],
    glyph: <CalendarIcon aria-hidden />,
    action: { kind: "picker", key: TASK_SCHEDULED_KEY },
  });
  items.push({
    id: "deadline",
    group: "date",
    label: message("task.deadline"),
    hint: message("slash.deadlineHint"),
    aliases: ["deadline", "due", "마감", "마감일"],
    glyph: <AlarmClockIcon aria-hidden />,
    action: { kind: "picker", key: TASK_DEADLINE_KEY },
  });
  items.push({
    id: "repeat",
    group: "date",
    label: message("task.repeat"),
    hint: message("slash.repeatHint"),
    aliases: ["repeat", "recur", "recurring", "every", "반복", "되풀이"],
    glyph: <RepeatIcon aria-hidden />,
    action: { kind: "picker", key: TASK_REPEAT_KEY },
  });
  // `/` is the only route to a query: the property picker does not offer
  // `builtin.query`, because a query is built, not filled in.
  // The three share one alias — `query` — so typing the word ranks them in the
  // order declared here rather than by how long their labels happen to be.
  items.push({
    id: "query-blocks",
    group: "query",
    label: message("query.slashBlocks"),
    hint: message("query.slashBlocksHint"),
    aliases: ["query", "search", "filter", "쿼리", "검색", "찾기"],
    glyph: <ListTreeIcon aria-hidden />,
    action: { kind: "query", subject: "block" },
  });
  items.push({
    id: "query-pages",
    group: "query",
    label: message("query.slashPages"),
    hint: message("query.slashPagesHint"),
    aliases: ["query", "search", "쿼리", "검색"],
    glyph: <FileTextIcon aria-hidden />,
    action: { kind: "query", subject: "page" },
  });
  items.push({
    id: "query-tags",
    group: "query",
    label: message("query.slashTags"),
    hint: message("query.slashTagsHint"),
    aliases: ["query", "search", "쿼리", "검색"],
    glyph: <HashIcon aria-hidden />,
    action: { kind: "query", subject: "tag" },
  });
  items.push({
    id: "property",
    group: "property",
    label: message("properties.slashLabel"),
    hint: message("properties.slashHint"),
    aliases: ["property", "properties", "metadata", "속성", "프로퍼티"],
    glyph: <Settings2Icon aria-hidden />,
    action: { kind: "picker" },
  });
  return items;
}

/**
 * Items the query reaches, best match first inside the declared group order.
 * An empty query keeps the full menu in its declared order.
 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const needle = query.trim();
  if (!needle) return items;
  const scored: { item: SlashItem; score: number }[] = [];
  for (const item of items) {
    let best = fuzzyScore(item.label, needle);
    for (const alias of item.aliases) {
      const score = fuzzyScore(alias, needle);
      if (score !== null && (best === null || score - 20 > best)) best = score - 20;
    }
    if (best !== null) scored.push({ item, score: best });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored.map((entry) => entry.item);
}
