import { Link, useParams } from "react-router";
import { documentTitle, sameHeaders } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";
import { graphPath } from "../graphs/routing";
import { useSessionSelector } from "./session-context";

/** Documents that came to share a name through a merge, each by its own title. */
export function DocumentNameConflicts() {
  const snapshot = useSessionSelector((state) => state.snapshot, sameHeaders);
  const { repositoryId = LOCAL_REPOSITORY_ID, graphId = "" } = useParams();
  const { message } = useI18n();
  const conflicts = snapshot.conflicts.flatMap((conflict) => {
    if (conflict.kind === "duplicate_entity_name")
      return [{ key: conflict.canonical_name, ids: conflict.entity_ids }];
    return [];
  });
  if (!conflicts.length) return null;
  return (
    <aside className="document-name-conflicts" role="status" data-testid="document-name-conflicts">
      <p>{message("entity.nameConflicts")}</p>
      {conflicts.map((conflict) => (
        <p key={conflict.key}>
          {conflict.ids.map((id, index) => {
            const tag = snapshot.tags.some((tag) => tag.id === id);
            return (
              <span key={id}>
                {index > 0 ? " · " : ""}
                <Link to={graphPath(repositoryId, graphId, `${tag ? "t" : "p"}/${id}`)}>
                  {tag ? "#" : ""}
                  {documentTitle(snapshot, id)} ({message(tag ? "common.tag" : "common.page")})
                </Link>
              </span>
            );
          })}
        </p>
      ))}
    </aside>
  );
}
