import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  InfoIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import type { PageSnapshot } from "../../core-port/snapshot";
import { findPage, pageKind, pageTitle, stringValue } from "../../core-port/snapshot";
import { Outliner } from "../outline/Outliner";
import { PageProperties } from "../properties/PageProperties";
import { Dialog } from "../../ui/components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { MOD } from "../commands/keys";
import { useSession, useSessionState } from "../shell/session-context";

export function PageView() {
  const { graphId = "", pageId = "" } = useParams();
  const session = useSession();
  const state = useSessionState();
  const page = findPage(state.snapshot, pageId);

  useEffect(() => {
    if (!page || state.status !== "ready" || state.hydratedPages.has(pageId)) return;
    void session.hydratePage(pageId).catch(() => undefined);
  }, [page, pageId, session, state.hydratedPages, state.status]);

  if (!page) {
    // Deleted pages are soft-deleted and leave the snapshot, so a missing
    // page is either deleted or never existed. Either way the reference
    // resolves to a tombstone; a replacement page is never created.
    return <MissingTombstone graphId={graphId} pageId={pageId} />;
  }
  return <PageBody page={page} />;
}

function MissingTombstone({ graphId, pageId }: { graphId: string; pageId: string }) {
  const session = useSession();
  const state = useSessionState();
  const [restoreError, setRestoreError] = useState<string | null>(null);
  return (
    <Tombstone
      title="This page isn't available"
      detail="It may have been deleted, or the reference may point to a page that was never created. NeoSeq keeps the reference resolvable instead of creating a replacement."
      graphId={graphId}
      actions={
        state.mode !== "readonly" ? (
          <>
            <button
              className="btn btn-primary"
              data-testid="restore-page"
              onClick={() =>
                void session
                  .execute({ type: "restore_page", page_id: pageId })
                  .then(() => setRestoreError(null))
                  .catch(() => setRestoreError("Nothing to restore: this page never existed."))
              }
            >
              Try to restore
            </button>
            {restoreError && (
              <span className="field-error" data-testid="restore-error">
                {restoreError}
              </span>
            )}
          </>
        ) : undefined
      }
    />
  );
}

export function PageBody({
  page,
  header,
}: {
  page: PageSnapshot;
  /**
   * The journal supplies its own title row. It receives the already-wired page
   * menu so the properties panel has a pointer route on both surfaces without
   * either view reaching for shell state.
   */
  header?: (menu: ReactNode) => ReactNode;
}) {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [propsOpen, setPropsOpen] = useState(false);
  const menu = <PageMenu page={page} onOpenProperties={() => setPropsOpen(true)} />;
  return (
    <div className="page-scroll" ref={setScrollElement}>
      <article className="page-body" key={page.id}>
        {header ? (
          header(menu)
        ) : (
          <div className="title-row">
            <EditableTitle page={page} />
            <div className="title-actions">{menu}</div>
          </div>
        )}
        {/* Properties sit between the title and the writing, collapsed, so the
            region below the outline stays free of chrome. */}
        <PageProperties page={page} open={propsOpen} onOpenChange={setPropsOpen} />
        <Outliner page={page} scrollElement={scrollElement} />
      </article>
    </div>
  );
}

function EditableTitle({ page }: { page: PageSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const authoritative = pageTitle(page);
  const [draft, setDraft] = useState<string | null>(null);
  const isJournal = pageKind(page) === "journal";

  if (isJournal) {
    return <h1>{authoritative}</h1>;
  }

  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== authoritative) {
      void session
        .execute({ type: "rename_page", page_id: page.id, title: next })
        .catch(() => undefined);
    }
  };

  return (
    <input
      className="page-title"
      value={draft ?? authoritative}
      aria-label="Page title"
      data-testid="page-title"
      readOnly={state.mode === "readonly"}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          // Escape abandons the draft rather than committing it — the field had
          // no way out before except reverting the text by hand.
          event.preventDefault();
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The one permanent page-scoped control. It is the named route to properties,
 * to the page's own metadata, and to deletion — which is why the writing surface
 * needs no other chrome of its own.
 */
export function PageMenu({
  page,
  onOpenProperties,
}: {
  page: PageSnapshot;
  onOpenProperties: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const readonly = state.mode === "readonly";
  const isJournal = pageKind(page) === "journal";
  const [info, setInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="icon-btn" aria-label="Page actions" data-testid="page-menu">
            <MoreHorizontalIcon aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid="menu-page-properties"
            onSelect={onOpenProperties}
          >
            <Settings2Icon aria-hidden />
            Page properties
            <DropdownMenuShortcut>{MOD}⇧P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="menu-page-info" onSelect={() => setInfo(true)}>
            <InfoIcon aria-hidden />
            Page info
          </DropdownMenuItem>
          {!isJournal && !readonly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="delete-page"
                onSelect={() => setConfirmDelete(true)}
              >
                <Trash2Icon aria-hidden />
                Delete page…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {info && <PageInfoDialog page={page} onClose={() => setInfo(false)} />}
      {confirmDelete && (
        <Dialog title="Delete page" onClose={() => setConfirmDelete(false)}>
          <p>
            Delete <strong>{pageTitle(page)}</strong>? References to it stay resolvable, and you
            can restore it from the tombstone they lead to.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              data-testid="confirm-delete-page"
              onClick={() => {
                setConfirmDelete(false);
                void session
                  .execute({ type: "delete_page", page_id: page.id })
                  .catch(() => undefined);
              }}
            >
              Delete page
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * Page metadata, read-only. These keys (`page.kind`, `journal.date`,
 * `system.created-at`) are facts *about* the page rather than data the user put
 * on it, so they are no longer mixed into the property list.
 */
function PageInfoDialog({ page, onClose }: { page: PageSnapshot; onClose: () => void }) {
  const { graphId = "" } = useParams();
  const created = stringValue(page.properties, "system.created-at");
  const journal = stringValue(page.properties, "journal.date");
  const [copied, setCopied] = useState(false);

  return (
    <Dialog title="Page info" onClose={onClose}>
      <dl className="page-info">
        <dt>Kind</dt>
        <dd>{pageKind(page) === "journal" ? "Journal day" : "Page"}</dd>
        {journal && (
          <>
            <dt>Journal date</dt>
            <dd className="mono">{journal}</dd>
          </>
        )}
        {created && (
          <>
            <dt>Created</dt>
            <dd>{formatInstant(created)}</dd>
          </>
        )}
        <dt>Page id</dt>
        <dd>
          <button
            type="button"
            aria-label="Copy page id"
            onClick={() => {
              void navigator.clipboard?.writeText(page.id).then(
                () => setCopied(true),
                () => undefined,
              );
            }}
          >
            {copied ? "Copied" : page.id}
          </button>
        </dd>
        <dt>Graph</dt>
        <dd className="mono">{graphId}</dd>
      </dl>
    </Dialog>
  );
}

function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.valueOf())) return iso;
  return parsed.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Tombstone({
  title,
  detail,
  graphId,
  actions,
}: {
  title: string;
  detail: string;
  graphId: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-scroll">
      {/* A failure keeps the shell: the rail and top bar stay put so a mistyped
          date does not cost the user their navigation. */}
      <div className="page-body">
        <section className="tombstone" data-testid="tombstone">
          <h1>{title}</h1>
          <p>{detail}</p>
          <div className="actions">
            <Link className="btn" to={`/g/${graphId}/journal`}>
              Go to journal
            </Link>
            {actions}
          </div>
        </section>
      </div>
    </div>
  );
}
