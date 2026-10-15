import * as React from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonClass } from "@/ui/shadcn/button";

// The frame is the modal's underlay: React Aria makes everything outside it
// inert, so the scrim is its `::before` rather than a sibling. Centred by the
// frame rather than by a half-applied translate, so the panel comes to rest at
// `transform: none` — a panel parked on a translate is a target automation
// reports as unstable. There is no exit animation: a dialog that has been
// answered leaves no ghost.
function DialogSurface({
  role = "dialog",
  title,
  description,
  dismissible,
  closeLabel,
  onClose,
  children,
}: {
  role?: "dialog" | "alertdialog";
  title: string;
  description: React.ReactNode;
  /** Escape and a press outside close the dialog. */
  dismissible: boolean;
  /** Shows a close control with this label. */
  closeLabel?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const descriptionId = React.useId();
  return (
    <ModalOverlay
      isOpen
      isDismissable={dismissible && role === "dialog"}
      isKeyboardDismissDisabled={!dismissible}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="dialog-frame"
    >
      <Modal className="contents">
        <Dialog
          role={role}
          aria-describedby={descriptionId}
          className="dialog-surface enter-rise relative grid w-full max-w-[420px] gap-4 rounded-[var(--r-4)] bg-[var(--overlay)] p-6 shadow-[var(--e3)] max-[600px]:p-4"
        >
          <div className={cn("flex flex-col", role === "dialog" ? "gap-1 pr-8" : "gap-2")}>
            <Heading
              slot="title"
              className="text-[var(--text-lg)] font-semibold leading-[var(--lh-lg)] tracking-[var(--track-lg)] text-[var(--ink)]"
            >
              {title}
            </Heading>
            <div id={descriptionId} className="text-sm leading-[var(--lh-sm)] text-[var(--ink-2)]">
              {description}
            </div>
          </div>
          {children}
          {closeLabel && (
            <button
              type="button"
              className={cn(buttonClass("secondary", "icon"), "absolute right-3 top-3")}
              aria-label={closeLabel}
              disabled={!dismissible}
              onClick={onClose}
            >
              <XIcon />
            </button>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export { DialogSurface };
