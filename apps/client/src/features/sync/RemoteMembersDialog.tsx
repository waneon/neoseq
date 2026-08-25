import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { RemoteGraphConnection } from "../../core-port/directory";
import { useI18n } from "../../i18n";
import { Callout, Dialog } from "../../ui/components";
import { MenuSelect } from "../../ui/menu-select";
import { Input } from "@/ui/shadcn/input";
import { Button } from "@/ui/shadcn/button";
import {
  grantMembership,
  listMemberships,
  revokeMembership,
  type RemoteGraphMembership,
} from "./api";
import { readAuthSession, writeAuthSession } from "./auth";
import type { AsyncRequestState } from "../../lib/async";

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
  const [request, setRequest] = useState<AsyncRequestState>({ status: "idle" });
  const busy = request.status === "busy";

  const refresh = useCallback(
    async (auth = readAuthSession(connection.server_url)) => {
      if (!auth) return;
      setRequest({ status: "busy" });
      try {
        setMembers((await listMemberships(connection.server_url, auth, graphId)).memberships);
        setRequest({ status: "idle" });
      } catch {
        // Each verb reports its own failure — a rejected invite is not a
        // network outage, and the sentence names what the user actually tried.
        setRequest({ status: "failed", message: message("graph.membersLoadFailed") });
      }
    },
    [connection.server_url, graphId, message],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    const account = invite.trim();
    setRequest({ status: "busy" });
    grantMembership(connection.server_url, auth, graphId, account, role)
      .then(() => {
        setInvite("");
        return refresh(auth);
      })
      .catch(() => {
        setRequest({
          status: "failed",
          message: message("graph.inviteFailed", { account }),
        });
      });
  };

  return (
    <Dialog title={message("graph.membersTitle")} onClose={onClose}>
      <p className="dialog-lede">{message("graph.membersDetail")}</p>
      {request.status === "failed" && <Callout tone="danger">{request.message}</Callout>}
      <form className="remote-account-form" onSubmit={saveAccount}>
        <label className="field-label" htmlFor="member-account-principal">{message("graph.principal")}</label>
        <Input id="member-account-principal" autoComplete="username" value={principal} onChange={(event) => setPrincipal(event.target.value)} />
        <label className="field-label" htmlFor="member-account-token">{message("graph.token")}</label>
        <div className="remote-account-row">
          <Input id="member-account-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} />
          <Button variant="secondary" type="submit" disabled={!principal.trim() || !token.trim() || busy}>{message("graph.signIn")}</Button>
        </div>
      </form>
      <ul className="member-list" aria-busy={busy}>
        {members.map((member) => (
          <li key={member.principal_id}>
            {/* An account id is an identifier, not prose — it takes the mono
                voice, and the role sits under it in the metadata voice. */}
            <span className="member-id">
              <span className="mono">{member.principal_id}</span>
              <small>{message(`graph.${member.role}`)}</small>
            </span>
            {member.role !== "owner" && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const auth = readAuthSession(connection.server_url);
                  if (!auth) return;
                  setRequest({ status: "busy" });
                  void revokeMembership(connection.server_url, auth, graphId, member.principal_id)
                    .then(() => refresh(auth))
                    .catch(() => {
                      setRequest({
                        status: "failed",
                        message: message("graph.revokeFailed", {
                          account: member.principal_id,
                        }),
                      });
                    });
                }}
              >
                {message("graph.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form className="member-invite" onSubmit={inviteMember}>
        {/* The sibling fields above carry visible labels; a placeholder-only
            field would be the one that goes silent the moment it is typed in. */}
        <label className="field-label" htmlFor="member-invite-account">
          {message("graph.memberAccount")}
        </label>
        <div className="member-invite-row">
          <Input id="member-invite-account" value={invite} onChange={(event) => setInvite(event.target.value)} />
          {/* The one dropdown — never a native <select>, whose popup the OS
              draws in its own language. See designs/interaction.md § Choice. */}
          <MenuSelect
            value={role}
            options={[
              { value: "editor", label: message("graph.editor") },
              { value: "viewer", label: message("graph.viewer") },
            ]}
            onValueChange={(value) => setRole(value as "editor" | "viewer")}
            label={message("graph.memberRole")}
          />
          <Button type="submit" disabled={busy || !invite.trim()}>{message("graph.invite")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
