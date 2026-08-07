import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, PlayIcon } from "lucide-react";
import type { RdfTerm, SparqlQueryResult } from "../../generated/core-port";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { queryValue } from "../../core-port/snapshot";
import { Button } from "@/ui/shadcn/button";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { failureReason } from "../notify/errors";
import { diagnostics } from "../../diagnostics/coordinator";
import type { DiagnosticInputMethod } from "../../diagnostics/types";
import {
  DEFAULT_QUERY_LANGUAGE_ID,
  QUERY_LANGUAGES,
  queryLanguage,
} from "../../entities/query-languages";

const LANGUAGE = DEFAULT_QUERY_LANGUAGE_ID as "sparql-1.1/neoseq-v1";
const RUN_DEBOUNCE_MS = 300;

export function QueryBlock({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const query = queryValue(block.properties);
  const [draft, setDraft] = useState(query?.source ?? "");
  const [result, setResult] = useState<SparqlQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { message } = useI18n();

  useEffect(() => setDraft(query?.source ?? ""), [query?.source]);

  const run = (inputMethod: DiagnosticInputMethod = "automatic") => {
    const current = ++generation.current;
    const action = diagnostics.startAction({
      feature: "query",
      action: "run_query",
      input_method: inputMethod,
    });
    diagnostics.recordCheckpointLazy(action, "before", () => ({
      feature: "query",
      result_kind: result?.kind ?? "none",
      result_revision: result?.revision,
    }));
    setLoading(true);
    setError(null);
    void session
      .query({ language: LANGUAGE, source: draft, bindings: {} }, action)
      .then((next) => {
        const stale = current !== generation.current;
        diagnostics.recordCheckpointLazy(action, "after", () => ({
          feature: "query",
          result_kind: next.kind,
          result_row_count: next.kind === "select" ? next.rows.length : 1,
          result_column_count: next.kind === "select" ? next.variables.length : 1,
          result_revision: next.revision,
          stale_result: stale,
        }));
        if (!stale) setResult(next);
      })
      .catch((cause) => {
        diagnostics.recordCheckpointLazy(action, "failed", () => ({ feature: "query" }));
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
    if (!draft.trim() || query?.language !== LANGUAGE) return;
    const timer = window.setTimeout(run, RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // A canonical graph revision invalidates the previous derived result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, state.revision, session, query?.language]);

  if (!query) return null;
  const supported = queryLanguage(query.language) !== undefined;

  // The editor keeps the draft, so a refused write is invisible until the next
  // reload silently shows the old source again.
  const commit = async () => {
    const report = (error: unknown) => notify.failure(message("failure.setProperty"), error);
    if (draft !== query.source) {
      await session.execute({
        type: "set_property",
        entity: { kind: "block", page_id: pageId, id: block.id },
        key: "builtin.query",
        value: { type: "query", value: { language: query.language, source: draft } },
      }).catch(report);
    }
  };

  return (
    <section
      className="query-block"
      aria-label={message("query.section")}
      data-testid="query-block"
    >
      <div className="query-toolbar">
        <label className="query-language">
          <span className="sr-only">{message("query.language")}</span>
          <select
            value={query.language}
            disabled={state.mode === "readonly" || !supported}
            onChange={(event) => {
              void session.execute({
                type: "set_property",
                entity: { kind: "block", page_id: pageId, id: block.id },
                key: "builtin.query",
                value: { type: "query", value: { language: event.target.value, source: draft } },
              }).catch((cause: unknown) => notify.failure(message("failure.setProperty"), cause));
            }}
          >
            {QUERY_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>{language.label}</option>
            ))}
            {!supported && <option value={query.language}>{query.language}</option>}
          </select>
        </label>
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
          onClick={() => run("pointer")}
          aria-label={message("query.run")}
          disabled={loading || !supported || !draft.trim()}
        >
          {loading ? <LoaderCircleIcon className="query-spinner" /> : <PlayIcon />}
        </Button>
      </div>
      <textarea
        className="query-source"
        value={draft}
        readOnly={state.mode === "readonly" || !supported}
        spellCheck={false}
        aria-label={message("query.source")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            run("keyboard");
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
