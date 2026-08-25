// The one dropdown.
//
// Every list of choices in the product opens the same surface: the menu a
// right-click on a bullet opens. Before this, one screen — the property add row —
// carried three different popups side by side:
//
//   * a native `<select>`, whose menu the operating system draws, in the operating
//     system's palette, metrics and corner radius, which no rule in `app.css` can
//     reach;
//   * a `<datalist>` on a text input, whose menu the *browser* draws, in a third
//     style again, and which Safari and Firefox each interpret differently;
//   * the Radix menu, which is the one this design system actually specifies.
//
// Two adjacent controls that look identical at rest and then open two completely
// unrelated objects is the single most disorienting thing a form can do, and it
// was doing it in the place where a user is most likely to be a beginner.
//
// The trade is named in designs/interaction.md § Choice: a native `<select>`
// brings the platform picker, the mobile wheel and type-ahead for free. Radix
// gives back type-ahead, roving focus, portalling, dismissal and `menuitemradio`
// semantics; the mobile wheel it does not. One consistent surface for every choice
// in the product was judged worth that.
//
// The trigger keeps the shape of a field, because it is standing in for one. Only
// the popup changed.

import { ChevronDownIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu";
import { cn } from "@/lib/utils";

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
    // Not modal: a list of choices is not a modal surface, and treating it as one
    // takes pointer events away from the whole document and locks the page's
    // scroll for what is functionally a `<select>`. Radix still dismisses it on an
    // outside press, on `⎋`, and on choosing.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn("menu-select", className)}
          // The value is the button's own text, so the name has to be explicit —
          // and it is what a screen reader reads before the value, exactly as it
          // would for the `<select>` this replaces.
          aria-label={label}
          data-placeholder={selected ? undefined : "true"}
          data-testid={testId}
          disabled={disabled}
        >
          <span className="value">{text}</span>
          <ChevronDownIcon aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="menu-select-menu"
        // Matching the trigger's width keeps a long option list from opening as a
        // panel narrower than the control that summoned it, which reads as a
        // different object rather than as that control's contents.
        style={{ minWidth: "var(--radix-dropdown-menu-trigger-width)" }}
        aria-label={label}
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
