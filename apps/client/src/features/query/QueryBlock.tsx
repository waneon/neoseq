import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, PlayIcon } from "lucide-react";
import type { RdfTerm, SparqlQueryResult } from "../../generated/core-port";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { stringValue } from "../../core-port/snapshot";
import { Button } from "@/ui/shadcn/button";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { failureReason } from "../notify/errors";

const LANGUAGE = "sparql-1.1/neoseq-v1" as const;
const RUN_DEBOUNCE_MS = 300;

export function QueryBlock({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const source = stringValue(block.properties, "query.source");
  const storedLanguage = stringValue(block.properties, "query.language");
  const [draft, setDraft] = useState(source ?? "");
  const [result, setResult] = useState<SparqlQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { message } = useI18n();

  useEffect(() => setDraft(source ?? ""), [source]);

  const run = () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void session
      .query({ language: LANGUAGE, source: draft, bindings: {} })
      .then((next) => {
        if (current === generation.current) setResult(next);
      })
      .catch((cause) => {
        if (current === generation.current) {
          setResult(null);
          setError(failureReason(cause, message));
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  };

  useEffect(() => {
    const timer = window.setTimeout(run, RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // A canonical graph revision invalidates the previous derived result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, state.revision, session]);

  if (source === undefined) return null;

  const commit = async () => {
    if (draft !== source) {
      await session.execute({
        type: "set_property",
        entity: { kind: "block", page_id: pageId, id: block.id },
        key: "query.source",
        value: { type: "string", value: draft },
      });
    }
    if (storedLanguage !== LANGUAGE) {
      await session.execute({
        type: "set_property",
        entity: { kind: "block", page_id: pageId, id: block.id },
        key: "query.language",
        value: { type: "string", value: LANGUAGE },
      });
    }
  };

  return (
    <section
      className="query-block"
      aria-label={message("query.section")}
      data-testid="query-block"
    >
      <div className="query-toolbar">
        <span className="query-language">SPARQL</span>
        <span className="query-revision">
          {result
            ? message("query.revision", { revision: result.revision })
            : loading
              ? message("query.running")
              : message("query.notRun")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={run}
          aria-label={message("query.run")}
          disabled={loading}
        >
          {loading ? <LoaderCircleIcon className="query-spinner" /> : <PlayIcon />}
        </Button>
      </div>
      <textarea
        className="query-source"
        value={draft}
        readOnly={state.mode === "readonly"}
        spellCheck={false}
        aria-label={message("query.source")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            run();
          }
        }}
      />
      <div className="query-output" aria-busy={loading}>
        {error && (
          <p className="query-diagnostic" role="alert">
            {error}
          </p>
        )}
        {!error && result && <QueryResultView result={result} />}
      </div>
    </section>
  );
}

function QueryResultView({ result }: { result: SparqlQueryResult }) {
  const { message } = useI18n();
  if (result.kind === "ask") {
    return (
      <p className="query-ask" data-value={result.value}>
        {result.value ? message("query.askTrue") : message("query.askFalse")}
      </p>
    );
  }
  if (result.rows.length === 0) {
    return <p className="query-empty">{message("query.noResults")}</p>;
  }
  return (
    <div className="query-table-wrap">
      <table className="query-table">
        <thead>
          <tr>
            {result.variables.map((variable) => (
              <th key={variable} scope="col">
                ?{variable}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {result.variables.map((variable) => (
                <td key={variable}>{formatTerm(row[variable])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTerm(term: RdfTerm | undefined): string {
  if (!term) return "—";
  if (term.kind === "literal") return term.value;
  if (term.entity) {
    if (term.entity.kind === "block") return term.entity.id;
    return term.entity.id;
  }
  return term.value;
}
