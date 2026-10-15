import { useEffect, useRef } from "react";
import type { Command } from "../../core-port/commands";
import { scheduleActivity, type ScheduledActivity } from "../../lib/activity";
import { useLatest } from "../../lib/react";
import { useSession } from "./session-context";

/**
 * Writes `command` after a pause in editing. A newer command for the same `key`
 * replaces it; one for another key, or leaving, writes it at once; a page that
 * goes away keeps it to replay. `null` means nothing is waiting. The command
 * must state a final value, because a kept one may apply twice.
 */
export function useDeferredCommand(
  command: Command | null,
  key: string,
  onError: (error: unknown) => void,
  delay = 600,
): void {
  const session = useSession();
  const waiting = useRef<{ key: string; command: Command; save: ScheduledActivity } | null>(null);
  const report = useLatest(onError);
  const encoded = command ? JSON.stringify(command) : null;

  useEffect(() => {
    const previous = waiting.current;
    waiting.current = null;
    if (previous?.key === key) previous.save.cancel();
    else previous?.save.flush();
    if (!encoded) return;
    const next = JSON.parse(encoded) as Command;
    const entry = {
      key,
      command: next,
      save: scheduleActivity(
        () =>
          session
            .execute(next)
            .catch((error: unknown) => report.current(error))
            // Kept until written: a page closed mid-write replays it.
            .finally(() => {
              if (waiting.current === entry) waiting.current = null;
            }),
        delay,
      ),
    };
    waiting.current = entry;
  }, [delay, encoded, key, report, session]);

  useEffect(() => () => waiting.current?.save.flush(), []);

  useEffect(
    () =>
      session.preserveUnsaved(() =>
        waiting.current ? [{ kind: "command", command: waiting.current.command }] : [],
      ),
    [session],
  );
}
