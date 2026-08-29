// The shapes this app composes its surfaces from.
//
// Every one of them is a composition of the roles in `app.css` and the Radix
// primitives under `ui/shadcn`. None of them declares a colour, a radius, a
// duration or a focus treatment of its own: a component that reimplements a
// global interaction is an architectural violation (DESIGN.md § Implementation
// Boundary), and it is also how two dialogs end up closing differently.

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/shadcn/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/shadcn/alert-dialog";

/**
 * A labelled text field, with the rule it must satisfy stated beside it.
 *
 * `hint` is the rule, and it is permanent: a submit button that silently refuses
 * to enable is a form that knows why it is refusing and will not say. `error` is
 * what the server said about this particular value, and replaces the hint while
 * it stands.
 */
export function TextField({
  label,
  hint,
  error,
  className,
  ...props
}: ComponentProps<typeof Input> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cn("field", className)}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        aria-describedby={note ? noteId : undefined}
        aria-invalid={error ? true : undefined}
        {...props}
      />
      {note && (
        <p id={noteId} className={error ? "field-error" : "field-hint"}>
          {note}
        </p>
      )}
    </div>
  );
}

export interface ChoiceOption {
  value: string;
  label: string;
}

/**
 * A closed set of choices. Every one in this app opens the same surface — see
 * `app.css` § The one dropdown for why it is not a native `<select>`.
 */
export function ChoiceField({
  label,
  hideLabel = false,
  value,
  options,
  onValueChange,
  className,
  triggerClassName,
}: {
  label: string;
  /** For a choice whose surroundings already name it, such as a bar control. */
  hideLabel?: boolean;
  value: string;
  options: readonly ChoiceOption[];
  onValueChange: (value: string) => void;
  className?: string;
  triggerClassName?: string;
}) {
  const id = useId();
  const selected = options.find((option) => option.value === value);
  return (
    <div className={cn("field", className)}>
      <label className={hideLabel ? "sr-only" : "field-label"} htmlFor={id}>
        {label}
      </label>
      <Select value={selected?.value ?? ""} onValueChange={onValueChange}>
        <SelectTrigger id={id} className={triggerClassName} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" aria-label={label}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * An inline report, owned by the surface that raised it.
 *
 * A failure is an `alert` rather than a polite `status`: an administrative
 * action that did not happen, announced politely, may never be announced at all.
 */
export function Callout({
  tone = "danger",
  action,
  children,
}: {
  tone?: "neutral" | "danger";
  /** The one way out of the state being reported, when there is one. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={tone === "danger" ? "callout callout-danger" : "callout"}
      role={tone === "danger" ? "alert" : "status"}
    >
      {tone === "danger" && <TriangleAlertIcon aria-hidden />}
      <span>{children}</span>
      {action && <span className="callout-action">{action}</span>}
    </div>
  );
}

/**
 * A destructive or authority-reducing choice, stating its consequence before it
 * commits.
 *
 * The dialog owns the lifetime of the operation: it stays up, with its confirm
 * button pending, until the server has actually answered, and a failure is
 * reported here rather than somewhere behind the panel that asked the question.
 * The safe action takes initial focus, which is Radix's default for an alert
 * dialog's cancel.
 */
export function ConfirmDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  errorMessage,
}: {
  title: string;
  description: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  /** What to say if the operation is refused; the cause is the caller's to map. */
  errorMessage: (cause: unknown) => string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  };

  return (
    <AlertDialog open>
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!pending) onCancel();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Callout>{error}</Callout>}
        <div className="dialog-actions">
          <AlertDialogCancel asChild>
            <Button variant="ghost" disabled={pending} onClick={onCancel}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant="destructive-filled"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              {pending && <span className="spinner" aria-hidden />}
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
