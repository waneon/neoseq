// A credential reset. The password is write-only: it replaces the verifier, is
// never displayed afterward, and ends the account's existing sessions — which is
// why the dialog says so before it asks for one.

import { useState, type FormEvent } from "react";

import { resetPassword, type Account } from "@/api";
import { useI18n } from "@/i18n";
import { Button } from "@/ui/shadcn/button";
import { DialogSurface } from "@/ui/shadcn/dialog";
import { Callout, TextField } from "@/ui/components";
import { failureMessage, type Perform } from "./session";

export function ResetPassword({
  account,
  token,
  perform,
  onClose,
}: {
  account: Account;
  token: string;
  perform: Perform;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await perform(() => resetPassword(token, account.account_id, password));
      onClose();
    } catch (cause) {
      setError(failureMessage(message, cause, { 400: "reset.error.invalid" }));
      setBusy(false);
    }
  };

  // Rendered only while open; React Aria owns the focus trap and the return of
  // focus to the control that summoned this.
  return (
    <DialogSurface
      title={message("reset.title", { username: account.username })}
      description={message("reset.body", { username: account.username })}
      dismissible={!busy}
      closeLabel={message("confirm.cancel")}
      onClose={onClose}
    >
      {error && <Callout>{error}</Callout>}
      <form className="grid gap-4" onSubmit={submit}>
        <TextField
          label={message("reset.newPassword")}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="dialog-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {message("confirm.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <span className="spinner" aria-hidden />}
            {busy ? message("reset.working") : message("reset.action")}
          </Button>
        </div>
      </form>
    </DialogSurface>
  );
}
