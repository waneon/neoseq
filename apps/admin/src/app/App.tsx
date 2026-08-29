import { useCallback, useState } from "react";

import { Console } from "./Console";
import { SignIn } from "./SignIn";
import type { Session } from "./session";

/**
 * Two surfaces and one fact between them: whether there is a session.
 *
 * The session lives here and nowhere else — no storage, no context, no module
 * variable — so closing or reloading the app returns the operator to sign-in.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [expired, setExpired] = useState(false);

  const signOut = useCallback((reason: "operator" | "expired") => {
    setSession(null);
    setExpired(reason === "expired");
  }, []);

  return session ? (
    <Console session={session} onSignOut={signOut} />
  ) : (
    <SignIn
      expired={expired}
      onSignedIn={(next) => {
        setSession(next);
        setExpired(false);
      }}
    />
  );
}
