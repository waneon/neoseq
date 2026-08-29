import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/ui/components";

function renderConfirmation(
  onClose = vi.fn(),
  onConfirm: () => void | Promise<void> = vi.fn(),
  onConfirmError = vi.fn(),
) {
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
            onConfirmError={onConfirmError}
          >
            This cannot be undone.
          </ConfirmDialog>
        )}
      </>
    );
  }

  render(<ConfirmationHarness />);
  return { onClose, onConfirm, onConfirmError };
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

  it("stays open and blocks dismissal until an async operation succeeds", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { onClose } = renderConfirmation(undefined, onConfirm);

    await user.click(screen.getByRole("button", { name: "Delete page" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete page" })).toBeDisabled();
    expect(screen.getByRole("alertdialog", { name: "Delete page?" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog", { name: "Delete page?" })).not.toBeInTheDocument();
  });

  it("keeps the explanation visible when the operation fails", async () => {
    const user = userEvent.setup();
    const failure = new Error("storage unavailable");
    const onConfirm = vi.fn(async () => {
      throw failure;
    });
    const { onClose, onConfirmError } = renderConfirmation(undefined, onConfirm);

    await user.click(screen.getByRole("button", { name: "Delete page" }));

    await waitFor(() => expect(onConfirmError).toHaveBeenCalledWith(failure));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete page" })).toBeEnabled();
    expect(screen.getByRole("alertdialog", { name: "Delete page?" })).toBeInTheDocument();
  });
});
