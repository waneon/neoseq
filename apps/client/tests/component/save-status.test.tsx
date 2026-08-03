// Save-state surface: acknowledged local durability, non-durable writes,
// and the retry path.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { openFakeSession } from "../../src/core-port/testing/fake-core-port";
import { SaveStatus } from "../../src/features/shell/SaveStatus";

describe("save status", () => {
  it("tracks saved → unsaved → retried states", async () => {
    const { session, port } = await openFakeSession();
    const user = userEvent.setup();
    const View = () => (
      <SaveStatus state={session.getState()} onRetry={() => void session.retry()} />
    );
    const { rerender } = render(<View />);
    session.subscribe(() => rerender(<View />));

    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save", "saved");

    port.failNextSave = { code: "dirty_unsaved", message: "append failed", retryable: true };
    await expect(
      session.execute({ type: "rename_page", page_id: "home", title: "Renamed" }),
    ).rejects.toThrow();
    expect(screen.getByTestId("save-status")).toHaveAttribute("data-save", "unsaved");

    await user.click(screen.getByTestId("retry-save"));
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute("data-save", "saved"),
    );
  });

  it("labels storage-full failures distinctly", async () => {
    const { session, port } = await openFakeSession();
    const View = () => <SaveStatus state={session.getState()} onRetry={() => {}} />;
    const { rerender } = render(<View />);
    session.subscribe(() => rerender(<View />));
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    port.failNextSave = { code: "storage_full", message: "quota exceeded", retryable: true };
    await expect(
      session.execute({ type: "rename_page", page_id: "home", title: "Again" }),
    ).rejects.toThrow();
    expect(screen.getByTestId("save-status")).toHaveTextContent("Storage full");
  });
});
