import {
  CheckIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useI18n } from "../../i18n";

/** The active outline's touch route to the same structural commands as its menu. */
export function MobileEditorToolbar({
  blockId,
  canIndent,
  canOutdent,
  canOpenMenu,
  onIndent,
  onOutdent,
  onMenu,
  onDone,
  onBlur,
}: {
  blockId: string;
  canIndent: boolean;
  canOutdent: boolean;
  canOpenMenu: boolean;
  onIndent(): void;
  onOutdent(): void;
  onMenu(trigger: HTMLButtonElement): void;
  onDone(): void;
  onBlur(): void;
}) {
  const { message } = useI18n();
  return (
    <div
      className="mobile-editor-toolbar"
      role="group"
      aria-label={message("outline.mobileToolbar")}
      data-testid="mobile-editor-toolbar"
      data-block-toolbar-for={blockId}
      onBlur={onBlur}
      // A structural tap keeps the native editor and selection alive. Moving
      // focus to a button would dismiss the software keyboard between edits.
      onPointerDown={(event) => event.preventDefault()}
    >
      <button type="button" disabled={!canOutdent} onClick={onOutdent}>
        <IndentDecreaseIcon aria-hidden />
        <span>{message("outline.outdent")}</span>
      </button>
      <button type="button" disabled={!canIndent} onClick={onIndent}>
        <IndentIncreaseIcon aria-hidden />
        <span>{message("outline.indent")}</span>
      </button>
      <button
        type="button"
        aria-label={message("outline.blockActions")}
        aria-haspopup="menu"
        disabled={!canOpenMenu}
        onClick={(event) => onMenu(event.currentTarget)}
      >
        <MoreHorizontalIcon aria-hidden />
        <span>{message("outline.mobileActions")}</span>
      </button>
      <button type="button" className="mobile-editor-done" onClick={onDone}>
        <CheckIcon aria-hidden />
        <span>{message("common.done")}</span>
      </button>
    </div>
  );
}
