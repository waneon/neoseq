// The task's own checkbox, grown up.
//
// A block that carries `builtin.task-status` shows its state as a glyph at the
// head of its line — the position a checkbox has held in every list tool, which
// is what makes it legible without a label. Clicking it opens the one dropdown
// the product uses for every choice (designs/interaction.md § Choice): `menuitemradio` rows,
// one per registry status, each led by its shape. A stored value outside the
// suggested set stays listed, so opening the menu can never silently rewrite
// it, and removing the status is an explicit row — never a side effect.
//
// A recurring task answers `Done` differently, and designs/metadata.md § Tasks says
// why: completing one occurrence is not finishing the task, so the status stays
// `todo` and its dates roll forward by the stored interval instead.
//
// The *menu* is exported separately from the control, because a query result's
// status cell has to open the same one. It used to route through the generic
// property picker instead — so the same value, reached from a table rather than
// from a line, offered a two-stage key/value panel where the outline offered four
// radio rows. designs/interaction.md § Choice says two controls that look alike may not open different
// popups; the corollary is that one value may not have two popups either.

import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { dateValue, stringValue } from "../../core-port/snapshot";
import { MinusIcon } from "lucide-react";
import type { Command, PropertyChange } from "../../core-port/commands";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import {
  advanceDate,
  parseRepeat,
  TASK_DEADLINE_KEY,
  TASK_REPEAT_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
  TASK_STATUSES,
} from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";
import { TaskStatusGlyph } from "./glyphs";
import { statusLabel } from "./labels";

export function TaskStatusControl({
  owner,
  block,
  status,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  status: string;
}) {
  const { message } = useI18n();
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="task-status-toggle"
          aria-label={message("task.statusIs", { status: statusLabel(status, message) })}
          data-testid="task-status-toggle"
          data-status={status}
          disabled={readonly}
        >
          <TaskStatusGlyph status={status} />
        </button>
      </DropdownMenuTrigger>
      <TaskStatusMenu owner={owner} block={block} status={status} />
    </DropdownMenu>
  );
}

/** The rows a status choice offers, for whatever trigger opened them. */
export function TaskStatusMenu({
  owner,
  block,
  status,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  status: string;
}) {
  const session = useSession();
  const notify = useNotify();
  const { message, formatJournalDate } = useI18n();
  const entity = { kind: "block", owner, id: block.id } as const;

  const run = async (command: Command) => {
    try {
      await session.execute(command);
      return true;
    } catch (error) {
      notify.failure(message("failure.setProperty"), error);
      return false;
    }
  };

  const setStatus = (value: string): Command => ({
    type: "set_property",
    owner: entity,
    key: TASK_STATUS_KEY,
    value: { type: "string", value },
  });

  const repeat = parseRepeat(stringValue(block.properties, TASK_REPEAT_KEY) ?? "");
  const scheduled = dateValue(block.properties, TASK_SCHEDULED_KEY);
  const deadline = dateValue(block.properties, TASK_DEADLINE_KEY);
  const recurs = repeat !== null && (scheduled !== undefined || deadline !== undefined);

  /** One completed occurrence is one property transition and one undo item. */
  const advance = async () => {
    if (!repeat) return;
    const changes: PropertyChange[] = [];
    const rolled = (key: string, date: string) => {
      changes.push({
        key,
        value: { type: "date", value: advanceDate(date, repeat) },
      });
    };
    if (scheduled !== undefined) rolled(TASK_SCHEDULED_KEY, scheduled);
    if (deadline !== undefined) rolled(TASK_DEADLINE_KEY, deadline);
    if (status !== "todo") {
      changes.push({ key: TASK_STATUS_KEY, value: { type: "string", value: "todo" } });
    }
    const committed = await run({ type: "set_properties", owner: entity, changes });
    if (!committed) return;
    // The one visible thing a completed occurrence does is move a date the user
    // may not be looking at, so the roll-forward says where it went.
    const next = scheduled ?? deadline;
    if (next !== undefined) {
      notify.show({
        tone: "info",
        key: `task-repeat-${block.id}`,
        title: message("task.repeatRolled", {
          date: formatJournalDate(advanceDate(next, repeat)),
        }),
      });
    }
  };

  const choose = (value: string) => {
    if (value === "done" && recurs) {
      void advance();
      return;
    }
    void run(setStatus(value));
  };

  // A value the core holds that is not one of the suggested four is still a
  // value: it stays listed with its own (dashed) glyph. The *absence* of one is
  // not — a query result's status column is empty on any row that has no status,
  // and listing "" would offer a blank row above the four real answers.
  const options =
    !status || TASK_STATUSES.includes(status) ? TASK_STATUSES : [status, ...TASK_STATUSES];

  return (
    <DropdownMenuContent align="start" aria-label={message("task.statusLabel")}>
      {/* The group owns `aria-checked`; each row owns what choosing it does.
          Leaving the write to `onValueChange` would mean the one row whose verb
          is not "become this value" — `Complete occurrence` on a task already
          sitting at `done` — silently did nothing. */}
      <DropdownMenuRadioGroup value={status}>
        {options.map((option) => (
          <DropdownMenuRadioItem key={option} value={option} onSelect={() => choose(option)}>
            <TaskStatusGlyph status={option} />
            {option === "done" && recurs
              ? message("task.completeOccurrence")
              : statusLabel(option, message)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="remove-status"
        onSelect={() => void run({ type: "remove_property", owner: entity, key: TASK_STATUS_KEY })}
      >
        <MinusIcon aria-hidden />
        {message("task.removeStatus")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
