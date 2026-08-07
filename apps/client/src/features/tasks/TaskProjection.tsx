import type { BlockSnapshot, PropertyValue } from "../../core-port/snapshot";
import { dateValue, stringValue } from "../../core-port/snapshot";
import { Input } from "@/ui/shadcn/input";
import { MenuSelect } from "@/ui/menu-select";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

const STATUSES = ["todo", "doing", "done"];
const PRIORITIES = ["low", "medium", "high"];

export function TaskProjection({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const { message } = useI18n();
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const status = stringValue(block.properties, "builtin.task-status");
  const priority = stringValue(block.properties, "builtin.priority");
  const scheduled = dateValue(block.properties, "builtin.scheduled");
  const deadline = dateValue(block.properties, "builtin.deadline");
  const isTask = block.properties.some((entry) => [
    "builtin.task-status",
    "builtin.priority",
    "builtin.scheduled",
    "builtin.deadline",
  ].includes(entry.key));
  if (!isTask) return null;

  // A rejected write leaves the control showing the authoritative value again,
  // which on its own reads as a control that did not register the change.
  const set = (key: string, value: PropertyValue) =>
    session
      .execute({
        type: "set_property",
        entity: { kind: "block", page_id: pageId, id: block.id },
        key,
        value,
      })
      .catch((error: unknown) => {
        notify.failure(message("failure.setProperty"), error);
      });
  const readonly = state.mode === "readonly";

  return (
    <div
      className="task-projection"
      aria-label={message("task.section")}
      data-testid="task-projection"
    >
      <label>
        <span>{message("builtin.task-status")}</span>
        <MenuSelect
          label={message("builtin.task-statusLabel")}
          value={status ?? ""}
          disabled={readonly}
          placeholder={message("task.unset")}
          options={[
            // A value the core holds that is not one of the three is still a
            // value: it stays listed, so opening the menu cannot silently
            // rewrite it.
            ...(status && !STATUSES.includes(status)
              ? [{ value: status, label: status }]
              : []),
            ...STATUSES.map((item) => ({
              value: item,
              label: message(`builtin.task-status.${item}` as
                | "builtin.task-status.todo"
                | "builtin.task-status.doing"
                | "builtin.task-status.done"),
            })),
          ]}
          onValueChange={(value) => void set("builtin.task-status", { type: "string", value })}
        />
      </label>
      {(priority !== undefined || status !== undefined) && (
        <label>
          <span>{message("builtin.priority")}</span>
          <MenuSelect
            label={message("builtin.priorityLabel")}
            value={priority ?? ""}
            disabled={readonly}
            placeholder={message("task.unset")}
            options={[
              ...(priority && !PRIORITIES.includes(priority)
                ? [{ value: priority, label: priority }]
                : []),
              ...PRIORITIES.map((item) => ({
                value: item,
                label: message(`builtin.priority.${item}` as
                  | "builtin.priority.low"
                  | "builtin.priority.medium"
                  | "builtin.priority.high"),
              })),
            ]}
            onValueChange={(value) => void set("builtin.priority", { type: "string", value })}
          />
        </label>
      )}
      {scheduled !== undefined && (
        <label>
          <span>{message("builtin.scheduled")}</span>
          <Input
            type="date"
            aria-label={message("builtin.scheduledLabel")}
            value={scheduled}
            disabled={readonly}
            onChange={(event) => event.target.value && void set("builtin.scheduled", { type: "date", value: event.target.value })}
          />
        </label>
      )}
      {deadline !== undefined && (
        <label>
          <span>{message("builtin.deadline")}</span>
          <Input
            type="date"
            aria-label={message("builtin.deadlineLabel")}
            value={deadline}
            disabled={readonly}
            onChange={(event) => event.target.value && void set("builtin.deadline", { type: "date", value: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}
