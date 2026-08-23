// A tag, given a place of its own.
//
// A tag was already more than a label — it carries defaults, and every block and
// page that wears it is an answer to the same question — but it had nowhere to
// *be*. Everything about one tag lived on a card in a grid, which is a listing,
// not a place; and the one thing a reader actually wants from a tag — everything
// carrying it — could only be had by writing the query out by hand somewhere else.
//
// So a tag is a page now, in the sense that matters: it has a route, a name you
// edit in place, its defaults, and its own query — seeded to ask exactly what the
// tag is for, and editable from there like every other query in the product.
// **The query's views are the page's tabs**, because a page whose whole body is
// one answer can afford to say permanently which answer is on screen; the same
// query inside a bullet cannot.
//
// Nothing here is written until it is shaped. Opening a tag runs its seeded query
// and writes nothing; the first edit — a condition, a column, a second view — is
// what brings the document into existence.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { InfoIcon, Settings2Icon, StarIcon, StarOffIcon, Trash2Icon } from "lucide-react";
import type { TagSnapshot } from "../../core-port/snapshot";
import { findTag, outlineOwnerKey, queryDocument, stringValue } from "../../core-port/snapshot";
import { canonicalEntityName } from "../../entities/names";
import { configuredTimezone } from "../../entities/journal";
import { tagPlan } from "../../entities/query-plan";
import { FAVOURITE_KEY, isFavourite } from "../../entities/favourites";
import { tagGroup } from "../../entities/tag-identity";
import { useI18n } from "../../i18n";
import { Dialog } from "../../ui/components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { useNotify } from "../notify/context";
import { Outliner } from "../outline/Outliner";
import { Tombstone } from "../page/PageView";
import { PropertyPicker } from "../properties/PropertyPicker";
import { QueryPanel } from "../query/QueryPanel";
import { useSession, useSessionState } from "../shell/session-context";
import { TagDefaults } from "./TagDefaults";
import { TagIdentityPicker, TagMark } from "./TagIdentity";

/** Where a context menu was summoned, in viewport coordinates. */
interface MenuPoint {
  x: number;
  y: number;
}

export function TagView() {
  const { graphId = "", tagId = "" } = useParams();
  const state = useSessionState();
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const tag = findTag(state.snapshot, tagId);
  const load = useCallback<() => void>(() => {
    void session.hydrateOutline({ kind: "tag", id: tagId }).catch((error: unknown) => {
      notify.failure(message("failure.loadTag"), error, {
        label: message("common.retry"),
        run: load,
      });
    });
  }, [message, notify, session, tagId]);

  useEffect(() => {
    if (
      !tag
      || state.status !== "ready"
      || state.hydratedOutlines.has(outlineOwnerKey({ kind: "tag", id: tagId }))
    ) return;
    load();
  }, [load, state.hydratedOutlines, state.status, tag, tagId]);

  if (!tag) {
    // A deleted tag leaves the snapshot, so a missing one is either deleted or
    // never existed. Either way the reference resolves to a tombstone; the tag
    // is offered back rather than silently recreated.
    return (
      <Tombstone
        title={message("tags.missing")}
        detail={message("tags.missingDetail")}
        graphId={graphId}
        actions={
          state.mode !== "readonly" ? (
            <button
              className="btn btn-primary"
              data-testid="restore-tag"
              onClick={() =>
                void session
                  .execute({ type: "restore_tag", tag_id: tagId })
                  .catch((error: unknown) => {
                    notify.failure(message("failure.restoreTag"), error);
                  })
              }
            >
              {message("tags.restore")}
            </button>
          ) : undefined
        }
      />
    );
  }
  return <TagBody key={tag.id} tag={tag} graphId={graphId} />;
}

