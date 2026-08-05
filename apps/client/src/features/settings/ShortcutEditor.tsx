// The keyboard section: every global binding, what it currently is, and a way to
// change it.
//
// Recording happens on the badge itself — press it, then press the keys — so the
// control that shows the binding is the control that sets it, and there is no
// modal step between wanting a different key and having one. A rejection says
// which of the three things went wrong (no modifier, an unbindable key, a
// combination the browser keeps) rather than silently refusing.
//
// The outline's writing keys are deliberately absent. `⏎`, `⇥` and `⌫` are not
// shortcuts, they are what typing in an outline *is*; rebinding them would leave
// the editor with no way to make a block.

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { MOD } from "../commands/keys";
import { Shortcut } from "../commands/Shortcut";
import {
  SHORTCUT_IDS,
  SHORTCUT_MESSAGE,
  bindingFromEvent,
  conflictingAction,
  formatBinding,
  isDefaultBinding,
  isRejection,
  resetAllBindings,
  resetBinding,
  setBinding,
  useShortcutBindings,
  type ShortcutId,
} from "../commands/shortcuts";
import { useI18n } from "../../i18n";

const WRITING_KEYS = ["⏎", "⇥", "⇧⇥", "⌥↑", "⌥↓", "⌫"];

export function ShortcutEditor() {
  const { message } = useI18n();
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const buttons = useRef(new Map<ShortcutId, HTMLButtonElement | null>());

  // Leaving the badge ends the recording: a control that silently keeps
  // listening after the user has looked away would capture the next shortcut
  // they meant for the application.
  useEffect(() => {
    if (!recording) return;
    buttons.current.get(recording)?.focus();
  }, [recording]);

  const capture = useCallback(
    (id: ShortcutId, event: React.KeyboardEvent<HTMLButtonElement>) => {
      // Nothing typed here may reach the global layer: the point of the keypress
      // is to *name* a shortcut, not to run one.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") {
        setRecording(null);
        setNote(null);
        return;
      }
      const candidate = bindingFromEvent(event);
      if (isRejection(candidate)) {
        if (candidate.reason === "modifier") {
          setNote({
            tone: "danger",
            text: message("settings.shortcutRejectModifier", { mod: MOD }),
          });
        } else if (candidate.reason === "reserved") {
          setNote({
            tone: "danger",
            text: message("settings.shortcutRejectReserved", {
              binding: formatBinding(candidate.attempt),
            }),
          });
        } else {
          setNote({ tone: "danger", text: message("settings.shortcutRejectKey") });
        }
        return;
      }
      const clash = conflictingAction(id, candidate, bindings);
      if (clash) {
        setNote({
          tone: "danger",
          text: message("settings.shortcutConflict", {
            binding: formatBinding(candidate),
            action: message(SHORTCUT_MESSAGE[clash]),
          }),
        });
        return;
      }
      setBinding(id, candidate);
      setRecording(null);
      setNote(null);
    },
    [bindings, message],
  );

  const customised = SHORTCUT_IDS.some((id) => !isDefaultBinding(id, bindings[id]));

  return (
    <section className="settings-section">
      <h2>{message("settings.keyboard")}</h2>
      <p>{message("settings.shortcutsDescription", { mod: MOD })}</p>
      <div className="shortcut-list" data-testid="shortcut-editor">
        {SHORTCUT_IDS.map((id) => {
          const binding = bindings[id];
          const action = message(SHORTCUT_MESSAGE[id]);
          const isDefault = isDefaultBinding(id, binding);
          return (
            <div className="shortcut-row" key={id}>
              <span className="label">{action}</span>
              <button
                type="button"
                ref={(node) => {
                  buttons.current.set(id, node);
                }}
                className="shortcut-key"
                data-recording={recording === id || undefined}
                data-testid={`shortcut-${id}`}
                aria-label={message("settings.shortcutChange", { action })}
                aria-keyshortcuts={formatBinding(binding)}
                onClick={() => {
                  setNote(null);
                  setRecording((current) => (current === id ? null : id));
                }}
                onBlur={() => setRecording((current) => (current === id ? null : current))}
                onKeyDown={(event) => {
                  if (recording !== id) return;
                  capture(id, event);
                }}
              >
                {recording === id ? (
                  message("settings.shortcutRecording")
                ) : (
                  <Shortcut binding={binding} plain />
                )}
              </button>
              <button
                type="button"
                className="icon-btn shortcut-reset"
                data-default={isDefault || undefined}
                data-testid={`shortcut-reset-${id}`}
                aria-label={message("settings.shortcutReset", { action })}
                disabled={isDefault}
                onClick={() => {
                  resetBinding(id);
                  setNote(null);
                }}
              >
                <RotateCcwIcon aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      {note ? (
        <p className="shortcut-note" data-tone={note.tone} role="alert">
          {note.text}
        </p>
      ) : (
        <p className="shortcut-note">
          {message("settings.shortcutsFixed", { key: WRITING_KEYS.join(" · ") })}
        </p>
      )}
      {customised && (
        <button
          type="button"
          className="btn self-start"
          data-testid="shortcut-reset-all"
          onClick={() => {
            resetAllBindings();
            setNote(null);
          }}
        >
          {message("settings.shortcutResetAll")}
        </button>
      )}
    </section>
  );
}
