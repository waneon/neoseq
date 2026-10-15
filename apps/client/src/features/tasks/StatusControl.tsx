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
import { MinusIcon } from "lucide-react";
import type { Command } from "../../core-port/commands";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuChoice,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { TASK_STATUSES } from "../../entities/tasks";
import { nextOccurrence, taskStatusCommand } from "./commands";
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
  const recurs = nextOccurrence(block) !== undefined;

  const run = async (command: Command) => {
    try {
      await session.execute(command);
      return true;
    } catch (error) {
      notify.failure(message("failure.setProperty"), error);
      return false;
    }
  };

  const choose = async (value: string) => {
    // Completing a recurring occurrence moves a date the user may not be
    // looking at, so the roll-forward says where it went.
    const next = value === "done" ? nextOccurrence(block) : undefined;
    const committed = await run(taskStatusCommand(owner, block, value));
    if (!committed || next === undefined) return;
    notify.show({
      tone: "info",
      key: `task-repeat-${block.id}`,
      title: message("task.repeatRolled", { date: formatJournalDate(next) }),
    });
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
          <DropdownMenuChoice key={option} value={option} onSelect={() => void choose(option)}>
            <TaskStatusGlyph status={option} />
            {option === "done" && recurs
              ? message("task.completeOccurrence")
              : statusLabel(option, message)}
          </DropdownMenuChoice>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="remove-status"
        onSelect={() => void run(taskStatusCommand(owner, block, undefined))}
      >
        <MinusIcon aria-hidden />
        {message("task.removeStatus")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
