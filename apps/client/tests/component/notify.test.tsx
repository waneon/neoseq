// The notification layer: what earns a toast, what must never get one, and how
// the surface behaves once it is up.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotifyProvider, useNotify, type Notifier } from "../../src/features/notify/context";
import { failureToast } from "../../src/features/notify/errors";
import { CorePortFailure } from "../../src/core-worker";
import { GRAPH_ID, mountAt } from "./harness";

/** Mounts the provider and hands the notifier back for direct driving. */
function mountNotifier(): Notifier {
  let notifier!: Notifier;
  const Probe = () => {
    notifier = useNotify();
    return null;
  };
  render(
    <NotifyProvider>
      <Probe />
    </NotifyProvider>,
  );
  return notifier;
}

function MissingProviderProbe() {
  useNotify();
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("failure copy", () => {
  it("turns a core message into a sentence under a verb the user recognises", () => {
    const input = failureToast(
      "Couldn’t indent that block",
      new CorePortFailure({
        code: "internal",
        message: "first sibling cannot be indented",
        retryable: false,
      }),
    );
    expect(input).toEqual({
      tone: "danger",
      title: "Couldn’t indent that block",
      detail: "First sibling cannot be indented.",
      key: "Couldn’t indent that block internal",
    });
  });

  it("falls back to the code's own wording when the core sends no message", () => {
    const input = failureToast(
      "Couldn’t undo",
      new CorePortFailure({ code: "command_timeout", message: "", retryable: true }),
    );
    expect(input?.detail).toBe("The change took too long and was abandoned.");
  });

  it("stays silent on durability, which the save slot owns", () => {
    for (const code of ["dirty_unsaved", "storage_full"] as const) {
      expect(
        failureToast("Couldn’t save", new CorePortFailure({ code, message: "x", retryable: true })),
      ).toBeNull();
    }
  });
});

describe("toast surface", () => {
  it("fails fast outside the notification boundary", () => {
    expect(() => render(<MissingProviderProbe />)).toThrow(
      "useNotify must be used within NotifyProvider",
    );
  });

  it("announces a failure assertively and a notice politely", async () => {
    const notify = mountNotifier();
    act(() => {
      notify.show({ tone: "danger", title: "Broke" });
      notify.show({ tone: "info", title: "Noted" });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Broke");
    expect(screen.getByRole("status")).toHaveTextContent("Noted");
  });

  it("collapses repeats onto one toast with a counter", async () => {
    const notify = mountNotifier();
    const error = new CorePortFailure({ code: "internal", message: "nope", retryable: false });
    act(() => {
      notify.failure("Couldn’t move that block up", error);
      notify.failure("Couldn’t move that block up", error);
      notify.failure("Couldn’t move that block up", error);
    });
    const toasts = screen.getAllByTestId("toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toHaveTextContent("×3");
  });

  it("expires every report, and gives a failure the longest window", () => {
    vi.useFakeTimers();
    const notify = mountNotifier();
    act(() => {
      notify.show({ tone: "danger", title: "Stays longer" });
      notify.show({ tone: "info", title: "Leaves first" });
    });
    expect(screen.getAllByTestId("toast")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(6500);
    });
    const remaining = screen.getAllByTestId("toast");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveTextContent("Stays longer");

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("shows how long is left, and holds the countdown while the pointer is on it", () => {
    vi.useFakeTimers();
    const notify = mountNotifier();
    act(() => {
      notify.show({ tone: "info", title: "Noted", duration: 4000 });
    });
    const toast = screen.getByTestId("toast");
    expect(toast).toHaveStyle({ "--toast-duration": "4000ms" });
    expect(screen.getByTestId("toast-timer")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
      fireEvent.mouseEnter(screen.getByTestId("toasts"));
    });
    expect(toast).toHaveAttribute("data-paused", "true");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // Paused means paused: the report is still there long past its own window.
    expect(screen.getByTestId("toast")).toBeInTheDocument();

    act(() => {
      fireEvent.mouseLeave(screen.getByTestId("toasts"));
    });
    expect(screen.getByTestId("toast")).toHaveAttribute("data-paused", "false");
    act(() => {
      // Only the three seconds it had left, not another four.
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("dismisses from the close button", async () => {
    const notify = mountNotifier();
    const user = userEvent.setup();
    act(() => {
      notify.show({ tone: "danger", title: "Couldn’t undo" });
    });
    await user.click(screen.getByLabelText("Dismiss: Couldn’t undo"));
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("runs an action and closes, leaving the outcome to report itself", async () => {
    const notify = mountNotifier();
    const user = userEvent.setup();
    const retry = vi.fn();
    act(() => {
      notify.show({
        tone: "danger",
        title: "Couldn’t load this page",
        action: { label: "Try again", run: retry },
      });
    });
    await user.click(screen.getByTestId("toast-action"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("never lets a burst of notices push an unread failure off the stack", () => {
    const notify = mountNotifier();
    act(() => {
      notify.show({ tone: "danger", title: "Real problem" });
      for (let index = 0; index < 6; index += 1) {
        notify.show({ tone: "info", title: `Notice ${index}` });
      }
    });
    const toasts = screen.getAllByTestId("toast");
    expect(toasts.length).toBeLessThanOrEqual(4);
    expect(screen.getByRole("alert")).toHaveTextContent("Real problem");
  });
});

describe("wiring", () => {
  it("reports a rejected structural command from the outline", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/p/home`);
    const user = userEvent.setup();
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "alpha",
    });
    await waitFor(() => expect(screen.getByLabelText("Block text")).toBeInTheDocument());

    // Tab on the first root block: the core rejects it, and until now the
    // rejection was swallowed and the row simply did not move.
    await user.click(screen.getByLabelText("Block text"));
    await user.keyboard("{Tab}");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t indent that block"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("First sibling cannot be indented.");
  });

  it("leaves a non-durable write to the save slot rather than toasting it", async () => {
    const { session, port } = await mountAt(`/g/${GRAPH_ID}/p/home`);
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    port.failNextSave = { code: "dirty_unsaved", message: "append failed", retryable: true };
    await expect(
      session.execute({ type: "rename_page", page_id: "home", title: "Renamed" }),
    ).rejects.toThrow();
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });
});
