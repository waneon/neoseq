import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/ui/components";

function renderConfirmation(onClose = vi.fn(), onConfirm = vi.fn()) {
  function ConfirmationHarness() {
    const [open, setOpen] = useState(true);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={trigger}>Delete page…</button>
        {open && (
          <ConfirmDialog
            title="Delete page?"
            cancelLabel="Keep page"
            confirmLabel="Delete page"
            returnFocus={() => trigger.current}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            onConfirm={onConfirm}
          >
            This cannot be undone.
          </ConfirmDialog>
        )}
      </>
    );
  }

  render(<ConfirmationHarness />);
  return { onClose, onConfirm };
}

describe("a destructive confirmation", () => {
  it("starts on the safe action and Escape cancels it", async () => {
    const user = userEvent.setup();
    const { onClose } = renderConfirmation();

    await waitFor(() => expect(screen.getByRole("button", { name: "Keep page" })).toHaveFocus());
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete page…" })).toHaveFocus());
  });

  it("lets the caller own completion", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirmation();

    await user.click(screen.getByRole("button", { name: "Delete page" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog", { name: "Delete page?" })).toBeInTheDocument();
  });
});
