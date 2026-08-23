import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BlockTextEdit } from "../BlockTextArea";
import type { VimEffect, VimKey } from "./engine";

export function vimKeyFromEvent(event: KeyboardEvent | ReactKeyboardEvent): VimKey {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return {
    key: native.key,
    shift: native.shiftKey,
    alt: native.altKey,
    ctrl: native.ctrlKey,
    meta: native.metaKey,
  };
}

export function applyVimTextEffect(
  textarea: HTMLTextAreaElement,
  effect: Extract<VimEffect, { kind: "selection" | "edit" }>,
  onEdit: (
    value: string,
    textarea: HTMLTextAreaElement,
    edit?: BlockTextEdit,
  ) => void,
): void {
  if (effect.kind === "selection") {
    textarea.setSelectionRange(effect.start, effect.end);
    return;
  }
  textarea.setRangeText(effect.insert, effect.from, effect.to, "preserve");
  textarea.setSelectionRange(effect.selectionStart, effect.selectionEnd);
  onEdit(textarea.value, textarea, {
    preferredStart: effect.from,
    preferredEnd: effect.to,
  });
}
