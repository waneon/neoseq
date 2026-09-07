import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  CalendarDaysIcon,
  FileTextIcon,
  InfoIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from "lucide-react";
import type { PageSnapshot } from "../../core-port/snapshot";
import {
  findPage,
  journalDate,
  outlineOwnerKey,
  pageKind,
  pageTitle,
  queryDocument,
  stringValue,
} from "../../core-port/snapshot";
import { FAVOURITE_KEY, isFavourite } from "../../entities/favourites";
import { isGenericProperty } from "../../entities/properties";
import { Outliner } from "../outline/Outliner";
import { PageProperties } from "../properties/PageProperties";
import { AutoHeight } from "../../ui/auto-height";
import { ConfirmDialog, Dialog } from "../../ui/components";
import { Button } from "@/ui/shadcn/button";
import { EditableTitle } from "../../ui/EditableTitle";
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
import { useSession, useSessionSelector } from "../shell/session-context";
import { configuredTimezone } from "../../entities/journal";
import { useI18n } from "../../i18n";
import { graphPath } from "../graphs/routing";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";
import { writeClipboardText } from "@/lib/clipboard";
import { LinkedReferences } from "../references/LinkedReferences";
import { QueryPanel } from "../query/QueryPanel";

export function PageView() {
  const { graphId = "", pageId = "" } = useParams();
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) =>
      left.snapshot === right.snapshot &&
      left.status === right.status &&
      left.hydratedOutlines === right.hydratedOutlines,
  );
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
    if (
      !page ||
      state.status !== "ready" ||
      state.hydratedOutlines.has(outlineOwnerKey({ kind: "page", id: pageId }))
    )
      return;
    load();
  }, [load, page, pageId, state.hydratedOutlines, state.status]);

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
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const notify = useNotify();
  const { message } = useI18n();
  return (
    <Tombstone
      title={message("page.missing")}
      detail={message("page.missingDetail")}
      graphId={graphId}
      actions={
        !readonly ? (
          <Button
            data-testid="restore-page"
            onClick={() =>
              void session
                .execute({ type: "restore_page", page_id: pageId })
                .catch((error: unknown) => {
                  // The button leaves the tombstone exactly as it was, so the
                  // reason has nowhere else to be said.
                  notify.failure(message("failure.restorePage"), error);
                })
            }
          >
            {message("page.restore")}
          </Button>
        ) : undefined
      }
    />
  );
}

export function PageBody({
  page,
  header,
  foot,
}: {
  page: PageSnapshot;
  /**
   * The journal shares page actions and supplies its own date navigation.
   */
  header?: (menu: ReactNode, onContextMenu: (event: React.MouseEvent) => void) => ReactNode;
  /**
   * A second body under the writing — today's standing queries, and nothing else
   * so far. It goes *after* the append zone, so the region under the last block
   * keeps the whole of its reach as the add-a-block affordance.
   */
  foot?: ReactNode;
}) {
  const { message } = useI18n();
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [propertyPicker, setPropertyPicker] = useState<{ trigger: HTMLElement | null } | null>(
    null,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const propsOpen = propertyPicker !== null;
  const setPropsOpen = useCallback((open: boolean) => {
    setPropertyPicker(open ? { trigger: null } : null);
  }, []);

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenuOpen(true);
  };

  const menu = (
    <>
      {!page.properties.some((property) => isGenericProperty(property.key)) && (
        <Button
          variant="ghost"
          className="document-properties-action"
          aria-label={message("page.properties")}
          title={message("page.properties")}
          aria-expanded={propsOpen}
          data-testid="page-properties-trigger"
          onClick={(event) => setPropertyPicker({ trigger: event.currentTarget })}
        >
          <Settings2Icon aria-hidden />
          <span>{message("properties.title")}</span>
        </Button>
      )}
      <PageMenu
        page={page}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onOpenProperties={() => setPropsOpen(true)}
      />
    </>
  );

  return (
    <div className="page-scroll" ref={setScrollElement}>
      <article className="page-body enter-fade-view" key={page.id}>
        {header ? (
          header(menu, openMenu)
        ) : (
          <DocumentHeader
            kind={pageKind(page) === "journal" ? "journal" : "page"}
            actions={menu}
            onContextMenu={openMenu}
          >
            <PageTitle page={page} />
          </DocumentHeader>
        )}
        <AutoHeight>
          <PageProperties
            page={page}
            open={propsOpen}
            trigger={propertyPicker?.trigger}
            onOpenChange={setPropsOpen}
          />
        </AutoHeight>
        <PageQuery page={page} />
        <Outliner
          owner={{ kind: "page", id: page.id }}
          blocks={page.blocks}
          scrollElement={scrollElement}
        />
        {foot}
        <LinkedReferences key={page.id} owner={{ kind: "page", id: page.id }} />
      </article>
    </div>
  );
}

