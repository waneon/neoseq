// One code block's appearance: line numbers, highlighted text, and its language.
//
// Reading and editing draw the same view. The editor lays a transparent
// textarea over the text, so the caret and selection are native while the
// highlighted copy beneath shows through; nothing measures or moves when the
// block switches between them.

import type { CSSProperties, ReactNode } from "react";
import { useCodeTokens, type ThemedToken } from "./highlight";
import { codeLanguage } from "./languages";

export function CodeView({
  code,
  info,
  language,
  editor,
  fenceWidth = 0,
  className,
}: {
  code: string;
  info: string;
  /** The language control; when absent the language is only named. */
  language?: ReactNode;
  /** The textarea laid over the text, when the block is editable as code. */
  editor?: ReactNode;
  /** Characters on the longest fence line, which the editor's textarea holds too. */
  fenceWidth?: number;
  className?: string;
}) {
  const tokens = useCodeTokens(code, info);
  const lines: ThemedToken[][] =
    tokens ?? code.split("\n").map((content) => [{ content, offset: 0 }]);
  const named = codeLanguage(info)?.label ?? info.split(/\s+/u, 1)[0];
  return (
    <div
      className={className ? `code-block ${className}` : "code-block"}
      data-testid="code-block"
      data-highlighted={tokens ? true : undefined}
    >
      <div className="code-gutter" aria-hidden>
        {lines.map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <div className="code-scroll">
        <div
          className="code-surface"
          style={{ "--code-fence-width": `${fenceWidth}ch` } as CSSProperties}
        >
          <pre className="code-text" aria-hidden={editor ? true : undefined}>
            <code>
              {lines.map((line, index) => (
                <span key={index} className="code-line">
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
              ))}
            </code>
          </pre>
          {editor}
        </div>
      </div>
      {language ?? (named ? <span className="code-language">{named}</span> : null)}
    </div>
  );
}
