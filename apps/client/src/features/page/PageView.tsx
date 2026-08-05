import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
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
import { useNotify } from "../notify/context";
import { failureReason } from "../notify/errors";
import { useSession, useSessionState } from "../shell/session-context";
import { configuredTimezone } from "../../entities/journal";
import { useI18n } from "../../i18n";

export function PageView() {
  const { graphId = "", pageId = "" } = useParams();
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const page = findPage(state.snapshot, pageId);

  // A failed hydrate leaves a real page rendering as an empty one, which reads
  // as data loss. Say so, and carry the retry inside the report — a failed
  // retry reports again rather than falling silent the second time.
  // The explicit type argument breaks the inference cycle created by the retry
  // action referring back to this callback.
  const load = useCallback<() => void>(() => {
    void session.hydratePage(pageId).catch((error: unknown) => {
      notify.failure(message("failure.loadPage"), error, {
        label: message("common.retry"),
        run: load,
      });
    });
  }, [message, notify, pageId, session]);

  useEffect(() => {
    if (!page || state.status !== "ready" || state.hydratedPages.has(pageId)) return;
    load();
  }, [load, page, pageId, state.hydratedPages, state.status]);

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
  const { message } = useI18n();
  return (
    <Tombstone
      title={message("page.missing")}
      detail={message("page.missingDetail")}
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
                  .catch((cause) =>
                    setRestoreError(
                      cause instanceof Error && cause.message.includes("page does not exist")
                        ? message("page.nothingToRestore")
                        : failureReason(cause, message),
                    )
                  )
              }
            >
              {message("page.restore")}
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
  const [renameError, setRenameError] = useState<string | null>(null);
  const errorId = useId();
  const isJournal = pageKind(page) === "journal";
  const { message } = useI18n();

  if (isJournal) {
    return <h1>{authoritative}</h1>;
  }

  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    setRenameError(null);
    if (next && next !== authoritative) {
      void session
        .execute({ type: "rename_page", page_id: page.id, title: next })
        .catch((cause) => {
          setRenameError(
            failureReason(cause, message),
          );
        });
    }
  };

  return (
    <div className="page-title-field">
      <input
        className="page-title"
        value={draft ?? authoritative}
        aria-label={message("page.title")}
        aria-invalid={renameError ? true : undefined}
        aria-describedby={renameError ? errorId : undefined}
        data-testid="page-title"
        readOnly={state.mode === "readonly"}
        onChange={(event) => {
          setDraft(event.target.value);
          setRenameError(null);
        }}
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
            setRenameError(null);
            event.currentTarget.blur();
          }
        }}
      />
      {renameError && (
        <p id={errorId} className="field-error" role="alert">
          {renameError}
        </p>
      )}
    </div>
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
  const notify = useNotify();
  const { message } = useI18n();
  const readonly = state.mode === "readonly";
  const isJournal = pageKind(page) === "journal";
  const [info, setInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="icon-btn"
            aria-label={message("page.actions")}
            data-testid="page-menu"
          >
            <MoreHorizontalIcon aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid="menu-page-properties"
            onSelect={onOpenProperties}
          >
            <Settings2Icon aria-hidden />
            {message("page.properties")}
            <DropdownMenuShortcut>{MOD}⇧P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="menu-page-info" onSelect={() => setInfo(true)}>
            <InfoIcon aria-hidden />
            {message("page.info")}
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
                {message("page.delete")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {info && <PageInfoDialog page={page} onClose={() => setInfo(false)} />}
      {confirmDelete && (
        <Dialog title={message("page.deleteTitle")} onClose={() => setConfirmDelete(false)}>
          <p>
            {message("page.deleteConfirm", { name: pageTitle(page) })}
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              {message("common.cancel")}
            </button>
            <button
              className="btn btn-danger"
              data-testid="confirm-delete-page"
              onClick={() => {
                setConfirmDelete(false);
                void session
                  .execute({ type: "delete_page", page_id: page.id })
                  .catch((error: unknown) => {
                    // The dialog is gone by now, so there is nowhere inline
                    // left for this to be said.
                    notify.failure(
                      message("failure.deletePage", { name: pageTitle(page) }),
                      error,
                    );
                  });
              }}
            >
              {message("page.deleteAction")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * Page metadata, read-only. These keys (`page.kind`, `journal.date`,
 * `system.created-at`, `system.updated-at`) are facts *about* the page rather
 * than data the user put on it, so they are not mixed into the property list.
 */
function PageInfoDialog({ page, onClose }: { page: PageSnapshot; onClose: () => void }) {
  const { graphId = "" } = useParams();
  const notify = useNotify();
  const { message, formatInstant } = useI18n();
  const created = stringValue(page.properties, "system.created-at");
  const updated = stringValue(page.properties, "system.updated-at");
  const journal = stringValue(page.properties, "journal.date");
  const [copied, setCopied] = useState(false);

  return (
    <Dialog title={message("page.info")} onClose={onClose}>
      <dl className="page-info">
        <dt>{message("page.kind")}</dt>
        <dd>
          {pageKind(page) === "journal" ? message("page.journalDay") : message("common.page")}
        </dd>
        {journal && (
          <>
            <dt>{message("page.journalDate")}</dt>
            <dd className="mono">{journal}</dd>
          </>
        )}
        {created && (
          <>
            <dt>{message("page.created")}</dt>
            <dd>{formatInstant(created, configuredTimezone())}</dd>
          </>
        )}
        {updated && (
          <>
            <dt>{message("page.updated")}</dt>
            <dd>{formatInstant(updated, configuredTimezone())}</dd>
          </>
        )}
        <dt>{message("page.pageId")}</dt>
        <dd>
          <button
            type="button"
            aria-label={message("page.copyId")}
            onClick={() => {
              // The label swap is the acknowledgement; only its absence needs
              // reporting, because a button that does nothing looks broken.
              void navigator.clipboard?.writeText(page.id).then(
                () => setCopied(true),
                (error: unknown) => {
                  notify.failure(message("failure.copyPageId"), error);
                },
              );
            }}
          >
            {copied ? message("common.copied") : page.id}
          </button>
        </dd>
        <dt>{message("page.graph")}</dt>
        <dd className="mono">{graphId}</dd>
      </dl>
    </Dialog>
  );
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
  const { message } = useI18n();
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
              {message("page.goToJournal")}
            </Link>
            {actions}
          </div>
        </section>
      </div>
    </div>
  );
}
