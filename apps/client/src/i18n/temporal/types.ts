import type {
  ResolvedMoment,
  TemporalContext,
  TemporalDateIntent,
  TemporalMomentIntent,
} from "../../entities/temporal";
import type { SupportedLocale } from "../generated/messages";

export type TemporalRecognition<T> =
  | { readonly kind: "match"; readonly value: T }
  | { readonly kind: "ambiguous"; readonly candidates: readonly T[] }
  | { readonly kind: "none" };

export const NO_TEMPORAL_MATCH = { kind: "none" } as const;

export function temporalMatch<T>(value: T): TemporalRecognition<T> {
  return { kind: "match", value };
}

export function mapTemporalRecognition<T, U>(
  recognition: TemporalRecognition<T>,
  map: (value: T) => U,
): TemporalRecognition<U> {
  switch (recognition.kind) {
    case "match":
      return temporalMatch(map(recognition.value));
    case "ambiguous":
      return { kind: "ambiguous", candidates: recognition.candidates.map(map) };
    case "none":
      return NO_TEMPORAL_MATCH;
  }
}

export interface TemporalLanguagePack {
  readonly support: "full" | "basic";
  readonly examples: {
    readonly dates: readonly string[];
    readonly moments: readonly string[];
  };
  recognizeDate(input: string): TemporalRecognition<TemporalDateIntent>;
  recognizeMoment(input: string): TemporalRecognition<TemporalMomentIntent>;
}

export interface TemporalParser {
  readonly locale: SupportedLocale;
  readonly support: TemporalLanguagePack["support"];
  readonly examples: TemporalLanguagePack["examples"];
  parseDate(input: string, context: TemporalContext): TemporalRecognition<string>;
  parseMoment(input: string, context: TemporalContext): TemporalRecognition<ResolvedMoment>;
}
