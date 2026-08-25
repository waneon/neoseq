// The accent, which is the one colour in Neoseq the reader actually owns.
//
// Everything the interface does with colour goes through `--accent`: the caret,
// the selection ribbon, the branch through the outline, the current rail row, a
// primary button, a focus halo, a tag. So there is exactly one thing to choose
// here, and choosing it changes all of them at once — which is why this control
// has no preview strip of its own. The dialog is a panel over the product, and the
// product behind it is the preview: the settings rail's current row, this pane's
// own tint and the pressed swatch's tick all move the moment the hue does.
//
// What is stored is a *hue*, and only a hue. `app.css` owns the accent's lightness
// and chroma in each mode, so every angle lands on the measured row of the
// contrast table in both modes (designs/foundations.md § Semantic Color) — the reader cannot pick an
// illegible accent, so nothing here has to warn them about one. That is also why
// this is not an `input type="color"`: a free RGB picker offers millions of colours
// of which most fail AA in one mode or the other, and then either ships an
// inaccessible interface or spends a validation message refusing a choice.
//
// Eight named steps, and nothing else. A continuous hue rail sat under them for a
// while and it was the wrong instrument: the accent is not a quantity anybody
// tunes, it is one of a handful of answers, and a slider invites a precision that
// means nothing here — 214° is not a better answer than "Blue", it is the same
// answer with a decision left dangling. The steps are the whole control now, in
// the same swatch language every colour choice in the product uses, painted from
// `--accent-l` and `--accent-c` so they show the colours actually on offer in the
// current mode and repaint themselves in dark mode for free. A hue stored from
// before still renders — nothing about the token changed, only what offers it.

import { useState, type CSSProperties } from "react";
import { CheckIcon } from "lucide-react";
import { useI18n, type MessageKey } from "../../i18n";
import {
  DEFAULT_ACCENT_HUE,
  normalizeHue,
  setAccentHue,
  storedAccentHue,
} from "../../ui/theme";

/** Eight steps around the circle, named, with iris where it has always been. */
const ACCENT_STEPS = [
  { hue: 15, label: "accent.red" },
  { hue: 55, label: "accent.orange" },
  { hue: 145, label: "accent.green" },
  { hue: 195, label: "accent.teal" },
  { hue: 240, label: "accent.blue" },
  { hue: DEFAULT_ACCENT_HUE, label: "accent.iris" },
  { hue: 310, label: "accent.violet" },
  { hue: 345, label: "accent.rose" },
] as const satisfies readonly { hue: number; label: MessageKey }[];

export function AccentField() {
  const { message } = useI18n();
  const [hue, setHue] = useState(storedAccentHue);

  const apply = (next: number) => {
    const angle = normalizeHue(next);
    setAccentHue(angle);
    setHue(angle);
  };

  return (
    <div className="settings-field">
      <h3>{message("settings.accent")}</h3>
      <p>{message("settings.accentDescription")}</p>
      <div
        className="color-choice"
        data-kind="hue"
        role="group"
        aria-label={message("settings.accent")}
        data-testid="settings-accent"
      >
        {ACCENT_STEPS.map((step) => (
          <button
            key={step.hue}
            type="button"
            className="color-swatch"
            // The swatch is the accent it sets, built from the same lightness
            // and chroma the token is, so it cannot drift from the result.
            style={{ "--accent-h": step.hue } as CSSProperties}
            aria-pressed={hue === step.hue}
            aria-label={message(step.label)}
            title={message(step.label)}
            data-testid={`accent-step-${step.hue}`}
            onClick={() => apply(step.hue)}
          >
            <CheckIcon aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
