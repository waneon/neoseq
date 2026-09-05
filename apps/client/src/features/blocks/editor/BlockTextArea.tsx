// The native input boundary shared by every surface that edits block Markdown.
//
// A query row and an outline row make different structural decisions, but the
// browser text stream must be interpreted exactly once. Pairing, generated
// closer provenance, and IME repair live here; callers own drafts, persistence,
// completions, and surface-specific keyboard commands.

import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type ChangeEventHandler,
  type CompositionEventHandler,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import {
  planAutoPair,
  planAutoPairInputRepair,
  type AutoCloserMarker,
  type PairSelectionDirection,
  type TextEditPlan,
} from "./auto-pair";
import type { BlockContentSession } from "./content-session";
import { transformProjectedSelection } from "./selection";
import { projectContent } from "./content-buffer";

export interface BlockTextEdit {
  autoCloser?: AutoCloserMarker;
  preferredStart?: number;
  preferredEnd?: number;
}

export interface BlockTextAreaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "onCompositionStart" | "onCompositionEnd" | "value"
> {
  value: string;
  autoClosers: readonly AutoCloserMarker[];
  contentSession?: BlockContentSession;
  /** False in a modal command mode: selection stays native, text insertion does not. */
  acceptsTextInput?: boolean;
  onValueChange(value: string, textarea: HTMLTextAreaElement, edit?: BlockTextEdit): void;
  /** Pair overtype can move the caret without changing text. */
  onPairSelection?(textarea: HTMLTextAreaElement): void;
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
}

interface BeforeInputSnapshot {
  value: string;
  start: number;
  end: number;
  inputType: string;
  isComposing: boolean;
  cancelable: boolean;
}

interface PendingInputRepair {
  value: string;
  plan: TextEditPlan;
}

function applyTextEdit(textarea: HTMLTextAreaElement, plan: TextEditPlan) {
  textarea.setRangeText(plan.insert, plan.from, plan.to, "preserve");
  textarea.setSelectionRange(plan.selectionStart, plan.selectionEnd, plan.selectionDirection);
}

