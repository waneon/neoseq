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
  textarea.setSelectionRange(
    plan.selectionStart,
    plan.selectionEnd,
    plan.selectionDirection,
  );
}

function assignRef(ref: Ref<HTMLTextAreaElement>, value: HTMLTextAreaElement | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const BlockTextArea = forwardRef<HTMLTextAreaElement, BlockTextAreaProps>(
  function BlockTextArea(
    {
      autoClosers,
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
    const latest = useRef({ autoClosers, onValueChange, onPairSelection, readOnly });
    latest.current = { autoClosers, onValueChange, onPairSelection, readOnly };

    const setRef = useCallback((node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      assignRef(forwardedRef, node);
    }, [forwardedRef]);

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
        const cameThroughComposition =
          snapshot.inputType === "insertCompositionText"
          || snapshot.isComposing
          || event.isComposing
          || (snapshot.inputType === "insertText" && !snapshot.cancelable);
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
      onValueChange(event.currentTarget.value, event.currentTarget);
    };

    return (
      <textarea
        {...props}
        ref={setRef}
        readOnly={readOnly}
        onChange={handleChange}
        onCompositionStart={(event) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onCompositionEnd?.(event);
        }}
      />
    );
  },
);
