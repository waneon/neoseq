import { useEffect, useRef, useState } from "react";
import type { Command } from "../../core-port/commands";
import { ActivityHold } from "../../lib/activity";
import { useLatest } from "../../lib/react";
import { cn } from "../../lib/utils";
import { useTextAreaSize } from "../../ui/textarea-size";
import { useSession } from "./session-context";

export function EditableTitle({
  value,
  label,
  testId,
  className,
  readonly,
  autoSelect = false,
  validate = () => true,
  rename,
  onError,
}: {
  value: string;
  label: string;
  testId: string;
  className?: string;
  readonly: boolean;
  /** Focuses the title with its text selected, for a document just created. */
  autoSelect?: boolean;
  validate?: (value: string) => boolean;
  /** The command that gives the document this title. */
  rename: (value: string) => Command;
  onError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useTextAreaSize(textarea, draft ?? value, false);
  // Enter commits and then blurs. Clearing this before the request makes that
  // second event a no-op while the visible draft remains until the canonical
  // value has caught up.
  const pending = useRef<string | null>(null);
  const session = useSession();
  const [unsaved] = useState(() => new ActivityHold());
  const hold = (next: string | null) => {
    pending.current = next;
    unsaved.set(next !== null);
  };

  useEffect(() => {
    if (!autoSelect || readonly) return;
    textarea.current?.focus();
    textarea.current?.select();
  }, [autoSelect, readonly]);

  const commit = () => {
    const raw = pending.current;
    if (raw === null) return;
    hold(null);
    const next = raw.trim();
    if (!next || next === value || !validate(next)) {
      setDraft(null);
      return;
    }

    setDraft(next);
    // Release only the draft this request wrote. Typing again while it is in
    // flight creates a newer draft that the older acknowledgement cannot erase.
    const release = () => setDraft((current) => (current === next ? null : current));
    void session
      .execute(rename(next))
      .then(release)
      .catch((error: unknown) => {
        release();
        onError(error);
      });
  };

  // Leaving the document by any route keeps what was typed, and a page that
  // goes away keeps it to replay.
  const latest = useLatest({ commit, rename, value });
  useEffect(() => () => latest.current.commit(), [latest]);
  useEffect(
    () =>
      session.preserveUnsaved(() => {
        const next = pending.current?.trim();
        return next && next !== latest.current.value
          ? [{ kind: "command", command: latest.current.rename(next) }]
          : [];
      }),
    [latest, session],
  );

  return (
    <div className={cn("page-title-field", className)}>
      <textarea
        ref={textarea}
        rows={1}
        className="page-title"
        value={draft ?? value}
        aria-label={label}
        data-testid={testId}
        readOnly={readonly}
        onChange={(event) => {
          // An entity name has no lines, so a pasted newline is a space.
          const next = event.target.value.replace(/[\r\n]+/g, " ");
          hold(next);
          setDraft(next);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            hold(null);
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
