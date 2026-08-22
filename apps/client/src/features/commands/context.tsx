// The bridge between the shell-level command layer and the page-level surfaces
// it needs to reach.
//
// `Mod+P` means "properties of whatever is in front of me": the most recently
// focused block target if there is one, otherwise the page. Block editors can
// be nested (a query result inside an outline row), so block targets form a
// registry stack rather than competing for one mutable slot.
//
// The page's own verbs travel the same way. Their pointer route is a right-click
// on the title row, which only PageView can offer; the palette needs to reach
// them too, and the palette lives in the shell.

import { createContext, useContext } from "react";
import type { SettingsSection } from "../settings/SettingsDialog";

export interface PageActions {
  info(): void;
  remove(): void;
}

export interface CommandBridge {
  openPalette(): void;
  openShortcuts(): void;
  /** Opens settings at a section. The section is reflected in the URL. */
  openSettings(section?: SettingsSection): void;
  /** Registers a focused block target. Removing it restores the prior target. */
  registerBlockProperties(handler: (key?: string) => void): () => void;
  /** Set by PageView for as long as a page is on screen. */
  setPageProperties(handler: ((key?: string) => void) | null): void;
  /** Set by PageView: the verbs its title-row context menu offers. */
  setPageActions(actions: PageActions | null): void;
  /**
   * Mod+P: opens the contextual target and reports whether one existed. A key
   * opens the picker already on that property — the palette's task commands
   * ride this.
   */
  requestProperties(key?: string): boolean;
  requestPageInfo(): void;
  requestPageDelete(): void;
}

const NOOP: CommandBridge = {
  openPalette: () => {},
  openShortcuts: () => {},
  openSettings: () => {},
  registerBlockProperties: () => () => {},
  setPageProperties: () => {},
  setPageActions: () => {},
  requestProperties: () => false,
  requestPageInfo: () => {},
  requestPageDelete: () => {},
};

/** Focus-ordered contextual handlers; the newest live registration wins. */
export interface ContextualHandlerRegistry<T> {
  register(handler: T): () => void;
  current(): T | undefined;
}

export function createContextualHandlerRegistry<T>(): ContextualHandlerRegistry<T> {
  const handlers = new Map<symbol, T>();
  return {
    register(handler) {
      const token = Symbol("contextual-command-target");
      handlers.set(token, handler);
      return () => {
        handlers.delete(token);
      };
    },
    current() {
      let current: T | undefined;
      for (const handler of handlers.values()) current = handler;
      return current;
    },
  };
}

export const CommandContext = createContext<CommandBridge>(NOOP);

export function useCommands(): CommandBridge {
  return useContext(CommandContext);
}
