import { useRef, useState } from "react";
import { cn } from "../lib/utils";

export function EditableTitle({
  value,
  label,
  testId,
  className,
  readonly,
  validate = () => true,
  onCommit,
  onError,
}: {
  value: string;
  label: string;
  testId: string;
  className?: string;
  readonly: boolean;
  validate?: (value: string) => boolean;
  onCommit: (value: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Enter commits and then blurs. Clearing this before the request makes that
  // second event a no-op while the visible draft remains until the canonical
  // value has caught up.
  const pending = useRef<string | null>(null);

  const commit = () => {
    const raw = pending.current;
    if (raw === null) return;
    pending.current = null;
    const next = raw.trim();
    if (!next || next === value || !validate(next)) {
      setDraft(null);
      return;
    }

    setDraft(next);
    // Release only the draft this request wrote. Typing again while it is in
    // flight creates a newer draft that the older acknowledgement cannot erase.
    const release = () => setDraft((current) => (current === next ? null : current));
    let request: Promise<void>;
    try {
      request = onCommit(next);
    } catch (error: unknown) {
      release();
      onError(error);
      return;
    }
    void request.then(release).catch((error: unknown) => {
      release();
      onError(error);
    });
  };

  const resize = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "0";
    element.style.height = `${element.scrollHeight}px`;
  };

  return (
    <div className={cn("page-title-field", className)}>
      <textarea
        ref={resize}
        rows={1}
        className="page-title"
        value={draft ?? value}
        aria-label={label}
        data-testid={testId}
        readOnly={readonly}
        onChange={(event) => {
          // An entity name has no lines, so a pasted newline is a space.
          const next = event.target.value.replace(/[\r\n]+/g, " ");
          pending.current = next;
          setDraft(next);
          resize(event.currentTarget);
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
            pending.current = null;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
