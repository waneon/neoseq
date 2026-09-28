import { EntityKindMenuItem } from "../page/EntityKindMenuItem";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import {
  FolderIcon,
  InfoIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  StarIcon,
  StarOffIcon,
  TagsIcon,
  Trash2Icon,
} from "lucide-react";
import type { TagSnapshot } from "../../core-port/snapshot";
import { findTag, outlineOwnerKey, queryDocument, stringValue } from "../../core-port/snapshot";
import { canonicalEntityName, namedDocuments } from "../../entities/names";
import { configuredTimezone } from "../../entities/journal";
import { tagPlan } from "../../entities/query-plan";
import { FAVOURITE_KEY, isFavourite } from "../../entities/favourites";
import { tagGroup } from "../../entities/tag-identity";
import { useI18n } from "../../i18n";
import { graphPath } from "../graphs/routing";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";
import { ConfirmDialog, Dialog } from "../../ui/components";
import { Button } from "@/ui/shadcn/button";
import { elementAnchor } from "@/ui/anchored";
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
import { useSession, useSessionSelector } from "../shell/session-context";
import { TagDefaults } from "./TagDefaults";
import { TagIdentityPicker, TagMark } from "./TagIdentity";
import { writeClipboardText } from "@/lib/clipboard";
import { LinkedReferences } from "../references/LinkedReferences";

export function TagView() {
  const { repositoryId = LOCAL_REPOSITORY_ID, graphId = "", tagId = "" } = useParams();
  const state = useSessionSelector(
    (current) => current,
    (left, right) =>
      left.snapshot === right.snapshot &&
      left.mode === right.mode &&
      left.status === right.status &&
      left.hydratedOutlines === right.hydratedOutlines,
  );
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
      !tag ||
      state.status !== "ready" ||
      state.hydratedOutlines.has(outlineOwnerKey({ kind: "tag", id: tagId }))
    )
      return;
    load();
  }, [load, state.hydratedOutlines, state.status, tag, tagId]);

  if (!tag && state.snapshot.pages.some((page) => page.id === tagId))
    return <Navigate replace to={graphPath(repositoryId, graphId, `p/${tagId}`)} />;
  if (!tag) {
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
  const { repositoryId = LOCAL_REPOSITORY_ID } = useParams();
  const { message } = useI18n();
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const [picker, setPicker] = useState<{ key?: string; anchor: HTMLElement | null } | null>(null);
  const [identityAt, setIdentityAt] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const notesHeadingId = useId();
  const document = queryDocument(tag.properties);
  const group = tagGroup(tag);

  return (
    <div className="page-scroll" ref={setScrollElement}>
      <article className="page-body tag-body enter-fade-view">
        <header
          className="document-header tag-header"
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
          }}
        >
          <div className="document-toolbar">
            <Link
              className="document-eyebrow tag-directory-link"
              to={graphPath(repositoryId, graphId, "tags")}
            >
              <TagsIcon aria-hidden />
              {message("tags.title")}
            </Link>
            <div className="title-actions">
              {!readonly && (
                <Button
                  variant="ghost"
                  className="tag-customize-action"
                  data-testid="tag-customize-trigger"
                  aria-label={message("tags.customizeNamed", { name: tag.name })}
                  aria-haspopup="dialog"
                  onClick={(event) => setIdentityAt(event.currentTarget)}
                >
                  <Settings2Icon aria-hidden />
                  <span>{message("tags.customize")}</span>
                </Button>
              )}
              <TagMenu
                tag={tag}
                graphId={graphId}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onCustomize={setIdentityAt}
              />
            </div>
          </div>
          <div className="title-row tag-title-row">
            <span className="tag-title-mark">
              <TagMark
                tag={tag}
                size="lg"
                onOpen={readonly ? undefined : (anchor) => setIdentityAt(anchor)}
              />
            </span>
            <TagTitle tag={tag} />
          </div>
          {group && (
            <p className="tag-page-group" data-testid="tag-page-group">
              <FolderIcon aria-hidden />
              {group}
            </p>
          )}
        </header>
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
          title={message("tags.content")}
        />
        <section className="tag-notes" data-testid="tag-notes" aria-labelledby={notesHeadingId}>
          <div className="tag-notes-heading">
            <h2 id={notesHeadingId}>{message("tags.notes")}</h2>
            {tag.blocks.length === 0 && <p>{message("tags.notesHint")}</p>}
          </div>
          <Outliner
            owner={{ kind: "tag", id: tag.id }}
            blocks={tag.blocks}
            scrollElement={scrollElement}
          />
        </section>
        <LinkedReferences owner={{ kind: "tag", id: tag.id }} />
      </article>
      {picker && (
        <PropertyPicker
          target={{ owner: { kind: "tag_default", tag_id: tag.id }, bag: tag.defaults }}
          anchor={elementAnchor(picker.anchor)}
          initialKey={picker.key}
          returnFocus={() =>
            picker.anchor?.isConnected
              ? picker.anchor
              : (scrollElement?.querySelector<HTMLElement>('[data-testid="tag-defaults-toggle"]') ??
                null)
          }
          onClose={() => setPicker(null)}
        />
      )}
      {identityAt && (
        <TagIdentityPicker
          tag={tag}
          anchor={elementAnchor(identityAt)}
          onClose={() => setIdentityAt(null)}
        />
      )}
    </div>
  );
}

