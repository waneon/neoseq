// Creation changes the set being read, so it is bounded and sits above the
// directory rather than inside it (designs/server-administration.md).

import { useId, useState, type FormEvent } from "react";

import { createAccount, type ServerRole } from "@/api";
import { useI18n } from "@/i18n";
import { Button } from "@/ui/shadcn/button";
import { Callout, ChoiceField, TextField } from "@/ui/components";
import { failureMessage, type Perform } from "./session";

export function CreateAccount({ token, perform }: { token: string; perform: Perform }) {
  const { message } = useI18n();
  const heading = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ServerRole>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = username.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !complete) return;
    setBusy(true);
    setError(null);
    try {
      await perform(() =>
        createAccount(token, { username: username.trim(), password, server_role: role }),
      );
      setUsername("");
      setPassword("");
      setRole("user");
    } catch (cause) {
      // A 409 here can only be a name already taken: the last-administrator rule
      // guards changes to existing accounts, and this request makes a new one.
      setError(
        failureMessage(message, cause, {
          400: "create.error.invalid",
          409: "create.error.duplicate",
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel create-panel" aria-labelledby={heading}>
      <header>
        <h2 id={heading}>{message("create.title")}</h2>
        <p>{message("create.lede")}</p>
      </header>
      {error && <Callout>{error}</Callout>}
      <form className="create-form" onSubmit={submit}>
        <TextField
          label={message("create.username")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="alice"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <TextField
          label={message("create.password")}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <ChoiceField
          label={message("create.role")}
          value={role}
          options={[
            { value: "user", label: message("role.user") },
            { value: "admin", label: message("role.admin") },
          ]}
          onValueChange={(value) => setRole(value as ServerRole)}
        />
        <Button type="submit" disabled={busy || !complete}>
          {busy && <span className="spinner" aria-hidden />}
          {busy ? message("create.working") : message("create.action")}
        </Button>
      </form>
    </section>
  );
}
