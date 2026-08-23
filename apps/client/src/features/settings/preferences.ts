// Live reads of the browser-local presentation preferences.
//
// `entities/settings` owns the blob and publishes changes; these hooks are the
// React side of that store, so a preference edited in the dialog reaches the
// outline in the same commit the dialog updates in — no reload, no prop drilling
// through the shell.
//
// A tone preference names a *step*, never a colour: a surface receives the
// chosen tone's name as `data-palette` and `app.css` § The tone map decides what
// that name looks like in each mode, which is what keeps the preference inside
// the committed palette and its contrast table. The one preference that does name
// a colour is the accent's hue, and `ui/theme.ts` owns it — see § The accent is a
// hue for why that one is safe (DESIGN.md § Colour).

import { useSyncExternalStore } from "react";
import { defaultQueries, type DefaultQuery } from "../../entities/default-queries";
import {
  appSettings,
  dueTiers,
  editorKeymap,
  subscribeAppSettings,
  type DueTierSettings,
  type EditorKeymap,
} from "../../entities/settings";
import { configuredTimezone } from "../../entities/journal";

export function useConfiguredTimezone(): string {
  return useSyncExternalStore(
    subscribeAppSettings,
    configuredTimezone,
    configuredTimezone,
  );
}

export function useEditorKeymap(): EditorKeymap {
  return useSyncExternalStore(subscribeAppSettings, editorKeymap, editorKeymap);
}

/**
 * `dueTiers()` repairs a stored record into a fresh object, so it is not a
 * usable `getSnapshot` on its own — React would see a new value on every call
 * and re-render forever. The settings blob is frozen and identity-stable until
 * the next write, so one memo keyed on that identity is enough.
 */
let tiersCacheKey: object | null = null;
let tiersCache: DueTierSettings | null = null;

function dueTiersSnapshot(): DueTierSettings {
  const key = appSettings();
  if (tiersCacheKey !== key || !tiersCache) {
    tiersCacheKey = key;
    tiersCache = dueTiers();
  }
  return tiersCache;
}

export function useDueTiers(): DueTierSettings {
  return useSyncExternalStore(subscribeAppSettings, dueTiersSnapshot, dueTiersSnapshot);
}

/**
 * The standing journal questions, memoized the same way and for the same reason:
 * the list is rebuilt from the stored blob on every read — repaired, bounded,
 * and freshly allocated — so only the blob's own identity may key it.
 */
let queriesCacheKey: object | null = null;
let queriesCache: DefaultQuery[] | null = null;

function defaultQueriesSnapshot(): DefaultQuery[] {
  const key = appSettings();
  if (queriesCacheKey !== key || !queriesCache) {
    queriesCacheKey = key;
    queriesCache = defaultQueries();
  }
  return queriesCache;
}

export function useDefaultQueries(): DefaultQuery[] {
  return useSyncExternalStore(
    subscribeAppSettings,
    defaultQueriesSnapshot,
    defaultQueriesSnapshot,
  );
}
