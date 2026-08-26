import { useCallback, useRef } from "react";
import type { EditorKeymap } from "../../../entities/settings";
import type { VimMode } from "./vim/engine";

/** Why an editor is receiving the caret. The reason determines modal intent. */
export type BlockActivationMethod =
  | "pointer"
  | "keyboard"
  | "programmatic"
  | "context_menu";

export type MarkdownActivationMethod = Extract<
  BlockActivationMethod,
  "pointer" | "keyboard"
>;

/** Pointer and context-menu entrances mean “write here” in every writable host. */
export function vimModeForActivation(
  keymap: EditorKeymap,
  readonly: boolean,
  method: BlockActivationMethod,
): VimMode | null {
  if (
    keymap === "vim"
    && !readonly
    && (method === "pointer" || method === "context_menu")
  ) {
    return "insert";
  }
  return null;
}

/**
 * The browser focuses a pressed textarea before it clicks it. This entrance
 * carries the pointer's intent across that ordering so a host can activate and
 * choose its Vim mode in the focus event's single React commit.
 */
export interface BlockActivationEntrance {
  beginPointer(): void;
  focusMethod(fallback?: BlockActivationMethod): BlockActivationMethod;
  completePointer(): void;
}

export function useBlockActivationEntrance(): BlockActivationEntrance {
  const pointer = useRef(false);
  const beginPointer = useCallback(() => {
    pointer.current = true;
  }, []);
  const focusMethod = useCallback((fallback: BlockActivationMethod = "keyboard") => {
    const method = pointer.current ? "pointer" : fallback;
    pointer.current = false;
    return method;
  }, []);
  const completePointer = useCallback(() => {
    pointer.current = false;
  }, []);
  return { beginPointer, focusMethod, completePointer };
}
