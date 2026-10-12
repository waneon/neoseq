// Syntax highlighting for code blocks, shared by reading and editing.
//
// Tokens carry CSS variables rather than colors, so the foundation's light and
// dark roles own every hue and a theme switch never re-tokenizes. The engine is
// Shiki's JavaScript one: no Wasm to fetch, and grammars arrive one chunk each.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HighlighterCore, ThemedToken } from "shiki/core";
import { codeLanguage, type CodeLanguage } from "./languages";

export type { ThemedToken };

const THEME = "neoseq";

let core: Promise<HighlighterCore> | null = null;
let instance: HighlighterCore | null = null;
/** Language id → its loaded grammar's name, or `null` when loading failed. */
const grammars = new Map<string, string | null>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

/** The highlighter and its engine load with the first named language. */
function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")])
    .then(([shiki, engine]) =>
      shiki.createHighlighterCore({
        // Weights and slants would change glyph advances under the editor's textarea.
        themes: [
          shiki.createCssVariablesTheme({
            name: THEME,
            variablePrefix: "--code-",
            fontStyle: false,
          }),
        ],
        langs: [],
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
      }),
    )
    .then((created) => (instance = created));
  return core;
}

function load(language: CodeLanguage) {
  if (grammars.has(language.id) || loading.has(language.id)) return;
  loading.add(language.id);
  void Promise.all([highlighter(), language.grammar()])
    .then(async ([created, module]) => {
      await created.loadLanguage(...module.default);
      // A module lists the grammars it embeds first and its own last.
      grammars.set(language.id, module.default.at(-1)?.name ?? null);
    })
    .catch(() => grammars.set(language.id, null))
    .finally(() => {
      loading.delete(language.id);
      revision += 1;
      for (const listener of listeners) listener();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Lines of tokens for `code` in the language a fence's info string names, or
 * `null` while its grammar loads and for languages outside the list. Callers
 * render plain text meanwhile; tokens change color only, never metrics.
 */
export function useCodeTokens(code: string, info: string): ThemedToken[][] | null {
  const language = codeLanguage(info);
  const loaded = useSyncExternalStore(subscribe, () => revision);
  useEffect(() => {
    if (language) load(language);
  }, [language]);
  return useMemo(() => {
    const grammar = language && grammars.get(language.id);
    if (!grammar || !instance) return null;
    return instance.codeToTokensBase(code, { lang: grammar, theme: THEME });
    // `loaded` is the grammar table's revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, language, loaded]);
}
