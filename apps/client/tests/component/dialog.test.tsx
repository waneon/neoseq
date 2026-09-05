import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog } from "../../src/ui/components";
import { MenuSelect } from "../../src/ui/menu-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../src/ui/shadcn/dropdown-menu";

function DialogHarness({ fromMenu = false }: { fromMenu?: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("light");
  return (
    <>
      {fromMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setOpen(true)}>Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button onClick={() => setOpen(true)}>Settings</button>
      )}
      {open && (
        <Dialog title="Preferences" onClose={() => setOpen(false)}>
          <MenuSelect
            label="Theme"
            value={value}
            onValueChange={setValue}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Dialog>
      )}
    </>
  );
}

describe("a shared dialog", () => {
  it("keeps nested dialogs in their modal owner and closes one layer at a time", async () => {
    function NestedDialogs() {
      const [open, setOpen] = useState(false);
      const [nested, setNested] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open preferences</button>
          {open && (
            <Dialog title="Preferences" onClose={() => setOpen(false)}>
              <button onClick={() => setNested(true)}>Details</button>
              {nested && (
                <Dialog title="Details" onClose={() => setNested(false)}>
                  <input aria-label="Name" />
                </Dialog>
              )}
            </Dialog>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<NestedDialogs />);
    await user.click(screen.getByRole("button", { name: "Open preferences" }));
    const parent = screen.getByRole("dialog", { name: "Preferences" });
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(parent).toContainElement(screen.getByRole("dialog", { name: "Details" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Details" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Details" })).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open preferences" })).toHaveFocus(),
    );
  });

  it("lets a dirty field cancel before dismissing its dialog", async () => {
    function DraftDialog() {
      const [open, setOpen] = useState(true);
      const [draft, setDraft] = useState("Saved");
      return (
        open && (
          <Dialog title="Edit name" onClose={() => setOpen(false)}>
            <input
              aria-label="Name"
              value={draft}
              data-escape-cancel={draft !== "Saved" || undefined}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDraft("Saved");
              }}
            />
          </Dialog>
        )
      );
    }
    const user = userEvent.setup();
    render(<DraftDialog />);
    await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Edit name" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Saved");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Edit name" })).not.toBeInTheDocument();
  });

  it("does not dismiss during IME composition", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Preferences" });

    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
    expect(dialog).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Preferences" })).not.toBeInTheDocument();
  });

  it("returns to the menu trigger when its invoking item has unmounted", async () => {
    const user = userEvent.setup();
    render(<DialogHarness fromMenu />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Preferences" });

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus());
  });

  it.each(["Escape", "close button"])("returns focus to its invoker after %s", async (method) => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Preferences" });

    if (method === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus());
  });

  it("gives Escape only to its nested choice and then returns focus through each owner", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("combobox", { name: "Theme" }));
    await screen.findByRole("listbox", { name: "Theme" });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Theme" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Theme" })).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus());
  });
});
