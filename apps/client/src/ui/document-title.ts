import { useEffect } from "react";
import { useI18n } from "../i18n";

/** Names the browser tab after the document it shows, so tabs and history tell pages apart. */
export function useDocumentTitle(name: string | null): void {
  const { message } = useI18n();
  useEffect(() => {
    const app = message("app.title");
    document.title = name ? `${name} – ${app}` : app;
    return () => {
      document.title = app;
    };
  }, [message, name]);
}
