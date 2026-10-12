// One code block's appearance: its language, line numbers, and highlighted text.
//
// Reading and editing draw the same view. The editor lays a transparent
// textarea over the text column, so the caret and selection are native while
// the highlighted copy beneath shows through. Lines wrap; each line is a grid
// row beside its number, so a wrapped line keeps its number at its first row.

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { useCodeTokens, type ThemedToken } from "./highlight";
import { codeLanguage } from "./languages";

export function CodeView({
  code,
  info,
  language,
  editor,
  className,
}: {
  code: string;
  info: string;
  /** The language control; when absent the language is only named. */
  language?: ReactNode;
  /** The textarea laid over the text, when the block is editable as code. */
  editor?: ReactNode;
  className?: string;
}) {
  const tokens = useCodeTokens(code, info);
  const lines: ThemedToken[][] =
    tokens ?? code.split("\n").map((content) => [{ content, offset: 0 }]);
  const word = info.split(/\s+/u, 1)[0];
  const named = codeLanguage(word)?.label ?? word;
  const header = language ?? (named ? <span className="code-language">{named}</span> : null);
  return (
    <div
      className={className ? `code-block ${className}` : "code-block"}
      data-testid="code-block"
      data-highlighted={tokens ? true : undefined}
    >
      {header && <div className="code-header">{header}</div>}
      <pre
        className="code-surface"
        style={
          {
            "--code-number-width": `${String(lines.length).length}ch`,
            "--code-line-count": lines.length,
          } as CSSProperties
        }
      >
        <code aria-hidden={editor ? true : undefined}>
          {lines.map((line, index) => (
            <Fragment key={index}>
              <span className="code-number" aria-hidden>
                {index + 1}
              </span>
              <span className="code-line">
                {line.map((token, at) =>
                  token.color ? (
                    <span key={at} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ) : (
                    token.content
                  ),
                )}
              </span>
            </Fragment>
          ))}
        </code>
        {editor}
      </pre>
    </div>
  );
}
