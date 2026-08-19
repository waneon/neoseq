import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockMarkdown } from "../../src/features/markdown/BlockMarkdown";
import { alignSourceOffset } from "../../src/features/markdown/caret";
import { hasMarkdownSyntax } from "../../src/features/markdown/profile";

describe("block Markdown projection", () => {
  it("renders CommonMark with headings nested below the page title", () => {
    render(
      <BlockMarkdown markdown={"# Heading\n\nRead **strong** and *emphasis*."} />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeInTheDocument();
    expect(screen.getByText("strong").tagName).toBe("STRONG");
    expect(screen.getByText("emphasis").tagName).toBe("EM");
  });

  it("allows safe destinations and neutralizes executable URLs", () => {
    const { container } = render(
      <BlockMarkdown
        markdown={"[safe](https://example.com) [unsafe](javascript:alert(1))"}
      />,
    );

    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.queryByRole("link", { name: "unsafe" })).not.toBeInTheDocument();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
  });

  it("does not interpret raw HTML or fetch Markdown images", () => {
    const { container } = render(
      <BlockMarkdown markdown={'<script>alert("x")</script>\n\n![diagram](https://example.com/a.png)'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("diagram")).toHaveClass("markdown-image-alt");
  });

  it("keeps a line the author broke a line, rather than reflowing it", () => {
    const { container } = render(<BlockMarkdown markdown={"first\nsecond"} />);

    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders the GFM constructs people write: tables, strikethrough, bare links", () => {
    const { container } = render(
      <BlockMarkdown
        markdown={[
          "| Column | Value |",
          "| --- | --- |",
          "| One | 1 |",
          "",
          "~~dropped~~ at https://example.com",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Column" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "One" })).toBeInTheDocument();
    // A table can outgrow the measure, so it scrolls inside the block.
    expect(container.querySelector(".markdown-table-wrap > table")).not.toBeNull();
    expect(screen.getByText("dropped").tagName).toBe("DEL");
    expect(screen.getByRole("link", { name: "https://example.com" })).toBeInTheDocument();
  });

  it("renders a Markdown checkbox as inert text, never as a graph task", () => {
    const { container } = render(<BlockMarkdown markdown={"- [x] shipped"} />);

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
  });

  it("keeps compact query content phrasing-only and non-interactive", () => {
    const { container } = render(
      <button type="button">
        <BlockMarkdown markdown={"**Work** with [source](https://example.com)"} variant="compact" />
      </button>,
    );

    expect(container.querySelector("button a")).toBeNull();
    expect(container.querySelector("button p, button ul, button ol, button pre")).toBeNull();
    expect(screen.getByText("Work").tagName).toBe("STRONG");
  });

  it("flattens a compact table and its line breaks into one cell of text", () => {
    const { container } = render(
      <button type="button">
        <BlockMarkdown
          markdown={"| A |\n| --- |\n| 1 |\n\nnext\nline"}
          variant="compact"
        />
      </button>,
    );

    expect(container.querySelector("button table, button tr, button td, button br")).toBeNull();
    // A result row is one line, so a break inside it reads as a space once the
    // inline projection has collapsed its whitespace.
    expect(container.textContent?.replace(/\s+/gu, " ")).toContain("next line");
  });

  it("uses the syntax detector only to skip visually identical plain text", () => {
    expect(hasMarkdownSyntax("ordinary text")).toBe(false);
    expect(hasMarkdownSyntax("read **this**")).toBe(true);
    expect(hasMarkdownSyntax("<https://example.com>")).toBe(true);
    expect(hasMarkdownSyntax("~~struck out~~")).toBe(true);
    expect(hasMarkdownSyntax("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    // A soft break renders as the break the textarea already shows.
    expect(hasMarkdownSyntax("first\nsecond")).toBe(false);
    // Prose is not structure: neither is an identifier, a range, or a subtraction.
    expect(hasMarkdownSyntax("builtin_task_status stays prose")).toBe(false);
    expect(hasMarkdownSyntax("ship 3 - 1 today")).toBe(false);
    expect(hasMarkdownSyntax("2026. the year of")).toBe(true);
  });

  it("maps a point in the reading projection back to its source offset", () => {
    const source = "Read **bold text** now";
    const rendered = "Read bold text now";

    // The caret lands inside the word that was pressed, past its syntax.
    expect(alignSourceOffset(source, rendered, rendered.indexOf("text"))).toBe(
      source.indexOf("text"),
    );
    expect(alignSourceOffset(source, rendered, 0)).toBe(0);
    expect(alignSourceOffset(source, rendered, rendered.length)).toBe(source.length);
  });

  it("maps back across a heading, a list marker, and a soft break", () => {
    const source = "# Title\n\n- first\n- second";
    const rendered = "Titlefirstsecond";

    expect(alignSourceOffset(source, rendered, rendered.indexOf("second"))).toBe(
      source.indexOf("second"),
    );
  });
});
