// The shapes this app composes its surfaces from.
//
// Every one of them is a composition of the roles in `app.css` and the React
// Aria primitives. None of them declares a colour, a radius, a
// duration or a focus treatment of its own: a component that reimplements a
// global interaction is an architectural violation (DESIGN.md § Implementation
// Boundary), and it is also how two dialogs end up closing differently.

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import {
  Button as AriaButton,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { DialogSurface } from "@/ui/shadcn/dialog";

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
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      className={cn("field", className)}
      selectedKey={selected?.value ?? null}
      onSelectionChange={(key) => {
        if (key !== null) onValueChange(String(key));
      }}
    >
      <Label className={hideLabel ? "sr-only" : "field-label"}>{label}</Label>
      <AriaButton className={cn("menu-select", triggerClassName)}>
        <SelectValue className="menu-select-value" />
        <ChevronDownIcon aria-hidden />
      </AriaButton>
      <Popover
        className="choice-menu enter-none z-[var(--z-menu)] min-w-[max(10rem,var(--trigger-width))] rounded-lg bg-[var(--overlay)] p-1 shadow-[var(--e2)]"
        style={{ zIndex: undefined }}
        placement="bottom start"
        offset={6}
        maxHeight={320}
      >
        <ListBox items={options} className="outline-none">
          {(option) => (
            <ListBoxItem
              id={option.value}
              textValue={option.label}
              className="choice-row relative flex min-h-[30px] cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-7 pr-2 text-sm text-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
            >
              {({ isSelected }) => (
                <>
                  <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                    {isSelected && <CheckIcon className="size-3.5 text-[var(--accent)]" />}
                  </span>
                  {option.label}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
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
 * The safe action takes initial focus.
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
    <DialogSurface
      role="alertdialog"
      title={title}
      description={description}
      dismissible={!pending}
      onClose={onCancel}
    >
      {error && <Callout>{error}</Callout>}
      <div className="dialog-actions">
        <Button variant="ghost" autoFocus disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="destructive-filled" disabled={pending} onClick={() => void confirm()}>
          {pending && <span className="spinner" aria-hidden />}
          {confirmLabel}
        </Button>
      </div>
    </DialogSurface>
  );
}
