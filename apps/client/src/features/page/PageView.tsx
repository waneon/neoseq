import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { PageSnapshot } from "../../core-port/snapshot";
import { findPage, pageKind, pageTitle } from "../../core-port/snapshot";
import { Outliner } from "../outline/Outliner";
import { PropertyBagEditor } from "../properties/PropertyBagEditor";
import { useSession, useSessionState } from "../shell/session-context";

export function PageView() {
  const { graphId = "", pageId = "" } = useParams();
  const state = useSessionState();
  const page = findPage(state.snapshot, pageId);

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
          <span style={{ display: "inline-flex", flexDirection: "column", gap: 8 }}>
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
          </span>
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
  header?: ReactNode;
}) {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  return (
    <div className="page-scroll" ref={setScrollElement}>
      <article className="page-body enter-fade" key={page.id}>
        {header ?? (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <EditableTitle page={page} />
            <DeletePageButton page={page} />
          </div>
        )}
        <Outliner page={page} scrollElement={scrollElement} />
        <PropertyBagEditor
          kind="page"
          targetId={page.id}
          bag={page.properties}
          title="Page properties"
        />
        <PropertyBagEditor
          kind="defaults"
          targetId={page.id}
          bag={page.defaults}
          title="Defaults for tagged blocks"
          description="Copied to a block when it is tagged with this page, unless the block already has the key."
        />
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
    return <h1 className="page-title">{authoritative}</h1>;
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
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function DeletePageButton({ page }: { page: PageSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  if (state.mode === "readonly" || pageKind(page) === "journal") return null;
  return (
    <button
      className="btn btn-ghost"
      title="Delete page (soft delete; restorable from its tombstone)"
      data-testid="delete-page"
      onClick={() =>
        void session.execute({ type: "delete_page", page_id: page.id }).catch(() => undefined)
      }
    >
      Delete
    </button>
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
  return (
    <main className="tombstone" data-testid="tombstone">
      <h1>{title}</h1>
      <p>{detail}</p>
      <div className="actions">
        <Link className="btn btn-utility" to={`/g/${graphId}/journal`}>
          Go to journal
        </Link>
        {actions}
      </div>
    </main>
  );
}