function TagTitle({ tag }: { tag: TagSnapshot }) {
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot && left.mode === right.mode,
  );
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
        const clash = namedDocuments(state.snapshot)
          .filter((entry) => !entry.deleted)
          .find(
            (other) =>
              other.id !== tag.id && canonicalEntityName(other.title) === canonicalEntityName(next),
          );
        if (!clash) return true;
        notify.show({
          tone: "info",
          key: "tag-duplicate",
          title: message("entity.duplicate", { name: next }),
        });
        return false;
      }}
      onCommit={(name) =>
        session.execute({ type: "rename_tag", tag_id: tag.id, name }).then(() => undefined)
      }
      onError={(error) => {
        notify.failure(message("failure.renameTag", { name: tag.name }), error);
      }}
    />
  );
}

function TagMenu({
  tag,
  graphId,
  open,
  onOpenChange,
  onCustomize,
}: {
  tag: TagSnapshot;
  graphId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCustomize: (anchor: HTMLElement) => void;
}) {
  const { repositoryId = LOCAL_REPOSITORY_ID } = useParams();
  const session = useSession();
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const navigate = useNavigate();
  const notify = useNotify();
  const { message } = useI18n();
  const starred = isFavourite(tag);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<"info" | "delete" | null>(null);

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            size="icon"
            aria-label={message("tags.actions")}
            data-testid="tag-actions-trigger"
          >
            <MoreHorizontalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!readonly && (
            <>
              <DropdownMenuItem
                data-testid="menu-tag-favourite"
                onSelect={() => {
                  const owner = { kind: "tag", tag_id: tag.id } as const;
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
                    .catch((error: unknown) =>
                      notify.failure(message("failure.customizeTag", { name: tag.name }), error),
                    );
                }}
              >
                {starred ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
                {message(starred ? "favourites.remove" : "favourites.add")}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="menu-tag-customize"
                onSelect={() => {
                  const trigger = triggerRef.current;
                  if (trigger) requestAnimationFrame(() => onCustomize(trigger));
                }}
              >
                <Settings2Icon aria-hidden />
                {message("tags.customize")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem data-testid="menu-tag-info" onSelect={() => setDialog("info")}>
            <InfoIcon aria-hidden />
            {message("tags.info")}
          </DropdownMenuItem>
          {!readonly && (
            <>
              <EntityKindMenuItem id={tag.id} kind="page" />
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
          returnFocus={() => triggerRef.current}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await session.execute({ type: "delete_tag", tag_id: tag.id });
            navigate(graphPath(repositoryId, graphId, "tags"));
          }}
          onConfirmError={(error) =>
            notify.failure(message("failure.deleteTag", { name: tag.name }), error)
          }
        >
          {message("tags.deleteConfirm", { name: tag.name })}
        </ConfirmDialog>
      )}
    </>
  );
}

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
              void writeClipboardText(tag.id).then(
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
