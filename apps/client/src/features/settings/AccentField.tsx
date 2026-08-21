// The accent, which is the one colour in Neoseq the reader actually owns.
//
// Everything the interface does with colour goes through `--accent`: the caret,
// the selection ribbon, the lit thread, the current rail row, a primary button, a
// focus halo, a tag reference. So there is exactly one thing to choose here, and
// choosing it changes all of them at once — which is why this control has no
// preview strip of its own. The dialog is a panel over the product, and the
// product behind it is the preview: the settings rail's current row, this pane's
// own tint and the pressed swatch's ring all move the moment the hue does.
//
// What is chosen is a *hue*, and only a hue. `app.css` owns the accent's
// lightness and chroma in each mode, so every angle on this strip lands on the
// measured row of the contrast table in both modes (§ The accent is a hue) — the
// reader cannot pick an illegible accent, so nothing here has to warn them about
// one. That is the whole reason this is a hue strip rather than an `input
// type="color"`: a free RGB picker offers millions of colours of which most fail
// AA in one mode or the other, and then either ships an inaccessible interface or
// spends a validation message telling the reader their colour was refused.
//
// The strip is painted from the accent's own lightness and chroma, so it shows
// the colours actually on offer rather than a generic rainbow, and it repaints
// itself in dark mode because those two numbers are per-mode tokens.

import { useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import {
  DEFAULT_ACCENT_HUE,
  normalizeHue,
  setAccentHue,
  storedAccentHue,
} from "../../ui/theme";

/**
 * Eight steps around the circle, named, with iris where it has always been. The
 * strip beside them reaches every angle between; these are the ones worth a
 * single press, and they double as the legend that says what the strip contains.
 */
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
      <div className="accent-choice" data-testid="settings-accent">
        <div className="accent-steps" role="group" aria-label={message("settings.accent")}>
          {ACCENT_STEPS.map((step) => (
            <button
              key={step.hue}
              type="button"
              className="accent-swatch"
              // The swatch is the accent it sets, built from the same lightness
              // and chroma the token is, so it cannot drift from the result.
              style={{ "--accent-h": step.hue } as React.CSSProperties}
              aria-pressed={hue === step.hue}
              aria-label={message(step.label)}
              title={message(step.label)}
              data-testid={`accent-step-${step.hue}`}
              onClick={() => apply(step.hue)}
            />
          ))}
        </div>
        {/* Native, because a hue is a continuous scalar and the platform's range
            is better at one than anything this design system would rebuild:
            arrow keys, Home/End, Page keys and touch dragging all arrive for
            free (§ Choice — native stays where the platform is better). */}
        <input
          className="accent-strip"
          type="range"
          min={0}
          max={359}
          step={1}
          value={hue}
          aria-label={message("settings.accentHue")}
          aria-valuetext={message("settings.accentHueValue", { hue })}
          data-testid="accent-hue"
          onChange={(event) => apply(Number(event.target.value))}
        />
      </div>
    </div>
  );
}
