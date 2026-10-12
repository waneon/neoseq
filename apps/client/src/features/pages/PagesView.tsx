import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowDownIcon, ArrowUpIcon, FileTextIcon, PlusIcon, StarIcon } from "lucide-react";
import { isDeleted, pageKind, pageTitle, stringValue } from "../../core-port/snapshot";
import type { SparqlQueryRequest } from "../../generated/core-port";
import { isFavourite } from "../../entities/favourites";
import { useI18n } from "../../i18n";
import { Button } from "@/ui/shadcn/button";
import { SearchField } from "../../ui/SearchField";
import { graphPath } from "../graphs/routing";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";
import { useCommands } from "../commands/context";
import { useQueryAnswer } from "../query/execution";
import { DocumentChrome } from "../shell/document-chrome";
import { useSessionSelector } from "../shell/session-context";
import { canonicalEntityName } from "../../entities/names";
import { configuredTimezone } from "../../entities/journal";

const LINKS: SparqlQueryRequest = {
  kind: "raw_sparql",
  language: "sparql-1.1/neoseq-v1",
  source: `PREFIX neo: <urn:neoseq:vocab:v1:>
SELECT ?page (COUNT(DISTINCT ?source) AS ?links) WHERE {
  ?source neo:references ?page .
  ?page a neo:Page .
}
GROUP BY ?page`,
  bindings: {},
};

type SortKey = "name" | "links" | "created";

/** Every regular page, with what makes one worth opening: its links and age. */
export function PagesView() {
  const { repositoryId = LOCAL_REPOSITORY_ID, graphId = "" } = useParams();
  const snapshot = useSessionSelector((state) => state.snapshot);
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const bridge = useCommands();
  const { message, compare, formatInstant, formatNumber } = useI18n();
  const [needle, setNeedle] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "name",
    descending: false,
  });
  const links = usePageLinks();

  const pages = useMemo(
    () =>
      snapshot.pages
        .filter((page) => pageKind(page) === "regular" && !isDeleted(page))
        .map((page) => ({
          id: page.id,
          title: pageTitle(page),
          created: stringValue(page.properties, "builtin.created-at") ?? "",
          favourite: isFavourite(page),
        })),
    [snapshot],
  );

  const shown = useMemo(() => {
    const query = canonicalEntityName(needle.trim());
    const matching = query
      ? pages.filter((page) => canonicalEntityName(page.title).includes(query))
      : pages;
    const order = (left: (typeof pages)[number], right: (typeof pages)[number]) => {
      if (sort.key === "links") return (links.get(left.id) ?? 0) - (links.get(right.id) ?? 0);
      if (sort.key === "created") return left.created.localeCompare(right.created);
      return compare(left.title, right.title);
    };
    return [...matching].sort((left, right) => {
      const primary = sort.descending ? order(right, left) : order(left, right);
      return primary || compare(left.title, right.title);
    });
  }, [compare, links, needle, pages, sort]);

  const header = (key: SortKey, label: string) => {
    const active = sort.key === key;
    return (
      <button
        type="button"
        className="directory-sort"
        aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
        data-active={active || undefined}
        onClick={() =>
          setSort((current) =>
            current.key === key
              ? { key, descending: !current.descending }
              : { key, descending: key !== "name" },
          )
        }
      >
        {label}
        {active && (sort.descending ? <ArrowDownIcon aria-hidden /> : <ArrowUpIcon aria-hidden />)}
      </button>
    );
  };

  return (
    <div className="page-scroll">
      <div className="page-body directory" data-testid="pages-directory">
        <DocumentChrome>
          <Button
            variant="ghost"
            className="chrome-action"
            disabled={readonly}
            onClick={() => bridge.createPage?.()}
            data-testid="pages-new"
          >
            <PlusIcon aria-hidden />
            {message("shell.newPage")}
          </Button>
        </DocumentChrome>
        <header className="document-header" data-scroll-title={message("shell.pages")}>
          <div className="title-row">
            <h1>{message("shell.pages")}</h1>
            <span className="directory-total">{formatNumber(pages.length)}</span>
          </div>
        </header>
        {pages.length === 0 ? (
          <p className="directory-empty">{message("pages.empty")}</p>
        ) : (
          <>
            <SearchField
              value={needle}
              onChange={setNeedle}
              label={message("pages.find")}
              placeholder={message("pages.find")}
            />
            <div className="directory-list" role="table" aria-label={message("shell.pages")}>
              <div className="directory-row directory-head" role="row">
                <span role="columnheader">{header("name", message("pages.name"))}</span>
                <span role="columnheader" className="directory-num">
                  {header("links", message("pages.links"))}
                </span>
                <span role="columnheader" className="directory-num directory-date">
                  {header("created", message("page.created"))}
                </span>
              </div>
              {shown.map((page) => (
                <div className="directory-row" role="row" key={page.id}>
                  <span role="cell" className="directory-name">
                    <Link
                      to={graphPath(repositoryId, graphId, `p/${page.id}`)}
                      data-testid="pages-row-link"
                    >
                      <FileTextIcon aria-hidden />
                      <span>{page.title}</span>
                    </Link>
                    {page.favourite && (
                      <StarIcon
                        className="directory-favourite"
                        aria-label={message("favourites.marked")}
                      />
                    )}
                  </span>
                  <span role="cell" className="directory-num">
                    {links.get(page.id) ? formatNumber(links.get(page.id)!) : ""}
                  </span>
                  <span role="cell" className="directory-num directory-date">
                    {page.created
                      ? formatInstant(page.created, configuredTimezone(), {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                      : ""}
                  </span>
                </div>
              ))}
              {shown.length === 0 && (
                <p className="directory-empty">{message("pages.noMatch", { query: needle })}</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function usePageLinks(): Map<string, number> {
  const answer = useQueryAnswer("pages:links", LINKS);
  return useMemo(() => {
    const counts = new Map<string, number>();
    const result = answer.frame?.result;
    if (result?.kind !== "select") return counts;
    for (const row of result.rows) {
      const page = row.page;
      const count = row.links;
      if (page?.kind !== "iri" || page.entity?.kind !== "page" || count?.kind !== "literal")
        continue;
      counts.set(page.entity.id, Number.parseInt(count.value, 10) || 0);
    }
    return counts;
  }, [answer.frame]);
}
