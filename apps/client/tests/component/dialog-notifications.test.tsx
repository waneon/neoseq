// Answering a notification is not a gesture away from an open dialog.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import { LocaleProvider } from "../../src/i18n";
import { NotifyProvider, useNotify } from "../../src/features/notify/context";
import { Dialog } from "../../src/ui/components";

function Notice() {
  const notify = useNotify();
  useEffect(() => {
    notify.show({ tone: "info", key: "notice", title: "Something happened" });
  }, [notify]);
  return null;
}

it("keeps a dialog open when a notification beside it is dismissed", async () => {
  const onClose = vi.fn();
  render(
    <LocaleProvider initialPreference="en">
      <NotifyProvider>
        <Notice />
        <Dialog title="Settings" onClose={onClose}>
          <p>Body</p>
        </Dialog>
      </NotifyProvider>
    </LocaleProvider>,
  );
  // The toast stylesheet, absent here, re-enables pointer events under a modal.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(await screen.findByTestId("toast-dismiss"));
  expect(screen.queryByTestId("toast")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