function assignRef(ref: Ref<HTMLTextAreaElement>, value: HTMLTextAreaElement | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const BlockTextArea = forwardRef<HTMLTextAreaElement, BlockTextAreaProps>(
  function BlockTextArea(
    {
      autoClosers,
      contentSession,
      value,
      acceptsTextInput = true,
      onValueChange,
      onPairSelection,
      onCompositionStart,
      onCompositionEnd,
      readOnly,
      ...props
    },
    forwardedRef,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const beforeInputSnapshot = useRef<BeforeInputSnapshot | null>(null);
    const pendingInputRepair = useRef<PendingInputRepair | null>(null);
    const composing = useRef(false);
    const mappedSelection = useRef<{
      start: number;
      end: number;
      direction: "forward" | "backward" | "none";
    } | null>(null);
    const latest = useRef({
      autoClosers,
      value,
      acceptsTextInput,
      onValueChange,
      onPairSelection,
      readOnly,
    });
    latest.current = {
      autoClosers,
      value,
      acceptsTextInput,
      onValueChange,
      onPairSelection,
      readOnly,
    };

    const setRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        assignRef(forwardedRef, node);
      },
      [forwardedRef],
    );

    useLayoutEffect(
      () =>
        contentSession?.observe((change) => {
          const textarea = textareaRef.current;
          if (!textarea || document.activeElement !== textarea) return;
          const previous = mappedSelection.current;
          const selection = transformProjectedSelection(change, {
            anchor: previous?.start ?? textarea.selectionStart,
            head: previous?.end ?? textarea.selectionEnd,
          });
          if (
            !previous &&
            selection.anchor === textarea.selectionStart &&
            selection.head === textarea.selectionEnd &&
            projectContent(change.before, change.beforeDirectory).markdown ===
              projectContent(change.after, change.afterDirectory).markdown
          )
            return;
          mappedSelection.current = {
            start: selection.anchor,
            end: selection.head,
            direction: previous?.direction ?? textarea.selectionDirection,
          };
        }),
      [contentSession],
    );

    useLayoutEffect(() => {
      const textarea = textareaRef.current;
      const selection = mappedSelection.current;
      if (!textarea || !selection || composing.current) return;
      mappedSelection.current = null;
      if (textarea.selectionStart === selection.start && textarea.selectionEnd === selection.end)
        return;
      const scroll: Array<{ element: HTMLElement; top: number; left: number }> = [];
      for (let element: HTMLElement | null = textarea; element; element = element.parentElement) {
        scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      textarea.setSelectionRange(selection.start, selection.end, selection.direction);
      for (const { element, top, left } of scroll) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    });

    useLayoutEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const finishPendingRepair = () => {
        const pending = pendingInputRepair.current;
        if (!pending) return;
        pendingInputRepair.current = null;
        if (textarea.value !== pending.value) return;
        applyTextEdit(textarea, pending.plan);
        latest.current.onValueChange(textarea.value, textarea, {
          autoCloser: pending.plan.autoCloser,
          preferredStart: pending.plan.from,
          preferredEnd: pending.plan.to,
        });
      };

      const handleBeforeInput = (event: InputEvent) => {
        beforeInputSnapshot.current = {
          value: textarea.value,
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          inputType: event.inputType,
          isComposing: event.isComposing,
          cancelable: event.cancelable,
        };
        if (latest.current.readOnly) return;
        if (!latest.current.acceptsTextInput) {
          if (event.cancelable) {
            event.preventDefault();
            beforeInputSnapshot.current = null;
          }
          return;
        }

        const direction = textarea.selectionDirection;
        const plan = planAutoPair({
          value: textarea.value,
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          direction: (direction ?? "none") as PairSelectionDirection,
          inputType: event.inputType,
          data: event.data,
          isComposing: event.isComposing,
        });
        if (!plan || !event.cancelable) return;

        event.preventDefault();
        if (!event.defaultPrevented) return;
        beforeInputSnapshot.current = null;
        const previous = textarea.value;
        applyTextEdit(textarea, plan);
        if (textarea.value !== previous) {
          latest.current.onValueChange(textarea.value, textarea, {
            autoCloser: plan.autoCloser,
            preferredStart: plan.from,
            preferredEnd: plan.to,
          });
        } else {
          latest.current.onPairSelection?.(textarea);
        }
      };

      const handleInput = (nativeEvent: Event) => {
        const event = nativeEvent as InputEvent;
        const snapshot = beforeInputSnapshot.current;
        beforeInputSnapshot.current = null;
        if (!snapshot || latest.current.readOnly) return;
        if (!latest.current.acceptsTextInput) {
          // Some composition paths are not cancelable. Restore the native value
          // before React's delegated change listener observes it; Normal mode
          // keeps a selectable textarea without pretending the graph is read-only.
          pendingInputRepair.current = null;
          textarea.value = snapshot.value;
          textarea.setSelectionRange(snapshot.start, snapshot.end);
          return;
        }
        const cameThroughComposition =
          snapshot.inputType === "insertCompositionText" ||
          snapshot.isComposing ||
          event.isComposing ||
          (snapshot.inputType === "insertText" && !snapshot.cancelable);
        if (!cameThroughComposition) return;

        const plan = planAutoPairInputRepair(
          snapshot.value,
          textarea.value,
          latest.current.autoClosers,
          snapshot.start,
          snapshot.end,
        );
        if (!plan) return;

        if (!event.isComposing && !snapshot.isComposing) {
          // This target listener runs before React's delegated change listener,
          // so React observes only the normalized value.
          applyTextEdit(textarea, plan);
          return;
        }

        const repair = { value: textarea.value, plan };
        pendingInputRepair.current = repair;
        queueMicrotask(() => {
          if (pendingInputRepair.current === repair && !composing.current) {
            finishPendingRepair();
          }
        });
      };

      const handleCompositionEnd = () => {
        composing.current = false;
        finishPendingRepair();
      };

      textarea.addEventListener("beforeinput", handleBeforeInput);
      textarea.addEventListener("input", handleInput);
      textarea.addEventListener("compositionend", handleCompositionEnd);
      return () => {
        textarea.removeEventListener("beforeinput", handleBeforeInput);
        textarea.removeEventListener("input", handleInput);
        textarea.removeEventListener("compositionend", handleCompositionEnd);
      };
    }, []);

    const handleChange: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
      if (!latest.current.acceptsTextInput) {
        const caret = Math.min(event.currentTarget.selectionStart, latest.current.value.length);
        event.currentTarget.value = latest.current.value;
        event.currentTarget.setSelectionRange(caret, caret);
        return;
      }
      onValueChange(event.currentTarget.value, event.currentTarget);
    };

    return (
      <textarea
        {...props}
        ref={setRef}
        value={value}
        readOnly={readOnly}
        onChange={handleChange}
        onCompositionStart={(event) => {
          composing.current = true;
          contentSession?.setComposing(true);
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onCompositionEnd?.(event);
          contentSession?.setComposing(false);
        }}
      />
    );
  },
);
