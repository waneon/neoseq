import type { CSSProperties } from "react";
import { customToneCss, type ToneName, type ToneValue } from "../../entities/settings";

/** The two presentation channels a persisted tone may use. */
export function tonePresentation(value: ToneValue): {
  "data-palette"?: ToneName;
  style?: CSSProperties;
} {
  if (typeof value === "string") return { "data-palette": value };
  return {
    style: { "--tone": customToneCss(value) } as CSSProperties,
  };
}
