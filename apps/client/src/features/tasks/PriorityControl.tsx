// Priority, beside the status glyph rather than under the line.
//
// Priority answers the same question status does — "how do I read this line?" —
// and it answers it before the words. Under the text it was a chip among chips,
// read after the sentence it was supposed to qualify and competing with a
// property strip for attention; at the head of the line it is the second mark
// in a two-mark cluster, which is where a person scanning a page for what to do
// next is already looking (DESIGN.md § Tasks).
//
// It is the status control's twin in every other respect: the same dropdown
// (§ Choice), `menuitemradio` rows led by their own shape, the registry's values
// offered strongest first, a stored value outside that set kept listed, and an
// explicit removal row — and, like it, the menu is exported apart from the trigger
// so a query result's priority cell opens the same rows rather than the generic
// property picker.

import { MinusIcon } from "lucide-react";
import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
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
  offeredChoices,
  TASK_PRIORITIES,
  TASK_PRIORITY_KEY,
} from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { PriorityGlyph } from "./glyphs";
import { priorityLabel } from "./labels";

export function TaskPriorityControl({
  owner,
  block,
  priority,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  priority: string;
}) {
  const { message } = useI18n();
  const readonly = useSessionState().mode === "readonly";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="task-priority-toggle"
          aria-label={message("task.priorityIs", {
            priority: priorityLabel(priority, message),
          })}
          data-testid="task-priority-toggle"
          data-priority={priority}
          disabled={readonly}
        >
          <PriorityGlyph priority={priority} />
        </button>
      </DropdownMenuTrigger>
      <TaskPriorityMenu owner={owner} block={block} priority={priority} />
    </DropdownMenu>
  );
}

/** The rows a priority choice offers, for whatever trigger opened them. */
export function TaskPriorityMenu({
  owner,
  block,
  priority,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  priority: string;
}) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const entity = { kind: "block", owner, id: block.id } as const;

  const run = (command: Parameters<typeof session.execute>[0]) =>
    session.execute(command).catch((error: unknown) => {
      notify.failure(message("failure.setProperty"), error);
    });

  const offered = offeredChoices(TASK_PRIORITY_KEY, TASK_PRIORITIES);
  // As in the status menu: a stored value outside the set stays listed, the
  // absence of one does not.
  const options = !priority || offered.includes(priority)
    ? offered
    : [priority, ...offered];

  return (
    <DropdownMenuContent align="start" aria-label={message("task.priority")}>
      <DropdownMenuRadioGroup
        value={priority}
        onValueChange={(value) =>
          void run({
            type: "set_property",
            owner: entity,
            key: TASK_PRIORITY_KEY,
            value: { type: "string", value },
          })}
      >
        {options.map((option) => (
          <DropdownMenuRadioItem key={option} value={option}>
            <PriorityGlyph priority={option} />
            {priorityLabel(option, message)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="remove-priority"
        onSelect={() => void run({ type: "remove_property", owner: entity, key: TASK_PRIORITY_KEY })}
      >
        <MinusIcon aria-hidden />
        {message("task.removePriority")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
