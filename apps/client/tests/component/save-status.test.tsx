// Save-state surface: acknowledged local durability, non-durable writes,
// and the retry path.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { openWasmSession } from "./wasm-test-port";
import { SaveStatus } from "../../src/features/shell/SaveStatus";

describe("save status", () => {
  it("preserves the last durable sequence when a command is unchanged", async () => {
    const { session } = await openWasmSession();

    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    const stableSave = session.getState().save;
    const stableRevision = session.getState().revision;
    const stableCanonicalRevision = session.getState().canonicalRevision;
    expect(stableSave).toEqual({ kind: "saved", sequence: 1 });

    const unchanged = await session.execute({
      type: "ensure_page",
      page_id: "home",
      title: "Home",
    });

    expect(unchanged).not.toHaveProperty("changed");
    expect(session.getState().save).toEqual(stableSave);
    expect(session.getState().revision).toBe(stableRevision);
    expect(session.getState().canonicalRevision).toBe(stableCanonicalRevision);
    await session.close();
  });

  it("tracks saved → unsaved → retried states", async () => {
    const { session, port } = await openWasmSession();
    const user = userEvent.setup();
    const View = () => (
      <SaveStatus save={session.getState().save} onRetry={() => void session.retry()} />
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
    await session.close();
  });

  it("labels storage-full failures distinctly", async () => {
    const { session, port } = await openWasmSession();
    const View = () => <SaveStatus save={session.getState().save} onRetry={() => {}} />;
    const { rerender } = render(<View />);
    session.subscribe(() => rerender(<View />));
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    port.failNextSave = { code: "storage_full", message: "quota exceeded", retryable: true };
    await expect(
      session.execute({ type: "rename_page", page_id: "home", title: "Again" }),
    ).rejects.toThrow();
    expect(screen.getByTestId("save-status")).toHaveTextContent("Storage full");
    await session.close();
  });
});
