// The notification layer's one entry point.
//
// Mounted above the router so a toast survives navigation and reaches the graph
// picker as well as the shell. A missing provider is a broken application
// boundary, so consumers fail immediately instead of silently swallowing the
// error the notification was meant to surface.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { failureToast } from "./errors";
import { Toaster } from "./Toaster";
import { ToastStore, type ToastAction, type ToastInput } from "./store";
import { useI18n } from "../../i18n";

export interface Notifier {
  show(input: ToastInput): string;
  dismiss(id: string): void;
  /**
   * Reports a rejected core command. `summary` names the verb from the user's
   * side ("Couldn't move that block"); the core's own message becomes the
   * reason beneath it.
   *
   * Returns `null` when another surface already owns the failure — today that
   * is durability, which belongs to the save slot.
   */
  failure(summary: string, error: unknown, retry?: ToastAction): string | null;
}

const NotifyContext = createContext<Notifier | null>(null);

export function useNotify(): Notifier {
  const notifier = useContext(NotifyContext);
  if (!notifier) throw new Error("useNotify must be used within NotifyProvider");
  return notifier;
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { message } = useI18n();
  const store = useMemo(() => new ToastStore(), []);
  const notifier = useMemo<Notifier>(
    () => ({
      show: store.show,
      dismiss: store.dismiss,
      failure: (summary, error, retry) => {
        const input = failureToast(summary, error, message);
        if (!input) return null;
        return store.show(retry ? { ...input, action: retry } : input);
      },
    }),
    [message, store],
  );

  return (
    <NotifyContext.Provider value={notifier}>
      {children}
      <Toaster store={store} />
    </NotifyContext.Provider>
  );
}
