import type { MessageFunction } from "@/i18n";
import { ApiError } from "@/api";

/**
 * An administrative session, and everything this app remembers about being
 * signed in.
 *
 * It lives in React state and nowhere else. Reloading or closing the app returns
 * the operator to sign-in rather than leaving administrative authority in Web
 * storage (designs/server-administration.md § Invariants), so there is no
 * persistence layer here to keep honest.
 */
export interface Session {
  readonly token: string;
  readonly username: string;
}

/**
 * The refusals a surface expects, keyed by the status that carries them.
 *
 * A 409 means two entirely different things depending on who asked — an account
 * that already exists, or the last administrator being protected — and the
 * server distinguishes them only in prose. The surface that made the request is
 * the one thing that already knows which of the two it could possibly be, so the
 * mapping belongs to it rather than to a shared table of guesses.
 */
export type RefusalKey =
  | "create.error.duplicate"
  | "create.error.invalid"
  | "error.lastAdmin"
  | "reset.error.invalid"
  | "signIn.error.credentials";

export function failureMessage(
  message: MessageFunction,
  cause: unknown,
  refusals: Readonly<Partial<Record<number, RefusalKey>>> = {},
): string {
  if (!(cause instanceof ApiError)) return message("error.generic");
  // 0 is a request that never left; 502-504 is one that reached something in
  // front of the sync server and got no further. Both are "not reachable", and
  // reporting the second as a generic refusal sends an operator looking for a
  // mistake they did not make.
  if (cause.status === 0 || (cause.status >= 502 && cause.status <= 504)) {
    return message("error.unreachable");
  }
  const refusal = refusals[cause.status];
  return refusal ? message(refusal) : message("error.generic");
}

/**
 * Runs one administrative operation and re-reads the directory from the server.
 *
 * It resolves only once the new state has actually been read back, so a surface
 * that awaits it can stay pending until its own result is on screen — no
 * optimistic copy is kept anywhere. It rejects with the original cause so the
 * surface that started the work is the one that reports the failure; an expired
 * session is the exception, because that is a fact about the whole app rather
 * than about the request, and it resolves after returning the operator to
 * sign-in.
 */
export type Perform = (operation: () => Promise<unknown>) => Promise<void>;
