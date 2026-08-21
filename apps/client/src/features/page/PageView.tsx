import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { InfoIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import type { PageSnapshot } from "../../core-port/snapshot";
import { findPage, journalDate, pageKind, pageTitle, stringValue } from "../../core-port/snapshot";
import { Outliner } from "../outline/Outliner";
import { PageProperties } from "../properties/PageProperties";
import { AutoHeight } from "../../ui/auto-height";
import { Dialog } from "../../ui/components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { useCommands } from "../commands/context";
import { Shortcut } from "../commands/Shortcut";
import { useShortcutBindings } from "../commands/shortcuts";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { configuredTimezone } from "../../entities/journal";
import { useI18n } from "../../i18n";

/** Where a context menu was summoned, in viewport coordinates. */
interface MenuPoint {
  x: number;
  y: number;
}

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
  const notify = useNotify();
  const { message } = useI18n();
  return (
    <Tombstone
      title={message("page.missing")}
      detail={message("page.missingDetail")}
      graphId={graphId}
      actions={
        state.mode !== "readonly" ? (
          <button
            className="btn btn-primary"
            data-testid="restore-page"
            onClick={() =>
              void session.execute({ type: "restore_page", page_id: pageId }).catch(
                (error: unknown) => {
                  // The button leaves the tombstone exactly as it was, so the
                  // reason has nowhere else to be said.
                  notify.failure(
                    message("failure.restorePage"),
                    error,
                  );
                },
              )
            }
          >
            {message("page.restore")}
          </button>
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
   * menu and the handler that summons it, so the page's verbs have the same
   * pointer route on both surfaces without either view reaching for shell state.
   */
  header?: (menu: ReactNode, onContextMenu: (event: React.MouseEvent) => void) => ReactNode;
}) {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [propsOpen, setPropsOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<MenuPoint | null>(null);

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenuAt({ x: event.clientX, y: event.clientY });
  };

  const menu = (
    <PageMenu
      page={page}
      at={menuAt}
      onClose={() => setMenuAt(null)}
      onOpenProperties={() => requestAnimationFrame(() => setPropsOpen(true))}
    />
  );

  return (
    <div className="page-scroll" ref={setScrollElement}>
      {/* Keyed by page, and faded, so navigating between pages says that one
          document replaced another. Without it the title and the whole outline
          swap in one frame with nothing to attribute the change to, which reads
          less like arriving somewhere than like the page glitching. `--dur-view`
          is 120ms: enough to be seen, over before anything is read. */}
      <article className="page-body enter-fade-view" key={page.id}>
        {header ? (
          header(menu, openMenu)
        ) : (
          // The title row is the page's own handle: right-clicking it is where
          // its verbs live now that the row carries no ⋯ button.
          <div className="title-row" onContextMenu={openMenu}>
            <EditableTitle page={page} />
            {menu}
          </div>
        )}
        {/* Properties sit between the title and the writing, collapsed, so the
            region below the outline stays free of chrome. Opening the disclosure
            pushes the whole outline down, so the push is animated: the writing
            slides out of the way rather than teleporting, which is the difference
            between "a panel opened above this" and "the page reflowed". */}
        <AutoHeight>
          <PageProperties page={page} open={propsOpen} onOpenChange={setPropsOpen} />
        </AutoHeight>
        <Outliner page={page} scrollElement={scrollElement} />
      </article>
    </div>
  );
}

function EditableTitle({ page }: { page: PageSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const authoritative = pageTitle(page);
  const [draft, setDraft] = useState<string | null>(null);
  // `⏎` commits and then blurs, and the blur commits again — with the same draft,
  // because the state update has not landed yet. One rename, reported once.
  const pending = useRef<string | null>(null);
  const isJournal = pageKind(page) === "journal";
  const { message, formatJournalDate } = useI18n();

  if (isJournal) {
    // A journal page carries no title — the core stores its day as a property —
    // so `pageTitle` would fall back to the page id. Reached through /journal the
    // view supplies the heading itself; reached by id, as a reference resolves it,
    // this is the only thing that would render, and it must be the same date in
    // the same format the user chose.
    const day = journalDate(page);
    return <h1 data-testid="journal-title">{day ? formatJournalDate(day) : authoritative}</h1>;
  }

  // The draft is held until the *core* has the new title, not until the command
  // has been sent.
  //
  // Dropping it on submit is what made a rename flicker: `setDraft(null)` fell
  // back to `authoritative`, which is still the old title for as long as the
  // command is in flight, so the field showed `Reading list` → `Reading` → (a
  // frame or three of the old title) → `Reading`. The user watched their own edit
  // be undone and then redone. `GraphSession` resolves a command only after it has
  // reconciled the snapshot it produced, so releasing the draft on resolution
  // hands over to a snapshot that already agrees with it: one value, one commit,
  // no intermediate frame. A rejection is the one case that does snap back, and it
  // is reported — the snap alone reads as a keystroke that never registered.
  const commit = () => {
    const raw = pending.current;
    // `⏎` commits and then blurs, and the blur would commit the same draft again.
    // Nothing pending means this draft has already been dealt with.
    if (raw === null) return;
    pending.current = null;
    const next = raw.trim();
    if (!next || next === authoritative) {
      setDraft(null);
      return;
    }
    setDraft(next);
    // Release only the draft this rename was for. A user who kept typing while it
    // was in flight has a newer one, and handing that back to the authoritative
    // title would throw away the characters they just entered.
    const release = () => setDraft((current) => (current === next ? null : current));
    void session
      .execute({ type: "rename_page", page_id: page.id, title: next })
      .then(release)
      .catch((error: unknown) => {
        release();
        notify.failure(message("failure.renamePage"), error);
      });
  };

  // A page's name wraps. It was an `<input>`, which cannot: a title longer than
  // the measure had 1836px of text in an 822px box with `overflow: clip`, so more
  // than half of a page's own name was unreachable except by putting the caret in
  // and walking across it with the arrow keys. A textarea sized to its content is
  // the same field with the one behaviour a heading needs.
  const resize = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "0";
    element.style.height = `${element.scrollHeight}px`;
  };

  return (
    <div className="page-title-field">
      <textarea
        ref={resize}
        rows={1}
        className="page-title"
        value={draft ?? authoritative}
        aria-label={message("page.title")}
        data-testid="page-title"
        readOnly={state.mode === "readonly"}
        onChange={(event) => {
          // A title has no lines, so a pasted newline is a space.
          const next = event.target.value.replace(/[\r\n]+/g, " ");
          pending.current = next;
          setDraft(next);
          resize(event.currentTarget);
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
            pending.current = null;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/**
 * The page's verbs. It has no button of its own: the pointer route is a
 * right-click on the title row, and the keyboard route is `Mod+P` for properties
 * plus the palette's own `Page info` and `Delete page…` rows, which reach these
 * same handlers through the command bridge.
 *
 * Radix needs something to position against, so the trigger is a zero-size
 * anchor placed at the pointer. It is `aria-hidden` and unfocusable: it is not a
 * control, it is a coordinate.
 */
function PageMenu({
  page,
  at,
  onClose,
  onOpenProperties,
}: {
  page: PageSnapshot;
  at: MenuPoint | null;
  onClose: () => void;
  onOpenProperties: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const bridge = useCommands();
  const bindings = useShortcutBindings();
  const notify = useNotify();
  const { message } = useI18n();
  const readonly = state.mode === "readonly";
  const isJournal = pageKind(page) === "journal";
  const [info, setInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The palette reaches the same two verbs. Registering them here keeps the
  // menu the single owner of what they do.
  useEffect(() => {
    bridge.setPageActions({
      info: () => setInfo(true),
      remove: () => {
        if (!isJournal && !readonly) setConfirmDelete(true);
      },
    });
    return () => bridge.setPageActions(null);
  }, [bridge, isJournal, readonly]);

  return (
    <>
      <DropdownMenu
        modal={false}
        open={at !== null}
        onOpenChange={(open) => (open ? undefined : onClose())}
      >
        <DropdownMenuTrigger asChild>
          <span
            className="menu-anchor"
            // Radix points the menu's `aria-labelledby` at its trigger, and
            // `aria-labelledby` wins over the menu's own `aria-label` — so the name
            // has to live here, on the anchor, even though the anchor itself is
            // hidden. A name is still read through a labelledby reference.
            aria-label={message("page.actions")}
            aria-hidden
            style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            // Focus must not land on the anchor — it is hidden from assistive
            // technology and cannot be typed into — so it goes back to the title,
            // which is the thing the menu was summoned from.
            event.preventDefault();
            document.querySelector<HTMLElement>('[data-testid="page-title"]')?.focus();
          }}
        >
          <DropdownMenuItem data-testid="menu-page-properties" onSelect={onOpenProperties}>
            <Settings2Icon aria-hidden />
            {message("page.properties")}
            <DropdownMenuShortcut>
              <Shortcut binding={bindings.properties} plain />
            </DropdownMenuShortcut>
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
 * Page metadata, read-only. These keys (`builtin.page-kind`, `builtin.journal-date`,
 * `builtin.created-at`, `builtin.updated-at`) are facts *about* the page rather
 * than data the user put on it, so they are not mixed into the property list.
 */
function PageInfoDialog({ page, onClose }: { page: PageSnapshot; onClose: () => void }) {
  const { graphId = "" } = useParams();
  const notify = useNotify();
  const { message, formatInstant } = useI18n();
  const created = stringValue(page.properties, "builtin.created-at");
  const updated = stringValue(page.properties, "builtin.updated-at");
  const journal = journalDate(page);
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
