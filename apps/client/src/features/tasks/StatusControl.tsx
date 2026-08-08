// The task's own checkbox, grown up.
//
// A block that carries `builtin.task-status` shows its state as a glyph at the
// head of its line — the position a checkbox has held in every list tool, which
// is what makes it legible without a label. Clicking it opens the one dropdown
// the product uses for every choice (DESIGN.md § Choice): `menuitemradio` rows,
// one per registry status, each led by its shape. A stored value outside the
// suggested set stays listed, so opening the menu can never silently rewrite
// it, and removing the status is an explicit row — never a side effect.

import type { BlockSnapshot } from "../../core-port/snapshot";
import { MinusIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { TASK_STATUS_KEY, TASK_STATUSES } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { TaskStatusGlyph } from "./glyphs";
import { statusLabel } from "./labels";

export function TaskStatusControl({
  pageId,
  block,
  status,
}: {
  pageId: string;
  block: BlockSnapshot;
  status: string;
}) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const readonly = state.mode === "readonly";
  const entity = { kind: "block", page_id: pageId, id: block.id } as const;

  const run = (command: Parameters<typeof session.execute>[0]) =>
    session.execute(command).catch((error: unknown) => {
      notify.failure(message("failure.setProperty"), error);
    });

  // A value the core holds that is not one of the suggested four is still a
  // value: it stays listed with its own (dashed) glyph.
  const options = TASK_STATUSES.includes(status) ? TASK_STATUSES : [status, ...TASK_STATUSES];

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
      <DropdownMenuContent align="start" aria-label={message("task.statusLabel")}>
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={(value) =>
            void run({ type: "set_property", entity, key: TASK_STATUS_KEY, value: { type: "string", value } })}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <TaskStatusGlyph status={option} />
              {statusLabel(option, message)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="remove-status"
          onSelect={() => void run({ type: "remove_property", entity, key: TASK_STATUS_KEY })}
        >
          <MinusIcon aria-hidden />
          {message("task.removeStatus")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
