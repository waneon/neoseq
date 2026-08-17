import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ListIcon,
  PlayIcon,
  Table2Icon,
} from "lucide-react";
import type { RdfTerm, SparqlQueryResult } from "../../generated/core-port";
import type { BlockSnapshot, QueryView } from "../../core-port/snapshot";
import { findPage, journalDate, pageTitle, queryDocument } from "../../core-port/snapshot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { failureReason } from "../notify/errors";
import { diffSplice } from "../outline/text-diff";

const LANGUAGE = "sparql-1.1/neoseq-v1" as const;
const RUN_DEBOUNCE_MS = 300;

export function QueryBlock({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const document = queryDocument(block.properties);
  const source = document?.source ?? "";
  const activeView = document?.views.find((view) => view.id === document.default_view_id)
    ?? document?.views[0];
  const [draft, setDraft] = useState(source);
  const [result, setResult] = useState<SparqlQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { message } = useI18n();

  useEffect(() => setDraft(source), [source]);

  const run = () => {
    const current = ++generation.current;
    // A blank source is a query the user has not written yet, not a parse
    // failure — it stays quietly at "not run" instead of opening on an error.
    if (draft.trim().length === 0) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void session
      .query({ language: document?.language ?? LANGUAGE, source: draft, bindings: {} })
      .then((next) => {
        const stale = current !== generation.current;
        if (!stale) setResult(next);
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

  if (!document || !activeView) return null;

  // The editor keeps the draft, so a refused write is invisible until the next
  // reload silently shows the old source again.
  const commit = async () => {
    const report = (error: unknown) => notify.failure(message("failure.setProperty"), error);
    const splice = diffSplice(source, draft);
    if (!splice) return;
    await session.execute({
      type: "splice_query_source",
      owner: { kind: "block", page_id: pageId, id: block.id },
      ...splice,
    }).catch(report);
  };

  const selectView = (viewId: string) => {
    if (viewId === document.default_view_id) return;
    void session.execute({
      type: "set_query_default_view",
      owner: { kind: "block", page_id: pageId, id: block.id },
      view_id: viewId,
    }).catch((error) => notify.failure(message("failure.setProperty"), error));
  };

  return (
    <section
      className="query-block"
      aria-label={message("query.section")}
      data-testid="query-block"
    >
      <div className="query-toolbar">
        <span className="query-language">SPARQL</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* The toolbar controls are the bespoke 24px icon-btn, not a shadcn
                Button: its size utilities live in the `utilities` layer, which
                outranks `neoseq`, so no toolbar CSS could ever size them. */}
            <button
              type="button"
              className="icon-btn query-view-trigger"
              disabled={state.mode === "readonly"}
              aria-label={message("query.view")}
              data-testid="query-view-trigger"
            >
              {activeView.kind === "table"
                ? <Table2Icon aria-hidden />
                : <ListIcon aria-hidden />}
              {viewLabel(activeView, message)}
              <ChevronDownIcon aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={activeView.id} onValueChange={selectView}>
              {document.views.map((view) => (
                <DropdownMenuRadioItem key={view.id} value={view.id}>
                  {view.kind === "table" ? <Table2Icon aria-hidden /> : <ListIcon aria-hidden />}
                  {viewLabel(view, message)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="query-revision">
          {result
            ? message("query.revision", { revision: result.revision })
            : loading
              ? message("query.running")
              : message("query.notRun")}
        </span>
        {/* The revision slot already says "running"; swapping or disabling the
            control on every debounced auto-run would flicker it while typing
            (§ Loading — below the flash threshold, show nothing). A stale run
            is superseded by its generation guard, so re-pressing is safe. */}
        <button
          type="button"
          className="icon-btn"
          onClick={run}
          aria-label={message("query.run")}
        >
          <PlayIcon aria-hidden />
        </button>
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
        {!error && result && <QueryResultView result={result} view={activeView} />}
      </div>
    </section>
  );
}

function QueryResultView({ result, view }: { result: SparqlQueryResult; view: QueryView }) {
  const { message, formatJournalDate } = useI18n();
  const state = useSessionState();

  // A page the graph knows is shown by its name, the way the rest of the
  // product names it — a journal day in the user's own date format, any other
  // page by its title. Only an unknown entity falls back to its raw id.
  const formatTerm = (term: RdfTerm | undefined): string => {
    if (!term) return "—";
    if (term.kind === "literal") return term.value;
    if (term.entity?.kind === "page") {
      const page = findPage(state.snapshot, term.entity.id);
      if (page) {
        const day = journalDate(page);
        return day ? formatJournalDate(day) : pageTitle(page);
      }
    }
    if (term.entity) return term.entity.id;
    return term.value;
  };

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
  const variables = view.visible_variables.length > 0
    ? result.variables.filter((variable) => view.visible_variables.includes(variable))
    : result.variables;
  if (view.kind === "list") {
    return (
      <ol className="query-list" data-testid="query-list">
        {result.rows.map((row, index) => (
          <li key={index}>
            {variables.map((variable) => (
              <span key={variable}>
                <b>?{variable}</b>
                <span>{formatTerm(row[variable])}</span>
              </span>
            ))}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="query-table-wrap">
      <table className="query-table">
        <thead>
          <tr>
            {variables.map((variable) => (
              <th key={variable} scope="col">
                ?{variable}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {variables.map((variable) => (
                <td key={variable}>{formatTerm(row[variable])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function viewLabel(view: QueryView, message: ReturnType<typeof useI18n>["message"]): string {
  if (view.id === "table") return message("query.viewTable");
  if (view.id === "list") return message("query.viewList");
  return view.name;
}

