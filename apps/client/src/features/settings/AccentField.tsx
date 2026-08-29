// The accent, which is the one colour in Neoseq the reader actually owns.
//
// Everything the interface does with colour goes through `--accent`: the caret,
// the selection ribbon, the branch through the outline, the current rail row, a
// primary button, a focus halo, a tag. So there is exactly one coordinate to
// choose here, and choosing it changes all of them at once.
//
// What is stored is a *hue*, and only a hue. `app.css` owns the accent's lightness
// and chroma in each mode, so every angle lands on the measured row of the
// contrast table in both modes (designs/foundations.md § Semantic Color) — the reader cannot pick an
// illegible accent, so nothing here has to warn them about one. That is also why
// this is not an `input type="color"`: a free RGB picker offers millions of colours
// of which most fail AA in one mode or the other, and then either ships an
// inaccessible interface or spends a validation message refusing a choice.
//
// The eight named steps are the immediate answers, visible without opening
// anything. A separate custom action opens the continuous rail for readers who
// want to move between them without exposing unsafe RGB coordinates. The picker
// previews the actual strong accent in both modes; CSS still supplies the two
// measured lightness/chroma pairs, so every position remains legible.

import { useId, useState, type CSSProperties } from "react";
import { CheckIcon, RotateCcwIcon, SlidersHorizontalIcon } from "lucide-react";
import { useI18n, type MessageKey } from "../../i18n";
import { DEFAULT_ACCENT_HUE, normalizeHue, setAccentHue, storedAccentHue } from "../../ui/theme";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "../../ui/shadcn/popover";

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
  const inputId = useId();
  const [hue, setHue] = useState(storedAccentHue);
  const custom = !ACCENT_STEPS.some((step) => step.hue === hue);

  const apply = (next: number) => {
    const angle = normalizeHue(next);
    setAccentHue(angle);
    setHue(angle);
  };

  return (
    <div className="settings-field">
      <h3>{message("settings.accent")}</h3>
      <p>{message("settings.accentDescription")}</p>
      <div className="accent-color-controls" data-testid="settings-accent">
        <div
          className="color-choice"
          data-kind="hue"
          role="group"
          aria-label={message("settings.colorPresets")}
        >
          {ACCENT_STEPS.map((step) => (
            <button
              key={step.hue}
              type="button"
              className="color-swatch"
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

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="accent-custom-trigger"
              aria-pressed={custom}
              aria-label={message("settings.customColor")}
              title={message("settings.customColor")}
              data-testid="settings-accent-custom"
              style={accentStyle(hue)}
            >
              <span className="accent-custom-well" aria-hidden />
              <SlidersHorizontalIcon aria-hidden />
              <span>{message("settings.customColor")}</span>
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              className="color-studio-popover enter-fade-fast"
              align="start"
              collisionPadding={12}
              sideOffset={8}
              aria-label={message("settings.customColor")}
              data-testid="settings-accent-picker"
              style={accentStyle(hue)}
            >
              <div className="color-studio-head">
                <strong>{message("settings.customColor")}</strong>
                <button
                  type="button"
                  className="color-studio-reset"
                  onClick={() => apply(DEFAULT_ACCENT_HUE)}
                >
                  <RotateCcwIcon aria-hidden />
                  {message("settings.restoreDefaults")}
                </button>
              </div>

              <div className="color-studio-previews">
                {(["light", "dark"] as const).map((mode) => (
                  <div
                    className="color-studio-preview accent-color-preview"
                    data-mode={mode}
                    key={mode}
                  >
                    <span className="accent-color-sample">
                      <span aria-hidden />
                      {message("settings.accent")}
                    </span>
                    <small>{message(mode === "light" ? "theme.light" : "theme.dark")}</small>
                  </div>
                ))}
              </div>

              <div className="color-studio-slider">
                <label htmlFor={`${inputId}-hue`}>{message("settings.colorHue")}</label>
                <output>{hue}°</output>
                <input
                  id={`${inputId}-hue`}
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={hue}
                  aria-label={message("settings.colorHue")}
                  data-testid="settings-accent-hue"
                  className="color-studio-hue"
                  style={accentStyle(hue)}
                  onChange={(event) => apply(Number(event.target.value))}
                />
              </div>
            </PopoverContent>
          </PopoverPortal>
        </Popover>
      </div>
    </div>
  );
}

function accentStyle(hue: number): CSSProperties {
  return {
    "--accent-h": hue,
    "--tone": `oklch(var(--accent-l) var(--accent-c) ${hue})`,
    "--picker-hue": hue,
    "--picker-lightness": "var(--accent-l)",
  } as CSSProperties;
}
