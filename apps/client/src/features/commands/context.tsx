// The bridge between the shell-level command layer and the page-level surfaces
// it needs to reach.
//
// `⌘⇧P` means "properties of whatever is in front of me": the focused block if
// there is one, otherwise the page. Those panels are owned by the Outliner and
// PageView respectively, which mount below the shell — and, in the component
// test harness, mount without a shell at all. So the shell publishes two slots
// that those views fill while they are alive, and every consumer gets a working
// no-op default rather than a thrown error.

import { createContext, useContext } from "react";

export interface CommandBridge {
  openPalette(): void;
  openShortcuts(): void;
  /** Set by the Outliner while a block is focused; cleared when none is. */
  setBlockProperties(handler: (() => void) | null): void;
  /** Set by PageView for as long as a page is on screen. */
  setPageProperties(handler: (() => void) | null): void;
  /** ⌘⇧P: the block handler if one is registered, else the page handler. */
  requestProperties(): void;
  /** The page menu's own entry, which always means the page. */
  requestPageProperties(): void;
}

const NOOP: CommandBridge = {
  openPalette: () => {},
  openShortcuts: () => {},
  setBlockProperties: () => {},
  setPageProperties: () => {},
  requestProperties: () => {},
  requestPageProperties: () => {},
};

export const CommandContext = createContext<CommandBridge>(NOOP);

export function useCommands(): CommandBridge {
  return useContext(CommandContext);
}
