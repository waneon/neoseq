import { useEffect, useState, type FormEvent } from "react";
import type { RemoteGraphConnection } from "../../core-port/directory";
import { useI18n } from "../../i18n";
import { Callout, Dialog } from "../../ui/components";
import { Input } from "@/ui/shadcn/input";
import {
  grantMembership,
  listMemberships,
  revokeMembership,
  type RemoteGraphMembership,
} from "./api";
import { readAuthSession, writeAuthSession } from "./auth";

export function RemoteMembersDialog({
  graphId,
  connection,
  onClose,
}: {
  graphId: string;
  connection: RemoteGraphConnection;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const stored = readAuthSession(connection.server_url);
  const [principal, setPrincipal] = useState(stored?.principal ?? "");
  const [token, setToken] = useState(stored?.token ?? "");
  const [members, setMembers] = useState<RemoteGraphMembership[]>([]);
  const [invite, setInvite] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (auth = readAuthSession(connection.server_url)) => {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      setMembers((await listMemberships(connection.server_url, auth, graphId)).memberships);
    } catch {
      setError(message("graph.remoteFailed"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // The dialog represents one graph opening; refresh is intentionally not a
    // dependency because its identity carries transient form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  const saveAccount = (event: FormEvent) => {
    event.preventDefault();
    const auth = { principal: principal.trim(), token: token.trim() };
    writeAuthSession(connection.server_url, auth);
    void refresh(auth);
  };

  const inviteMember = (event: FormEvent) => {
    event.preventDefault();
    const auth = readAuthSession(connection.server_url);
    if (!auth || !invite.trim()) return;
    setBusy(true);
    grantMembership(connection.server_url, auth, graphId, invite.trim(), role)
      .then(() => {
        setInvite("");
        return refresh(auth);
      })
      .catch(() => {
        setBusy(false);
        setError(message("graph.remoteFailed"));
      });
  };

  return (
    <Dialog title={message("graph.membersTitle")} onClose={onClose}>
      <p className="dialog-lede">{message("graph.membersDetail")}</p>
      {error && <Callout tone="danger">{error}</Callout>}
      <form className="remote-account-form" onSubmit={saveAccount}>
        <label className="field-label" htmlFor="member-account-principal">{message("graph.principal")}</label>
        <Input id="member-account-principal" autoComplete="username" value={principal} onChange={(event) => setPrincipal(event.target.value)} />
        <label className="field-label" htmlFor="member-account-token">{message("graph.token")}</label>
        <div className="remote-account-row">
          <Input id="member-account-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} />
          <button className="btn" type="submit" disabled={!principal.trim() || !token.trim() || busy}>{message("common.retryShort")}</button>
        </div>
      </form>
      <ul className="member-list" aria-busy={busy}>
        {members.map((member) => (
          <li key={member.principal_id}>
            <span><strong>{member.principal_id}</strong><small>{message(`graph.${member.role}`)}</small></span>
            {member.role !== "owner" && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const auth = readAuthSession(connection.server_url);
                  if (!auth) return;
                  setBusy(true);
                  void revokeMembership(connection.server_url, auth, graphId, member.principal_id)
                    .then(() => refresh(auth))
                    .catch(() => {
                      setBusy(false);
                      setError(message("graph.remoteFailed"));
                    });
                }}
              >
                {message("graph.revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="member-invite" onSubmit={inviteMember}>
        <Input aria-label={message("graph.memberAccount")} placeholder={message("graph.memberAccount")} value={invite} onChange={(event) => setInvite(event.target.value)} />
        <select aria-label={message("graph.memberRole")} value={role} onChange={(event) => setRole(event.target.value as "editor" | "viewer")}>
          <option value="editor">{message("graph.editor")}</option>
          <option value="viewer">{message("graph.viewer")}</option>
        </select>
        <button className="btn btn-primary" type="submit" disabled={busy || !invite.trim()}>{message("graph.invite")}</button>
      </form>
    </Dialog>
  );
}
