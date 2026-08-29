import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { LocaleProvider, applyInitialDocumentLocale } from "./i18n";
import "./ui/globals.css";

applyInitialDocumentLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
