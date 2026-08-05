// The notification layer's one entry point.
//
// Mounted above the router so a toast survives navigation and reaches the graph
// picker as well as the shell. Consumers get a working no-op default rather than
// a thrown error, which is what lets a feature be mounted bare in a test.

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

const SILENT: Notifier = {
  show: () => "",
  dismiss: () => {},
  failure: () => null,
};

const NotifyContext = createContext<Notifier>(SILENT);

export function useNotify(): Notifier {
  return useContext(NotifyContext);
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