function TagBody({ tag, graphId }: { tag: TagSnapshot; graphId: string }) {
  const { message } = useI18n();
  const state = useSessionState();
  const [picker, setPicker] = useState<{ key?: string; anchor: HTMLElement | null } | null>(null);
  const [identityAt, setIdentityAt] = useState<HTMLElement | null>(null);
  const [menuAt, setMenuAt] = useState<MenuPoint | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLElement | null>(null);
  const readonly = state.mode === "readonly";
  const document = queryDocument(tag.properties);
  const group = tagGroup(tag);

  return (
    <div className="page-scroll" ref={setScrollElement}>
      <article className="page-body enter-fade-view">
        {/* The tag's own handle: right-clicking the name is where its verbs are,
            exactly as a page's are on a page's title row. The mark before it is
            the one control that says what the tag looks like and where it is
            filed — the object is the disclosure, so nothing is parked beside it. */}
        <div
          className="title-row tag-title-row"
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuAt({ x: event.clientX, y: event.clientY });
          }}
        >
          <span
            className="tag-title-mark"
            ref={(node) => {
              markRef.current = node;
            }}
          >
            <TagMark
              tag={tag}
              size="lg"
              onOpen={readonly ? undefined : (anchor) => setIdentityAt(anchor)}
            />
          </span>
          <TagTitle tag={tag} />
          <TagMenu
            tag={tag}
            graphId={graphId}
            at={menuAt}
            onClose={() => setMenuAt(null)}
            onCustomize={() => setIdentityAt(markRef.current)}
          />
        </div>
        {group && <p className="tag-page-group" data-testid="tag-page-group">{group}</p>}
        {/* What this tag *does*: a named section of rows, not a run of chips —
            a default is a key and a value, and neither has a column in a chip. */}
        <TagDefaults
          tag={tag}
          onEdit={readonly ? undefined : (key, anchor) => setPicker({ key, anchor })}
        />
        <Outliner
          owner={{ kind: "tag", id: tag.id }}
          blocks={tag.blocks}
          scrollElement={scrollElement}
        />
        <QueryPanel
          owner={{ kind: "tag", tag_id: tag.id }}
          executionKey={JSON.stringify(["tag", tag.id])}
          document={document}
          seedPlan={tagPlan(tag.id)}
          variant="page"
          label={message("tags.queryFor", { name: tag.name })}
        />
      </article>
      {picker && (
        <PropertyPicker
          target={{ kind: "tag", id: tag.id, bag: tag.defaults }}
          anchor={picker.anchor}
          initialKey={picker.key}
          onClose={() => setPicker(null)}
        />
      )}
      {identityAt && (
        <TagIdentityPicker tag={tag} anchor={identityAt} onClose={() => setIdentityAt(null)} />
      )}
    </div>
  );
}

/**
 * The tag's name, edited where it is read. The mark beside it — the reader's own
 * emoji, or the `#` every tag wears by default — is never inside the field: a
 * name is what the reader typed, and the mark is a separate answer with a
 * separate control.
 */
