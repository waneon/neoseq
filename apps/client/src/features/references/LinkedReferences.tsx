import { useMemo, useState } from "react";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { OutlineOwner } from "../../core-port/snapshot";
import type { QueryEntityRef, SparqlQueryRequest } from "../../generated/core-port";
import { useI18n } from "../../i18n";
import { Button } from "../../ui/shadcn/button";
import { useHistoryActions } from "../history/context";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { entityName, entityRefKey } from "../query/cells";
import { useQueryAnswer } from "../query/execution";
import { useSession, useSessionSelector } from "../shell/session-context";

// RDF entity components use RFC 3986's unreserved characters.
function iriComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const PAGE_SIZE = 100;

function referenceQuery(graphId: string, target: OutlineOwner, page: number): SparqlQueryRequest {
  const relation = `?source ?relation ?target .
       FILTER(?relation = neo:tag || ?relation = neo:references ||
         STRSTARTS(STR(?relation), "urn:neoseq:property:") ||
         STRSTARTS(STR(?relation), "urn:neoseq:default-property:"))`;
  return {
    kind: "raw_sparql",
    language: "sparql-1.1/neoseq-v1",
    source: `PREFIX neo: <urn:neoseq:vocab:v1:>
      SELECT DISTINCT ?source ?owner ?content WHERE {
        ${relation}
        OPTIONAL { ?source neo:owner ?owner }
        OPTIONAL { ?source neo:content ?content }
      }
      ORDER BY ?owner ?source
      LIMIT ${PAGE_SIZE + 1}
      OFFSET ${page * PAGE_SIZE}`,
    bindings: {
      target: {
        kind: "iri",
        value: `urn:neoseq:entity:${iriComponent(graphId)}:page:${iriComponent(target.id)}`,
      },
    },
  };
}

/** Incoming semantic links, derived from the entire graph without hydrating every outline. */
export function LinkedReferences({ owner }: { owner: OutlineOwner }) {
  const session = useSession();
  const snapshot = useSessionSelector((state) => state.snapshot);
  const history = useHistoryActions();
  const { message, formatJournalDate, formatTimeOfDay, compare } = useI18n();
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState(0);
  const request = useMemo(
    () => referenceQuery(session.graphId, owner, page),
    [session.graphId, owner.kind, owner.id, page],
  );
  const answer = useQueryAnswer(JSON.stringify(["references", owner.kind, owner.id]), request);
  const rows = answer.frame?.result.kind === "select" ? answer.frame.result.rows : [];
  const context = {
    snapshot,
    message,
    formatDate: formatJournalDate,
    formatTime: formatTimeOfDay,
    compare,
  };
  const entries = rows.flatMap((row) => {
    const source = row.source?.kind === "iri" ? row.source.entity : undefined;
    if (!source) return [];
    const place: QueryEntityRef = source.kind === "block" ? source.owner : source;
    return [
      {
        source,
        place,
        content: row.content?.kind === "literal" ? row.content.value : entityName(source, context),
      },
    ];
  });
  const currentPage =
    answer.frame?.request.kind === "raw_sparql" && answer.frame.request.source === request.source;
  const hasNextPage = entries.length > PAGE_SIZE;

  // Empty reverse links add no chrome beneath the writing surface.
  if (page === 0 && entries.length === 0 && !answer.error && (!answer.frame || currentPage))
    return null;
  return (
    <section className="linked-references" data-testid="linked-references">
      <button
        type="button"
        className="linked-references-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        {message("references.title")}
        {page === 0 && currentPage && (
          <span className="linked-references-count">
            {hasNextPage ? `${PAGE_SIZE}+` : entries.length}
          </span>
        )}
      </button>
      {open && (
        <>
          {answer.error && (
            <div className="inline-error" role="alert">
              {answer.error}
              <Button onClick={() => answer.run(true)}>{message("common.retry")}</Button>
            </div>
          )}
          <ul className="linked-reference-list">
            {entries.slice(0, PAGE_SIZE).map(({ source, place, content }) => (
              <li key={entityRefKey(source)} data-testid="linked-reference">
                <button
                  type="button"
                  className="linked-reference-place"
                  onClick={() => history.open(place)}
                >
                  {entityName(place, context)}
                </button>
                {source.kind === "block" && (
                  <div className="linked-reference-block">
                    <Button
                      size="icon"
                      aria-label={message("references.openBlock")}
                      onClick={() => history.open(source)}
                    >
                      <ArrowUpRightIcon aria-hidden />
                    </Button>
                    <BlockMarkdown
                      markdown={content || message("references.emptyBlock")}
                      variant="compact"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {(page > 0 || hasNextPage) && (
            <div className="linked-reference-pagination">
              <Button
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                {message("references.previous")}
              </Button>
              <Button
                disabled={!hasNextPage || !currentPage || answer.loading || Boolean(answer.error)}
                onClick={() => setPage((value) => value + 1)}
              >
                {message("references.next")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
