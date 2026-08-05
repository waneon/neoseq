import type { BlockSnapshot, PropertyValue } from "../../core-port/snapshot";
import { dateValue, stringValue } from "../../core-port/snapshot";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect } from "@/ui/shadcn/native-select";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

const STATUSES = ["todo", "doing", "done"];
const PRIORITIES = ["low", "medium", "high"];

export function TaskProjection({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const { message } = useI18n();
  const session = useSession();
  const state = useSessionState();
  const status = stringValue(block.properties, "task.status");
  const priority = stringValue(block.properties, "task.priority");
  const scheduled = dateValue(block.properties, "task.scheduled");
  const deadline = dateValue(block.properties, "task.deadline");
  const isTask = block.properties.some((entry) => entry.key.startsWith("task."));
  if (!isTask) return null;

  const set = (key: string, value: PropertyValue) =>
    session.execute({
      type: "set_property",
      entity: { kind: "block", page_id: pageId, id: block.id },
      key,
      value,
    });
  const readonly = state.mode === "readonly";

  return (
    <div
      className="task-projection"
      aria-label={message("task.section")}
      data-testid="task-projection"
    >
      <label>
        <span>{message("task.status")}</span>
        <NativeSelect
          aria-label={message("task.statusLabel")}
          value={status ?? ""}
          disabled={readonly}
          onChange={(event) => void set("task.status", { type: "string", value: event.target.value })}
        >
          {status === undefined && <option value="">{message("task.unset")}</option>}
          {status && !STATUSES.includes(status) && <option value={status}>{status}</option>}
          {STATUSES.map((item) => (
            <option key={item} value={item}>
              {message(`task.status.${item}` as
                | "task.status.todo"
                | "task.status.doing"
                | "task.status.done")}
            </option>
          ))}
        </NativeSelect>
      </label>
      {(priority !== undefined || status !== undefined) && (
        <label>
          <span>{message("task.priority")}</span>
          <NativeSelect
            aria-label={message("task.priorityLabel")}
            value={priority ?? ""}
            disabled={readonly}
            onChange={(event) => void set("task.priority", { type: "string", value: event.target.value })}
          >
            {priority === undefined && <option value="">{message("task.unset")}</option>}
            {priority && !PRIORITIES.includes(priority) && <option value={priority}>{priority}</option>}
            {PRIORITIES.map((item) => (
              <option key={item} value={item}>
                {message(`task.priority.${item}` as
                  | "task.priority.low"
                  | "task.priority.medium"
                  | "task.priority.high")}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      {scheduled !== undefined && (
        <label>
          <span>{message("task.scheduled")}</span>
          <Input
            type="date"
            aria-label={message("task.scheduledLabel")}
            value={scheduled}
            disabled={readonly}
            onChange={(event) => event.target.value && void set("task.scheduled", { type: "date", value: event.target.value })}
          />
        </label>
      )}
      {deadline !== undefined && (
        <label>
          <span>{message("task.deadline")}</span>
          <Input
            type="date"
            aria-label={message("task.deadlineLabel")}
            value={deadline}
            disabled={readonly}
            onChange={(event) => event.target.value && void set("task.deadline", { type: "date", value: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}
