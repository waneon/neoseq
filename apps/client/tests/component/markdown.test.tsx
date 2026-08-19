import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockMarkdown } from "../../src/features/markdown/BlockMarkdown";
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

  it("uses the syntax detector only to skip visually identical plain text", () => {
    expect(hasMarkdownSyntax("ordinary text")).toBe(false);
    expect(hasMarkdownSyntax("read **this**")).toBe(true);
    expect(hasMarkdownSyntax("first\nsecond")).toBe(true);
    expect(hasMarkdownSyntax("<https://example.com>")).toBe(true);
    expect(hasMarkdownSyntax("~~not CommonMark~~")).toBe(false);
  });
});
