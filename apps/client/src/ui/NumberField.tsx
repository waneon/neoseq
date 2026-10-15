import { useState, type ComponentProps } from "react";
import { Input } from "./shadcn/input";

/**
 * A number typed as text. Partial input such as "", "-" or "1." stays on
 * screen; only a value `valid` takes reaches `onValue`, and leaving the field
 * shows the last accepted value again.
 */
export function NumberField({
  value,
  onValue,
  valid = Number.isFinite,
  onBlur,
  ...props
}: Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: number;
  onValue: (value: number) => void;
  valid?: (value: number) => boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      {...props}
      type="number"
      value={draft ?? String(value)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const next = Number(text);
        if (text.trim() !== "" && valid(next)) onValue(next);
      }}
      onBlur={(event) => {
        setDraft(null);
        onBlur?.(event);
      }}
    />
  );
}
