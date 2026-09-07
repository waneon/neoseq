import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageAutocomplete } from "../../src/features/properties/PageAutocomplete";
import { findJournalPage, pageTitle } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

async function mountAutocomplete(onPick = vi.fn<(id: string) => void | Promise<void>>()) {
  const harness = await mountAt(
    `/g/${GRAPH_ID}/custom`,
    <>
      <PageAutocomplete placeholder="Pick a page" onPick={onPick} />
      <button>Next field</button>
    </>,
  );
  await harness.session.execute({ type: "ensure_page", page_id: "alpha", title: "Alpha" });
  await harness.session.execute({ type: "ensure_page", page_id: "beta", title: "Beta" });
  return { ...harness, onPick, input: screen.getByRole("combobox") };
}

describe("page autocomplete", () => {
  it("offers and selects journals by their semantic date instead of their internal ID", async () => {
    const user = userEvent.setup();
    const { session, input, onPick } = await mountAutocomplete();
    await session.execute({ type: "ensure_journal", date: "2026-09-07" });
    const journal = findJournalPage(session.getState().snapshot, "2026-09-07")!;
    expect(pageTitle(journal)).toBe("2026-09-07");
    await user.type(input, "2026-09-07");
    const option = await screen.findByRole("option", { name: "2026-09-07" });
    expect(option).not.toHaveTextContent(journal.id);
    await user.click(option);
    expect(onPick).toHaveBeenCalledWith(journal.id);
  });

  it("opens at the first option and never selects a hidden option", async () => {
    const user = userEvent.setup();
    const { input, onPick } = await mountAutocomplete();
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("alpha");
  });

  it("closes when Tab moves focus out of the input", async () => {
    const user = userEvent.setup();
    const { input } = await mountAutocomplete();
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(screen.getByRole("button", { name: "Next field" })).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("submits a selection once while pending and preserves the query after failure", async () => {
    let reject!: (cause: Error) => void;
    const pending = new Promise<void>((_, rejectRequest) => {
      reject = rejectRequest;
    });
    const onPick = vi
      .fn<(id: string) => Promise<void>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { input } = await mountAutocomplete(onPick);
    await user.click(input);
    await user.keyboard("{Enter}");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(input).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      reject(new Error("Selection failed"));
    });
    await waitFor(() => expect(input).toHaveAttribute("aria-busy", "false"));
    expect(input).toHaveValue("Alpha");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2));
  });
});
