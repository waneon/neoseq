// One code block's appearance: its language, a copy action, line numbers, and
// highlighted text.
//
// Reading and editing draw the same view. The editor lays a transparent
// textarea over the text column, so the caret and selection are native while
// the highlighted copy beneath shows through. Lines wrap; each line is a grid
// row beside its number, so a wrapped line keeps its number at its first row.

import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import { writeClipboardText } from "../../lib/clipboard";
import { useOptionalNotify } from "../notify/context";
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
  const { message } = useI18n();
  const tokens = useCodeTokens(code, info);
  const lines: ThemedToken[][] =
    tokens ?? code.split("\n").map((content) => [{ content, offset: 0 }]);
  const word = info.split(/\s+/u, 1)[0];
  const named = codeLanguage(word)?.label ?? word;
  // The head always names the language, so the bullet beside it has a label.
  const name = language ?? (
    <span className="code-language">{named || message("code.plainText")}</span>
  );
  return (
    <div
      className={className ? `code-block ${className}` : "code-block"}
      data-testid="code-block"
      data-highlighted={tokens ? true : undefined}
    >
      <div className="code-header">
        {name}
        <CopyCode code={code} />
      </div>
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

function CopyCode({ code }: { code: string }) {
  const { message } = useI18n();
  const notify = useOptionalNotify();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = message(copied ? "code.copied" : "code.copy");
  return (
    <button
      type="button"
      className="code-copy"
      aria-label={label}
      title={label}
      data-testid="code-copy"
      // The caret stays in a block being edited: copying is not an edit.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() =>
        void writeClipboardText(code).then(
          () => setCopied(true),
          (error: unknown) => notify?.failure(message("failure.copyCode"), error),
        )
      }
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </button>
  );
}
