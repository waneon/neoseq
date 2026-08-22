// The graph's tags, as a directory.
//
// Now that a tag has a page, this screen has one job and stops doing the other:
// it is the index — every tag in the graph, what each one copies onto a block,
// and the one place a tag comes into existence. Editing a tag is the tag's own
// page, the way editing a page is the page's, so a default has exactly one
// writing surface and a name has exactly one field. Before this the card here
// was both a listing and an editor, which is why the same defaults could be
// changed from two places and neither one was where the tag actually lived.

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { PlusIcon } from "lucide-react";
import type { TagSnapshot } from "../../core-port/snapshot";
import { canonicalEntityName } from "../../entities/names";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { Input } from "@/ui/shadcn/input";
import { TagDefaults } from "./TagDefaults";

export function TagsView() {
  const state = useSessionState();
  const { message, compare } = useI18n();
  const readonly = state.mode === "readonly";

  const tags = [...state.snapshot.tags].sort((left, right) => compare(left.name, right.name));

  return (
    <div className="page-scroll">
      <article className="page-body enter-fade-view">
        <div className="title-row">
          <h1>{message("tags.title")}</h1>
        </div>
        <p className="tags-hint">{message("tags.hint")}</p>
        {readonly && tags.length === 0 ? (
          <p className="tags-empty" data-testid="tags-empty">
            {message("tags.empty")}
          </p>
        ) : (
          <ul className="tag-grid" data-testid="tag-list">
            {tags.map((tag) => (
              <TagCard key={tag.id} tag={tag} />
            ))}
            {!readonly && <NewTagCard existing={tags} />}
          </ul>
        )}
      </article>
    </div>
  );
}

/**
 * One tag, as a way in. The whole card is the link — a card that opens somewhere
 * and also holds controls of its own is a card whose press means two things —
 * and the defaults inside it are a reading, not a row of buttons.
 */
function TagCard({ tag }: { tag: TagSnapshot }) {
  const { graphId = "" } = useParams();
  return (
    <li className="tag-card-slot">
      <Link className="tag-card" to={`/g/${graphId}/t/${tag.id}`} data-testid="tag-card">
        <span className="tag-card-name">
          <span className="hash" aria-hidden>
            #
          </span>
          {tag.name}
        </span>
        <TagDefaults tag={tag} />
      </Link>
    </li>
  );
}

/**
 * The create card — the one place a tag comes into existence. At rest it is a
 * quiet ringed card with a plus; pressed, it becomes an inline name field.
 * `⏎` creates and keeps the field open for the next name; `Esc` or leaving
 * the field closes it without creating anything.
 */
function NewTagCard({ existing }: { existing: TagSnapshot[] }) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    const canonical = canonicalEntityName(name);
    if (existing.some((tag) => canonicalEntityName(tag.name) === canonical)) {
      notify.show({
        tone: "info",
        key: "tag-duplicate",
        title: message("tags.duplicate", { name }),
      });
      return;
    }
    try {
      await session.execute({
        type: "ensure_tag",
        tag_id: `t-${crypto.randomUUID()}`,
        name,
      });
      setDraft("");
      inputRef.current?.focus();
    } catch (error) {
      notify.failure(message("failure.createEntity", { name }), error);
    }
  };

  if (!editing) {
    return (
      <li className="tag-card-new-slot">
        <button
          type="button"
          className="tag-card-new"
          data-testid="tag-card-new"
          onClick={() => setEditing(true)}
        >
          <PlusIcon aria-hidden />
          {message("tags.new")}
        </button>
      </li>
    );
  }

  return (
    <li className="tag-card-slot">
      <div className="tag-card tag-card-editing">
        <span className="tag-card-name">
          <span className="hash" aria-hidden>
            #
          </span>
        </span>
        <Input
          ref={inputRef}
          aria-label={message("tags.new")}
          placeholder={message("tags.namePlaceholder")}
          data-testid="new-tag-name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            setDraft("");
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void create();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
              setDraft("");
            }
          }}
        />
      </div>
    </li>
  );
}
