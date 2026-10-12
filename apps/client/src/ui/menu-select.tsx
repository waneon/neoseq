// The one select.
//
// Every closed set of choices in the product is a select: a field-like trigger
// followed by one listbox. Before this, one screen — the property add row —
// carried three different choice models side by side:
//
//   * a native `<select>`, whose menu the operating system draws, in the operating
//     system's palette, metrics and corner radius, which no rule in `app.css` can
//     reach;
//   * a `<datalist>` on a text input, whose menu the *browser* draws, in a third
//     style again, and which Safari and Firefox each interpret differently;
//   * a menu, whose command semantics did not describe field selection.
//
// Two adjacent controls that look identical at rest and then open two completely
// unrelated objects is the single most disorienting thing a form can do, and it
// was doing it in the place where a user is most likely to be a beginner.
//
// The trade is named in designs/interaction.md § Choice: a native `<select>`
// brings the platform picker and mobile wheel for free. Radix Select gives back
// type-ahead, roving focus, portalling, dismissal and `option` semantics; the
// mobile wheel it does not. One consistent surface for product choices was
// judged worth that.
//
// The trigger keeps the shape of a field, because it is standing in for one. Only
// the popup changed.

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./shadcn/select";

export interface MenuSelectOption {
  value: string;
  label: string;
}

export function MenuSelect({
  value,
  options,
  onValueChange,
  label,
  placeholder,
  disabled = false,
  className,
  testId,
}: {
  value: string;
  options: readonly MenuSelectOption[];
  onValueChange: (value: string) => void;
  /** The accessible name. Required: this control never renders its own label. */
  label: string;
  /** Shown when `value` matches no option — a choice not yet made. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const text = selected?.label ?? placeholder ?? "";

  return (
    <Select value={selected?.value ?? ""} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={className} aria-label={label} data-testid={testId}>
        <SelectValue placeholder={text} />
      </SelectTrigger>
      <SelectContent align="start" aria-label={label}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