/** A document's identity and navigation sit above the writing's own text axis. */
export function DocumentHeader({
  kind,
  actions,
  children,
  onContextMenu,
}: {
  kind: "page" | "journal";
  actions: ReactNode;
  children: ReactNode;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { message } = useI18n();
  const Icon = kind === "journal" ? CalendarDaysIcon : FileTextIcon;
  return (
    <header className={`document-header ${kind}-header`} onContextMenu={onContextMenu}>
      <div className="document-toolbar">
        <span className="document-eyebrow">
          <Icon aria-hidden />
          {message(kind === "journal" ? "shell.journal" : "common.page")}
        </span>
        <div className="title-actions">{actions}</div>
      </div>
      <div className="title-row">{children}</div>
    </header>
  );
}

function PageQuery({ page }: { page: PageSnapshot }) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const document = queryDocument(page.properties);
  if (!document) return null;
  const owner = { kind: "page", id: page.id } as const;
  return (
    <QueryPanel
      binding={{ kind: "managed", owner, document }}
      executionKey={JSON.stringify(["page", page.id])}
      variant="page"
      label={message("query.section")}
      onRemove={() => {
        void session
          .execute({ type: "remove_property", owner, key: "builtin.query" })
          .catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause));
      }}
    />
  );
}

function PageTitle({ page }: { page: PageSnapshot }) {
  const session = useSession();
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const notify = useNotify();
  const authoritative = pageTitle(page);
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

  return (
    <EditableTitle
      value={authoritative}
      label={message("page.title")}
      testId="page-title"
      readonly={readonly}
      onCommit={(title) =>
        session.execute({ type: "rename_page", page_id: page.id, title }).then(() => undefined)
      }
      onError={(error) => notify.failure(message("failure.renamePage"), error)}
    />
  );
}

/** Page actions have one visible trigger, menu, and focus owner on every route. */
function PageMenu({
  page,
  open,
  onOpenChange,
  onOpenProperties,
}: {
  page: PageSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenProperties: () => void;
}) {
  const session = useSession();
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const bridge = useCommands();
  const bindings = useShortcutBindings();
  const notify = useNotify();
  const { message } = useI18n();
  const isJournal = pageKind(page) === "journal";
  const [dialog, setDialog] = useState<"info" | "delete" | null>(null);
  const starred = isFavourite(page);
  const owner = { kind: "page", id: page.id } as const;

  // The palette reaches the same two verbs. Registering them here keeps the
  // menu the single owner of what they do.
  useEffect(() => {
    bridge.setPageActions({
      info: () => setDialog("info"),
      remove: !isJournal && !readonly ? () => setDialog("delete") : undefined,
    });
    return () => bridge.setPageActions(null);
  }, [bridge, isJournal, readonly]);

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            aria-label={message("page.actions")}
            data-testid="page-actions-trigger"
          >
            <MoreHorizontalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="menu-page-properties" onSelect={onOpenProperties}>
            <Settings2Icon aria-hidden />
            {message("page.properties")}
            <DropdownMenuShortcut>
              <Shortcut binding={bindings.properties} plain />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          {!readonly && (
            <DropdownMenuItem
              data-testid="menu-page-favourite"
              onSelect={() => {
                void session
                  .execute(
                    starred
                      ? { type: "remove_property", owner, key: FAVOURITE_KEY }
                      : {
                          type: "set_property",
                          owner,
                          key: FAVOURITE_KEY,
                          value: { type: "checkbox", value: true },
                        },
                  )
                  .catch((error: unknown) => notify.failure(message("failure.favourite"), error));
              }}
            >
              {starred ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
              {message(starred ? "favourites.remove" : "favourites.add")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid="menu-page-info" onSelect={() => setDialog("info")}>
            <InfoIcon aria-hidden />
            {message("page.info")}
          </DropdownMenuItem>
          {!isJournal && !readonly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="delete-page"
                onSelect={() => setDialog("delete")}
              >
                <Trash2Icon aria-hidden />
                {message("page.delete")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "info" && <PageInfoDialog page={page} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <ConfirmDialog
          title={message("page.deleteTitle")}
          cancelLabel={message("common.cancel")}
          confirmLabel={message("page.deleteAction")}
          testId="confirm-delete-page"
          returnFocus={() => document.querySelector<HTMLElement>('[data-testid="page-title"]')}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await session.execute({ type: "delete_page", page_id: page.id });
          }}
          onConfirmError={(error) =>
            notify.failure(message("failure.deletePage", { name: pageTitle(page) }), error)
          }
        >
          {message("page.deleteConfirm", { name: pageTitle(page) })}
        </ConfirmDialog>
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
              void writeClipboardText(page.id).then(
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
  const { repositoryId = LOCAL_REPOSITORY_ID } = useParams();
  return (
    <div className="page-scroll">
      {/* A failure keeps the shell: the rail and top bar stay put so a mistyped
          date does not cost the user their navigation. */}
      <div className="page-body">
        <section className="tombstone" data-testid="tombstone">
          <h1>{title}</h1>
          <p>{detail}</p>
          <div className="actions">
            <Button asChild variant="secondary">
              <Link to={graphPath(repositoryId, graphId, "journal")}>
                {message("page.goToJournal")}
              </Link>
            </Button>
            {actions}
          </div>
        </section>
      </div>
    </div>
  );
}
