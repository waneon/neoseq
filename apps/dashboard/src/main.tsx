import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { LocaleProvider, applyInitialDocumentLocale } from "./i18n";
import faviconUrl from "../../../assets/brand/symbol.svg?url&no-inline";
import "./ui/globals.css";

// Module asset resolution works in both Vite development and production builds.
document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = faviconUrl;

applyInitialDocumentLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
