import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PointMenu,
} from "../../src/ui/shadcn/dropdown-menu";

function NonModalMenu({ onOutside }: { onOutside: () => void }) {
  return (
    <>
      <p>Empty page</p>
      <button onClick={onOutside}>Elsewhere</button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Status</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Status menu">
          <DropdownMenuItem>Done</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function ContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <p>Empty page</p>
      <button onClick={() => setAt({ x: 10, y: 10 })}>Open</button>
      <PointMenu at={at} label="Row menu" owner={() => null} onClose={() => setAt(null)}>
        <DropdownMenuItem>Copy</DropdownMenuItem>
      </PointMenu>
    </>
  );
}

describe("non-modal menus", () => {
  it("close on a press on empty page", async () => {
    const user = userEvent.setup();
    render(<NonModalMenu onOutside={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Status" }));
    await screen.findByRole("menu");

    await user.click(screen.getByText("Empty page"));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("let a press outside land where it was aimed", async () => {
    const user = userEvent.setup();
    const outside = vi.fn();
    render(<NonModalMenu onOutside={outside} />);
    await user.click(screen.getByRole("button", { name: "Status" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(outside).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("close from their own trigger without reopening", async () => {
    const user = userEvent.setup();
    render(<NonModalMenu onOutside={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Status" });
    await user.click(trigger);
    await screen.findByRole("menu");

    await user.click(trigger);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("close a menu summoned at a point on a press on empty page", async () => {
    const user = userEvent.setup();
    render(<ContextMenu />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("menu", { name: "Row menu" })).toBeInTheDocument();

    await user.click(screen.getByText("Empty page"));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
