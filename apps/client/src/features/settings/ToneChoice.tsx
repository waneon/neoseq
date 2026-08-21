// The one control in the product for choosing a colour from the palette.
//
// It used to be two: a row of swatches for the outline thread and a `MenuSelect`
// for each of the four due tones. The dropdown was the wrong shape for the job in
// the most literal way — it asked the reader to pick a colour by reading the word
// for it, one at a time, with the colours themselves out of sight behind a
// trigger. Nobody chooses a colour that way. Every choice here is now a swatch of
// the colour it sets, all of them on screen at once, one press each.
//
// What a swatch *shows* is per-surface, because DESIGN.md § Settings asks every
// appearance choice to preview itself at the size it will render: the thread's
// swatches draw indent threads at the outline's own spacing and weight, and a
// tone whose row already carries a live chip beside it needs only the colour.
//
// The stored value is still a tone *name* — `app.css` § The tone map decides what
// each name looks like in each mode, so no choice here can leave the committed
// palette or its contrast table. The palette's `accent` step follows the reader's
// own accent hue, which is where the freedom to pick an arbitrary colour lives
// (§ The accent is a hue).

import { TONE_NAMES, type ToneName } from "../../entities/settings";
import { useI18n, type MessageKey } from "../../i18n";

const TONE_MESSAGE = {
  neutral: "tone.neutral",
  accent: "tone.accent",
  ok: "tone.ok",
  attention: "tone.attention",
  danger: "tone.danger",
} as const satisfies Record<ToneName, MessageKey>;

export function toneLabelKey(tone: ToneName): MessageKey {
  return TONE_MESSAGE[tone];
}

export function ToneChoice({
  value,
  onChange,
  label,
  labelledBy,
  variant,
  testId,
  showName = false,
}: {
  value: ToneName;
  onChange: (tone: ToneName) => void;
  /** The group's accessible name. Give this or `labelledBy`, never neither. */
  label?: string;
  labelledBy?: string;
  /** `thread` previews indent lines; `dot` previews the colour alone. */
  variant: "thread" | "dot";
  testId?: string;
  /** Names the chosen step in words beside the row. */
  showName?: boolean;
}) {
  const { message } = useI18n();
  return (
    <div
      className="tone-choice"
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      data-variant={variant}
      data-testid={testId}
    >
      {TONE_NAMES.map((option) => {
        const name = message(TONE_MESSAGE[option]);
        return (
          <button
            key={option}
            type="button"
            className="tone-swatch"
            data-palette={option}
            aria-pressed={value === option}
            aria-label={name}
            title={name}
            onClick={() => onChange(option)}
          >
            <span
              className={variant === "thread" ? "tone-swatch-thread" : "tone-swatch-dot"}
              aria-hidden
            />
          </button>
        );
      })}
      {/* Five labelled buttons would be a row of words with a hairline in each.
          The name of the one that is chosen is the only label the row needs —
          each swatch still carries its own name for the pointer and the screen
          reader. */}
      {showName && <span className="tone-choice-name">{message(TONE_MESSAGE[value])}</span>}
    </div>
  );
}
