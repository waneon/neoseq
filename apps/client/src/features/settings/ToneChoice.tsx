// The one control in the product for choosing a colour from the palette.
//
// It used to be a `MenuSelect` per tier — a dropdown whose trigger hid the
// palette behind the word for it and asked the reader to pick a colour by reading
// its name, one at a time. Nobody chooses a colour that way. Every option is a
// swatch of the colour it sets, all of them on screen at once, one press each.
//
// The swatch language is shared with the accent's hue steps (`AccentField`) so
// that "pick a colour" looks like one thing wherever it appears: a filled disc at
// the control floor, a tick in `--on-tone` on the chosen one, a halo of the disc's
// own colour under the pointer. The tick is what keeps the choice from being
// carried by colour alone.
//
// The stored value is a tone *name* — app.css decides what each name looks like
// in each mode, so no choice here can leave the palette or contrast contract in
// designs/foundations.md § Semantic Color. None of the five follows the accent;
// an ordered semantic scale and the product accent have separate roles.

import { CheckIcon } from "lucide-react";
import { TONE_NAMES, type ToneName } from "../../entities/settings";
import { useI18n, type MessageKey } from "../../i18n";

const TONE_MESSAGE = {
  neutral: "tone.neutral",
  info: "tone.info",
  ok: "tone.ok",
  attention: "tone.attention",
  danger: "tone.danger",
} as const satisfies Record<ToneName, MessageKey>;

export function ToneChoice({
  value,
  onChange,
  label,
  testId,
}: {
  value: ToneName;
  onChange: (tone: ToneName) => void;
  /** The group's accessible name. */
  label: string;
  testId?: string;
}) {
  const { message } = useI18n();
  return (
    <div
      className="color-choice"
      data-kind="tone"
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {TONE_NAMES.map((option) => {
        const name = message(TONE_MESSAGE[option]);
        return (
          <button
            key={option}
            type="button"
            className="color-swatch"
            data-palette={option}
            aria-pressed={value === option}
            aria-label={name}
            title={name}
            onClick={() => onChange(option)}
          >
            <CheckIcon aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
