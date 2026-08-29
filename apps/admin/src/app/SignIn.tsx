// The one screen with no session.

import { useState, type FormEvent } from "react";

import { login } from "@/api";
import { useI18n } from "@/i18n";
import { Button } from "@/ui/shadcn/button";
import { Callout, TextField } from "@/ui/components";
import { LogoMark } from "@/ui/brand";
import { LanguageControl, ThemeControl } from "./Appearance";
import { failureMessage, type Session } from "./session";

export function SignIn({
  /** Set when the previous session ended on its own, so the return is explained. */
  expired,
  onSignedIn,
}: {
  expired: boolean;
  onSignedIn: (session: Session) => void;
}) {
  const { message } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(username.trim(), password);
      onSignedIn({ token: result.access_token, username: result.account.username });
    } catch (cause) {
      setError(
        failureMessage(message, cause, {
          400: "signIn.error.credentials",
          401: "signIn.error.credentials",
          403: "signIn.error.credentials",
        }),
      );
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <div className="signin-inner">
        <p className="signin-mark">
          <LogoMark aria-hidden />
          <span>{message("admin.wordmark")}</span>
          <span className="wordmark-role">{message("admin.wordmarkRole")}</span>
        </p>
        <h1>{message("signIn.title")}</h1>
        <p className="signin-lede">{message("signIn.lede")}</p>
        {expired && !error && <Callout tone="neutral">{message("signIn.expired")}</Callout>}
        {error && <Callout>{error}</Callout>}
        <form onSubmit={submit}>
          <TextField
            label={message("signIn.username")}
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            label={message("signIn.password")}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" disabled={busy || !username.trim() || !password}>
            {busy && <span className="spinner" aria-hidden />}
            {busy ? message("signIn.working") : message("signIn.action")}
          </Button>
        </form>
        <div className="signin-foot">
          <ThemeControl />
          <LanguageControl />
        </div>
      </div>
    </main>
  );
}
