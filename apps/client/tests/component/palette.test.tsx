// Palette dismissal, native focus order, and bounded result rendering.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../../src/features/commands/CommandPalette";
import { NotifyProvider } from "../../src/features/notify/context";
import { LocaleProvider } from "../../src/i18n";
import { Dialog } from "../../src/ui/components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../src/ui/shadcn/dropdown-menu";

function PaletteHost({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <CommandPalette
      commands={[]}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  ) : null;
}

function mountPalette(onClose: () => void) {
  return render(
    <StrictMode>
      <LocaleProvider initialPreference="en">
        <NotifyProvider>
          <PaletteHost onClose={onClose} />
        </NotifyProvider>
      </LocaleProvider>
    </StrictMode>,
  );
}

describe("the command palette closes", () => {
  it("restores the invoking editor and its caret through effect replay", async () => {
    render(<textarea aria-label="Draft" defaultValue="한국어 and English" />);
    const draft = screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement;
    draft.focus();
    draft.setSelectionRange(2, 5);
    const onClose = vi.fn();
    mountPalette(onClose);
    fireEvent.keyDown(screen.getByTestId("command-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(draft).toHaveFocus());
    expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 5]);
  });

  it("takes modal focus from a closing menu and returns to its permanent trigger", async () => {
    function MenuHost() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger>More actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setOpen(true)}>Search</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {open && <CommandPalette commands={[]} onClose={() => setOpen(false)} />}
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <StrictMode>
        <LocaleProvider initialPreference="en">
          <NotifyProvider>
            <MenuHost />
          </NotifyProvider>
        </LocaleProvider>
      </StrictMode>,
    );
    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Search", exact: true }));
    await waitFor(() => expect(screen.getByTestId("command-input")).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("offers a close control and cycles focus without invoking a result", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    mountPalette(onClose);
    const input = screen.getByTestId("command-input");
    const close = screen.getByRole("button", { name: "Close", exact: true });
    expect(input).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on the backdrop through the shared outside press lifecycle", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    mountPalette(onClose);
    await user.click(document.querySelector<HTMLElement>(".cmdk-backdrop")!);
    await waitFor(() => expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("releases modal focus before executing a command exactly once", async () => {
    render(<textarea aria-label="Command destination" />);
    const destination = screen.getByRole("textbox", { name: "Command destination" });
    const run = vi.fn(() => destination.focus());
    function CommandHost() {
      const [open, setOpen] = useState(true);
      return open ? (
        <CommandPalette
          commands={[{ id: "write", group: "Edit", label: "Write", keywords: [], run }]}
          onClose={() => setOpen(false)}
        />
      ) : null;
    }
    const user = userEvent.setup();
    render(
      <StrictMode>
        <LocaleProvider initialPreference="en">
          <NotifyProvider>
            <CommandHost />
          </NotifyProvider>
        </LocaleProvider>
      </StrictMode>,
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(destination).toHaveFocus());
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it.each(["editor", "button"])(
    "passes its invoking %s to a dialog opened by a command",
    async (kind) => {
      render(
        kind === "editor" ? (
          <textarea aria-label="Writing" defaultValue="한국어 and English" />
        ) : (
          <button>Open commands</button>
        ),
      );
      const owner =
        kind === "editor"
          ? screen.getByRole("textbox", { name: "Writing" })
          : screen.getByRole("button", { name: "Open commands" });
      owner.focus();
      if (owner instanceof HTMLTextAreaElement) owner.setSelectionRange(2, 5);

      function CommandDialogHost() {
        const [paletteOpen, setPaletteOpen] = useState(true);
        const [settingsOpen, setSettingsOpen] = useState(false);
        return (
          <>
            {paletteOpen && (
              <CommandPalette
                commands={[
                  {
                    id: "settings",
                    group: "App",
                    label: "Settings",
                    keywords: [],
                    run: () => setSettingsOpen(true),
                  },
                ]}
                onClose={() => setPaletteOpen(false)}
              />
            )}
            {settingsOpen && (
              <Dialog title="Settings" onClose={() => setSettingsOpen(false)}>
                <input aria-label="Setting value" />
              </Dialog>
            )}
          </>
        );
      }
      const user = userEvent.setup();
      render(
        <StrictMode>
          <LocaleProvider initialPreference="en">
            <NotifyProvider>
              <CommandDialogHost />
            </NotifyProvider>
          </LocaleProvider>
        </StrictMode>,
      );
      await waitFor(() => expect(screen.getByTestId("command-input")).toHaveFocus());
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible());
      await waitFor(() => expect(screen.getByLabelText("Setting value")).toHaveFocus());
      expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(owner).toHaveFocus());
      if (owner instanceof HTMLTextAreaElement) {
        expect([owner.selectionStart, owner.selectionEnd]).toEqual([2, 5]);
      }
    },
  );

  it("on Escape while an IME composition is in progress", () => {
    const onClose = vi.fn();
    mountPalette(onClose);

    // The composition guard runs first for every other key, and must not for this
    // one. A user who typed 검색 into the search field and pressed ⎋ got nothing:
    // the browser reports `isComposing` on that keydown too, the guard returned
    // before the close path, and the only remaining way out was the pointer.
    fireEvent.keyDown(screen.getByTestId("command-input"), {
      key: "Escape",
      isComposing: true,
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("on Escape after focus has left the panel", () => {
    const onClose = vi.fn();
    mountPalette(onClose);

    // External focus movement must not strand an open palette.
    screen.getByTestId("command-input").blur();
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the command palette render frontier", () => {
  it("previews a bounded catalog and still searches every command", () => {
    const commands = Array.from({ length: 500 }, (_, index) => ({
      id: `page-${index}`,
      group: "Pages" as const,
      label: `Project ${index}`,
      keywords: [],
      run: vi.fn(),
    }));
    render(
      <LocaleProvider initialPreference="en">
        <NotifyProvider>
          <CommandPalette commands={commands} onClose={() => {}} />
        </NotifyProvider>
      </LocaleProvider>,
    );

    expect(screen.getAllByRole("option")).toHaveLength(12);
    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "Project 499" },
    });
    expect(screen.getByText("Project 499")).toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(80);
  });
});
