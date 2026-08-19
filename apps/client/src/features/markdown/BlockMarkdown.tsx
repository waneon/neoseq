import { memo, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "../../lib/utils";
import { markdownSanitizeSchema, markdownUrlTransform } from "./profile";

export type MarkdownVariant = "block" | "compact";

export interface BlockMarkdownProps {
  markdown: string;
  variant?: MarkdownVariant;
  className?: string;
  /** Activates the source editor when non-interactive rendered text is pressed. */
  onActivate?: () => void;
}

function InertImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return <span className="markdown-image-alt">{alt}</span>;
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span className="markdown-link-blocked">{children}</span>;
  const external = /^https?:\/\//iu.test(href);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

const blockComponents: Components = {
  h1: ({ children }) => (
    <h2 className="markdown-heading" data-level="1">{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 className="markdown-heading" data-level="2">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="markdown-heading" data-level="3">{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className="markdown-heading" data-level="4">{children}</h5>
  ),
  h5: ({ children }) => (
    <h6 className="markdown-heading" data-level="5">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="markdown-heading" data-level="6">{children}</h6>
  ),
  hr: () => (
    <div className="markdown-thematic-break" role="separator">
      <span aria-hidden>· · ·</span>
    </div>
  ),
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ alt }) => <InertImage alt={alt} />,
};

/**
 * Query cells are frequently buttons that open an editor. Their projection is
 * phrasing-only, so Markdown never creates nested interactive or block content
 * inside that button.
 */
const compactComponents: Components = {
  p: ({ children }) => <span className="markdown-compact-paragraph">{children}</span>,
  h1: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h2: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h3: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h4: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h5: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h6: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  blockquote: ({ children }) => (
    <span className="markdown-compact-quote">{children}</span>
  ),
  ul: ({ children }) => (
    <span className="markdown-compact-list" data-kind="unordered">{children}</span>
  ),
  ol: ({ children }) => (
    <span className="markdown-compact-list" data-kind="ordered">{children}</span>
  ),
  li: ({ children }) => <span className="markdown-compact-list-item">{children}</span>,
  pre: ({ children }) => <span className="markdown-compact-pre">{children}</span>,
  hr: () => <span className="markdown-compact-break" aria-hidden> · · · </span>,
  a: ({ children }) => <span className="markdown-compact-link">{children}</span>,
  img: ({ alt }) => <InertImage alt={alt} />,
};

function BlockMarkdownView({
  markdown,
  variant = "block",
  className,
  onActivate,
}: BlockMarkdownProps) {
  const compact = variant === "compact";
  const activate = (event: MouseEvent<HTMLElement>) => {
    if (!onActivate || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a, button")) return;
    onActivate();
  };
  const Root = compact ? "span" : "div";

  return (
    <Root
      className={cn("block-markdown", className)}
      data-variant={variant}
      data-testid="block-markdown"
      dir="auto"
      onClick={activate}
    >
      <Markdown
        components={compact ? compactComponents : blockComponents}
        rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
        skipHtml
        urlTransform={markdownUrlTransform}
      >
        {markdown}
      </Markdown>
    </Root>
  );
}

export const BlockMarkdown = memo(BlockMarkdownView);
