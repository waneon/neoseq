// The command registry contract and matcher. `catalog.tsx` owns the concrete
// application verbs; every rendered route consumes those same command objects.
//
// This exists because the interface is deliberately bare (see
// designs/shell-and-navigation.md § Disclosure and Commands). Removing a button
// is only safe when the verb it named is still reachable, so every entry carries
// BOTH a keyboard route and a `pointerRoute`
// describing how a user who never learns a shortcut gets there. `pointerRoute`
// is required by the type and asserted by a test, which is what keeps the
// palette from quietly becoming the only way to do something.

import type { ReactNode } from "react";

export type CommandGroup =
  "Search" | "Pages" | "Tags" | "Journal" | "Graph" | "Edit" | "Block" | "App";

/** Groups in the order the palette renders them: navigation before action. */
export const GROUP_ORDER: CommandGroup[] = [
  "Pages",
  "Tags",
  "Journal",
  "Search",
  "Block",
  "Edit",
  "Graph",
  "App",
];

export interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  /** Extra terms the fuzzy matcher should accept for this entry. */
  keywords?: string[];
  /**
   * Display parts of the binding, e.g. `["⌘", "⇧", "P"]`. Presentational only —
   * the parts rather than the joined string because a badge lays a modifier and
   * its key out as separate columns; see `formatBindingParts`.
   */
  binding?: readonly string[];
  /** Secondary text shown to the right of the label in the palette. */
  hint?: string;
  icon?: ReactNode;
  /** Why the command cannot run right now. Listed, never hidden. */
  disabledReason?: string | null;
  /** How a pointer-only user reaches this verb. Required — see the header. */
  pointerRoute: string;
  run(): void | Promise<void>;
}

/**
 * Subsequence match with a small score: exact substring beats a scattered
 * subsequence, and a prefix beats both. Synchronous and allocation-light because
 * it runs on every keystroke of the palette.
 *
 * Returns null when the query does not match at all.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  const at = haystack.indexOf(needle);
  if (at === 0) return 1000 - text.length;
  if (at > 0) return 700 - at - text.length / 10;

  // Scattered subsequence anchored at a word start, so "pp" finds "Project
  // plan" but "cache" does not find "Appearance: match the system".
  let index = 0;
  let score = 300;
  let previous = -1;
  for (const character of needle) {
    let found = haystack.indexOf(character, index);
    while (previous < 0 && found >= 0 && !wordStart(haystack, found)) {
      found = haystack.indexOf(character, found + 1);
    }
    if (found < 0) return null;
    if (wordStart(haystack, found)) score += 8;
    if (found === previous + 1) score += 4;
    previous = found;
    index = found + 1;
  }
  return score - text.length / 10;
}

function wordStart(text: string, at: number): boolean {
  return at === 0 || /[\s.:/·_-]/.test(text[at - 1]);
}

/** Best score across a command's label and keywords. */
export function matchCommand(command: Command, query: string): number | null {
  let best = fuzzyScore(command.label, query);
  for (const keyword of command.keywords ?? []) {
    const score = fuzzyScore(keyword, query);
    if (score !== null && (best === null || score > best)) best = score - 20;
  }
  return best;
}
