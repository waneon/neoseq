// A compact colour studio for one due tier.
//
// The row keeps one colour well rather than repeating the whole palette five
// times. Pressing it opens the object being edited: the live chip in light and
// dark, a continuous hue rail, a bounded chroma rail, and the named safe presets.
// The picker stores OKLCH hue and chroma; lightness remains a mode token in CSS,
// so a freely chosen colour cannot make one mode inherit the other's contrast.

import { CheckIcon, RotateCcwIcon, SlidersHorizontalIcon } from "lucide-react";
import { useId, type CSSProperties } from "react";
import {
  customTone,
  MAX_CUSTOM_TONE_CHROMA,
  MIN_CUSTOM_TONE_CHROMA,
  TONE_NAMES,
  TONE_PRESETS,
  type ToneName,
  type ToneValue,
} from "../../entities/settings";
import type { DueTier } from "../../entities/tasks";
import { useI18n, type MessageKey } from "../../i18n";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "../../ui/shadcn/popover";
import { tonePresentation } from "../tasks/tone-presentation";

const TONE_MESSAGE = {
  neutral: "tone.neutral",
  info: "tone.info",
  ok: "tone.ok",
  caution: "tone.caution",
  attention: "tone.attention",
  danger: "tone.danger",
} as const satisfies Record<ToneName, MessageKey>;

export function ToneChoice({
  value,
  defaultValue,
  onChange,
  label,
  previewLabel,
  tier,
  testId,
}: {
  value: ToneValue;
  defaultValue: ToneValue;
  onChange: (tone: ToneValue) => void;
  label: string;
  previewLabel: string;
  tier: DueTier;
  testId?: string;
}) {
  const { message } = useI18n();
  const inputId = useId();
  const position = customTone(value);
  const intensity = Math.round(
    ((position.chroma - MIN_CUSTOM_TONE_CHROMA) /
      (MAX_CUSTOM_TONE_CHROMA - MIN_CUSTOM_TONE_CHROMA)) *
      100,
  );
  const custom = (patch: Partial<typeof position>) => onChange({ ...position, ...patch });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="color-studio-trigger"
          aria-label={label}
          title={label}
          data-testid={testId}
        >
          <span className="color-studio-well" {...tonePresentation(value)} />
          <SlidersHorizontalIcon aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          className="color-studio-popover enter-fade-fast"
          align="end"
          sideOffset={8}
          aria-label={label}
          data-testid={testId ? `${testId}-picker` : undefined}
        >
          <div className="color-studio-head">
            <strong>{label}</strong>
            <button
              type="button"
              className="color-studio-reset"
              onClick={() => onChange(defaultValue)}
            >
              <RotateCcwIcon aria-hidden />
              {message("settings.restoreDefaults")}
            </button>
          </div>

          <div className="color-studio-previews">
            {(["light", "dark"] as const).map((mode) => (
              <div className="color-studio-preview" data-mode={mode} key={mode}>
                <span
                  className="task-chip"
                  data-preview
                  data-due={tier}
                  {...tonePresentation(value)}
                >
                  <span className="task-chip-value">{previewLabel}</span>
                </span>
                <small>{message(mode === "light" ? "theme.light" : "theme.dark")}</small>
              </div>
            ))}
          </div>

          <div className="color-studio-slider">
            <label htmlFor={`${inputId}-hue`}>{message("settings.colorHue")}</label>
            <output>{Math.round(position.hue)}°</output>
            <input
              id={`${inputId}-hue`}
              type="range"
              min={0}
              max={359}
              step={1}
              value={position.hue}
              aria-label={message("settings.colorHue")}
              data-testid={testId ? `${testId}-hue` : undefined}
              className="color-studio-hue"
              style={previewStyle(value)}
              onChange={(event) => custom({ hue: Number(event.target.value) })}
            />
          </div>

          <div className="color-studio-slider">
            <label htmlFor={`${inputId}-intensity`}>{message("settings.colorIntensity")}</label>
            <output>{intensity}%</output>
            <input
              id={`${inputId}-intensity`}
              type="range"
              min={MIN_CUSTOM_TONE_CHROMA}
              max={MAX_CUSTOM_TONE_CHROMA}
              step={0.005}
              value={position.chroma}
              aria-label={message("settings.colorIntensity")}
              data-testid={testId ? `${testId}-intensity` : undefined}
              className="color-studio-chroma"
              style={previewStyle(value)}
              onChange={(event) => custom({ chroma: Number(event.target.value) })}
            />
          </div>

          <div className="color-studio-presets">
            <span>{message("settings.colorPresets")}</span>
            <div className="color-choice" data-kind="tone" role="group">
              {TONE_NAMES.map((option) => {
                const name = message(TONE_MESSAGE[option]);
                return (
                  <button
                    key={option}
                    type="button"
                    className="color-swatch"
                    data-palette={option}
                    aria-pressed={samePreset(value, option)}
                    aria-label={name}
                    title={name}
                    onClick={() => onChange(option)}
                  >
                    <CheckIcon aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}

function samePreset(value: ToneValue, preset: ToneName): boolean {
  if (typeof value === "string") return value === preset;
  const expected = TONE_PRESETS[preset];
  return (
    Math.abs(value.hue - expected.hue) < 0.5 && Math.abs(value.chroma - expected.chroma) < 0.001
  );
}

/** Preview through the mode-owned lightness even while the value is a preset. */
function previewStyle(value: ToneValue): CSSProperties {
  const tone = customTone(value);
  return {
    "--tone": `oklch(var(--custom-tone-l) ${tone.chroma} ${tone.hue})`,
    "--picker-hue": tone.hue,
    "--picker-chroma": tone.chroma,
    "--picker-lightness": "var(--custom-tone-l)",
  } as CSSProperties;
}