function TagTitle({ tag }: { tag: TagSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  // `⏎` commits and then blurs, and the blur commits again — with the same draft,
  // because the state update has not landed yet. One rename, reported once.
  const pending = useRef<string | null>(null);

  const commit = () => {
    const raw = pending.current;
    if (raw === null) return;
    pending.current = null;
    const next = raw.trim();
    if (!next || next === tag.name) {
      setDraft(null);
      return;
    }
    const clash = state.snapshot.tags.find(
      (other) => other.id !== tag.id && canonicalEntityName(other.name) === canonicalEntityName(next),
    );
    if (clash) {
      setDraft(null);
      notify.show({
        tone: "info",
        key: "tag-duplicate",
        title: message("tags.duplicate", { name: next }),
      });
      return;
    }
    setDraft(next);
    // Release only the draft this rename was for: a reader who kept typing while
    // it was in flight has a newer one, and handing back the authoritative name
    // would throw away the characters they just entered.
    const release = () => setDraft((current) => (current === next ? null : current));
    void session
      .execute({ type: "rename_tag", tag_id: tag.id, name: next })
      .then(release)
      .catch((error: unknown) => {
        release();
        notify.failure(message("failure.renameTag", { name: tag.name }), error);
      });
  };

  // A tag's name wraps for the same reason a page's does: a name longer than the
  // measure in an `<input>` is a name the reader can only get at with the arrow
  // keys. A textarea sized to its content is the same field without that.
  const resize = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "0";
    element.style.height = `${element.scrollHeight}px`;
  };

  return (
    <div className="page-title-field tag-title-field">
      <textarea
        ref={resize}
        rows={1}
        className="page-title"
        value={draft ?? tag.name}
        aria-label={message("tags.name")}
        data-testid="tag-title"
        readOnly={state.mode === "readonly"}
        onChange={(event) => {
          // A name has no lines, so a pasted newline is a space.
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
 * The tag's verbs. Like a page's, they have no button of their own: the pointer
 * route is a right-click on the title row.
 */
function TagMenu({
  tag,
  graphId,
  at,
  onClose,
  onCustomize,
}: {
  tag: TagSnapshot;
  graphId: string;
  at: MenuPoint | null;
  onClose: () => void;
  /** The same panel the mark opens; this is its keyboard route. */
  onCustomize: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const navigate = useNavigate();
  const notify = useNotify();
  const { message } = useI18n();
  const readonly = state.mode === "readonly";
  const starred = isFavourite(tag);
  const [info, setInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
            // Radix points the menu's `aria-labelledby` at its trigger, and that
            // wins over the menu's own `aria-label` — so the name has to live
            // here, on the anchor, even though the anchor itself is hidden.
            aria-label={message("tags.actions")}
            aria-hidden
            style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.document.querySelector<HTMLElement>('[data-testid="tag-title"]')?.focus();
          }}
        >
          {!readonly && (
            <>
              <DropdownMenuItem
                data-testid="menu-tag-favourite"
                onSelect={() => {
                  const owner = { kind: "tag", tag_id: tag.id } as const;
                  void session
                    .execute(starred
                      ? { type: "remove_property", owner, key: FAVOURITE_KEY }
                      : {
                          type: "set_property",
                          owner,
                          key: FAVOURITE_KEY,
                          value: { type: "checkbox", value: true },
                        })
                    .catch((error: unknown) =>
                      notify.failure(message("failure.customizeTag", { name: tag.name }), error));
                }}
              >
                {starred ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
                {message(starred ? "favourites.remove" : "favourites.add")}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="menu-tag-customize"
                onSelect={() => requestAnimationFrame(onCustomize)}
              >
                <Settings2Icon aria-hidden />
                {message("tags.customize")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem data-testid="menu-tag-info" onSelect={() => setInfo(true)}>
            <InfoIcon aria-hidden />
            {message("tags.info")}
          </DropdownMenuItem>
          {!readonly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="tag-delete"
                onSelect={() => setConfirmDelete(true)}
              >
                <Trash2Icon aria-hidden />
                {message("tags.deleteAction")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {info && <TagInfoDialog tag={tag} graphId={graphId} onClose={() => setInfo(false)} />}
      {confirmDelete && (
        <Dialog title={message("tags.deleteTitle")} onClose={() => setConfirmDelete(false)}>
          <p>{message("tags.deleteConfirm", { name: tag.name })}</p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              {message("common.cancel")}
            </button>
            <button
              className="btn btn-danger"
              data-testid="confirm-delete-tag"
              onClick={() => {
                setConfirmDelete(false);
                void session
                  .execute({ type: "delete_tag", tag_id: tag.id })
                  .then(() => navigate(`/g/${graphId}/tags`))
                  .catch((error: unknown) => {
                    // The dialog is gone by now, so there is nowhere inline left
                    // for this to be said.
                    notify.failure(message("failure.deleteTag", { name: tag.name }), error);
                  });
              }}
            >
              {message("tags.deleteAction")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Facts *about* the tag rather than data anybody put on it. */
function TagInfoDialog({
  tag,
  graphId,
  onClose,
}: {
  tag: TagSnapshot;
  graphId: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const { message, formatInstant } = useI18n();
  const created = stringValue(tag.properties, "builtin.created-at");
  const updated = stringValue(tag.properties, "builtin.updated-at");
  const [copied, setCopied] = useState(false);

  return (
    <Dialog title={message("tags.info")} onClose={onClose}>
      <dl className="page-info">
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
        <dt>{message("tags.tagId")}</dt>
        <dd>
          <button
            type="button"
            aria-label={message("tags.copyId")}
            onClick={() => {
              // The label swap is the acknowledgement; only its absence needs
              // reporting, because a button that does nothing looks broken.
              void navigator.clipboard?.writeText(tag.id).then(
                () => setCopied(true),
                (error: unknown) => {
                  notify.failure(message("failure.copyPageId"), error);
                },
              );
            }}
          >
            {copied ? message("common.copied") : tag.id}
          </button>
        </dd>
        <dt>{message("page.graph")}</dt>
        <dd className="mono">{graphId}</dd>
      </dl>
    </Dialog>
  );
}
