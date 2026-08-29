import {
  resolveDateIntent,
  resolveMomentIntent,
  type TemporalContext,
} from "../../entities/temporal";
import { LOCALE_DEFINITIONS, type SupportedLocale } from "../generated/messages";
import { normalizeTemporalInput, recognizeInvariantDate, recognizeInvariantMoment } from "./shared";
import {
  NO_TEMPORAL_MATCH,
  mapTemporalRecognition,
  type TemporalLanguagePack,
  type TemporalParser,
  type TemporalRecognition,
} from "./types";

const languageModules = import.meta.glob("./languages/*.ts", {
  eager: true,
  import: "default",
}) as Record<string, TemporalLanguagePack>;

function resolveRecognition<T, U>(
  recognition: TemporalRecognition<T>,
  resolve: (value: T) => U | null,
): TemporalRecognition<U> {
  if (recognition.kind === "none") return NO_TEMPORAL_MATCH;
  if (recognition.kind === "match") {
    const value = resolve(recognition.value);
    return value === null ? NO_TEMPORAL_MATCH : { kind: "match", value };
  }
  const unique = new Map<string, U>();
  for (const candidate of recognition.candidates) {
    const value = resolve(candidate);
    if (value !== null) unique.set(JSON.stringify(value), value);
  }
  const candidates = [...unique.values()];
  if (candidates.length === 0) return NO_TEMPORAL_MATCH;
  if (candidates.length === 1) return { kind: "match", value: candidates[0] };
  return { kind: "ambiguous", candidates };
}

export function createTemporalParser(locale: SupportedLocale): TemporalParser {
  const definition = LOCALE_DEFINITIONS.find((candidate) => candidate.tag === locale);
  if (!definition) throw new Error(`unsupported locale: ${locale}`);
  const pack = languageModules[`./languages/${definition.temporal}.ts`];
  if (!pack) throw new Error(`missing temporal language pack: ${definition.temporal}`);

  const recognizeDate = (input: string) => {
    const invariant = recognizeInvariantDate(input);
    return invariant.kind === "none" ? pack.recognizeDate(input) : invariant;
  };

  return {
    locale,
    support: pack.support,
    examples: pack.examples,
    parseDate: (input, context) => {
      const normalized = normalizeTemporalInput(input, locale);
      if (!normalized) return NO_TEMPORAL_MATCH;
      return resolveRecognition(recognizeDate(normalized), (intent) =>
        resolveDateIntent(intent, context),
      );
    },
    parseMoment: (input, context: TemporalContext) => {
      const normalized = normalizeTemporalInput(input, locale);
      if (!normalized) return NO_TEMPORAL_MATCH;
      const invariant = recognizeInvariantMoment(normalized);
      const localized = invariant.kind === "none" ? pack.recognizeMoment(normalized) : invariant;
      const recognition =
        localized.kind === "none"
          ? mapTemporalRecognition(recognizeDate(normalized), (date) => ({ date }))
          : localized;
      return resolveRecognition(recognition, (intent) => resolveMomentIntent(intent, context));
    },
  };
}

export type { TemporalLanguagePack, TemporalParser, TemporalRecognition } from "./types";
