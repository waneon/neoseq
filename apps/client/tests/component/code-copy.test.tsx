// A code block's copy action takes the code, not its fences or numbers.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CodeView } from "../../src/features/code/CodeView";

const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("copies the code and says so", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<CodeView code={"echo one\necho two"} info="bash" />);
  expect(screen.getByText("Bash")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
  expect(writeText).toHaveBeenCalledWith("echo one\necho two");
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
});

it("names a code block without a language as plain text", () => {
  render(<CodeView code="x" info="" />);
  expect(screen.getByText("Plain text")).toBeInTheDocument();
});
