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
import { ConfirmDialog, Dialog } from "../../ui/components";
import { Button } from "@/ui/shadcn/button";
import { EditableTitle } from "../../ui/EditableTitle";
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
            <Button
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
            </Button>
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
        <QueryPanel
          binding={{
            kind: "managed",
            owner: { kind: "tag", tag_id: tag.id },
            document,
            seedPlan: tagPlan(tag.id),
          }}
          executionKey={JSON.stringify(["tag", tag.id])}
          variant="page"
          label={message("tags.queryFor", { name: tag.name })}
        />
        <Outliner
          owner={{ kind: "tag", id: tag.id }}
          blocks={tag.blocks}
          scrollElement={scrollElement}
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
  return (
    <EditableTitle
      value={tag.name}
      label={message("tags.name")}
      testId="tag-title"
      className="tag-title-field"
      readonly={state.mode === "readonly"}
      validate={(next) => {
        const clash = state.snapshot.tags.find(
          (other) =>
            other.id !== tag.id
            && canonicalEntityName(other.name) === canonicalEntityName(next),
        );
        if (!clash) return true;
        notify.show({
          tone: "info",
          key: "tag-duplicate",
          title: message("tags.duplicate", { name: next }),
        });
        return false;
      }}
      onCommit={(name) =>
        session.execute({ type: "rename_tag", tag_id: tag.id, name }).then(() => undefined)}
      onError={(error) => {
        notify.failure(message("failure.renameTag", { name: tag.name }), error);
      }}
    />
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
  const [dialog, setDialog] = useState<"info" | "delete" | null>(null);

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
          <DropdownMenuItem
            data-testid="menu-tag-info"
            onSelect={() => setDialog("info")}
          >
            <InfoIcon aria-hidden />
            {message("tags.info")}
          </DropdownMenuItem>
          {!readonly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="tag-delete"
                onSelect={() => setDialog("delete")}
              >
                <Trash2Icon aria-hidden />
                {message("tags.deleteAction")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "info" && (
        <TagInfoDialog tag={tag} graphId={graphId} onClose={() => setDialog(null)} />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={message("tags.deleteTitle")}
          cancelLabel={message("common.cancel")}
          confirmLabel={message("tags.deleteAction")}
          testId="confirm-delete-tag"
          returnFocus={() => document.querySelector<HTMLElement>('[data-testid="tag-title"]')}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void session
              .execute({ type: "delete_tag", tag_id: tag.id })
              .then(() => navigate(`/g/${graphId}/tags`))
              .catch((error: unknown) => {
                notify.failure(message("failure.deleteTag", { name: tag.name }), error);
              });
          }}
        >
          {message("tags.deleteConfirm", { name: tag.name })}
        </ConfirmDialog>
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
