// The bridge between the shell-level command layer and the page-level surfaces
// it needs to reach.
//
// `Mod+P` means "properties of whatever is in front of me": the focused block if
// there is one, otherwise the page. Those panels are owned by the Outliner and
// PageView respectively, which mount below the shell — and, in the component
// test harness, mount without a shell at all. So the shell publishes slots that
// those views fill while they are alive, and every consumer gets a working
// no-op default rather than a thrown error.
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
  /** Set by the Outliner while a block is focused; cleared when none is. */
  setBlockProperties(handler: (() => void) | null): void;
  /** Set by PageView for as long as a page is on screen. */
  setPageProperties(handler: (() => void) | null): void;
  /** Set by PageView: the verbs its title-row context menu offers. */
  setPageActions(actions: PageActions | null): void;
  /** Mod+P: opens the contextual target and reports whether one existed. */
  requestProperties(): boolean;
  requestPageInfo(): void;
  requestPageDelete(): void;
}

const NOOP: CommandBridge = {
  openPalette: () => {},
  openShortcuts: () => {},
  openSettings: () => {},
  setBlockProperties: () => {},
  setPageProperties: () => {},
  setPageActions: () => {},
  requestProperties: () => false,
  requestPageInfo: () => {},
  requestPageDelete: () => {},
};

export const CommandContext = createContext<CommandBridge>(NOOP);

export function useCommands(): CommandBridge {
  return useContext(CommandContext);
}
