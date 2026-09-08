import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { applyInitialDocumentLocale } from "./i18n";
import { trackOverlayFocusInput } from "./ui/overlay-focus";
import { trackVisualViewport } from "./ui/visual-viewport";
import faviconUrl from "../../../assets/brand/symbol.svg?url&no-inline";
import "./ui/globals.css";

// Module asset resolution works in both Vite development and production builds.
document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = faviconUrl;

applyInitialDocumentLocale();
const stopTrackingFocus = trackOverlayFocusInput(document);
const stopTrackingViewport = trackVisualViewport(window);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopTrackingFocus();
    stopTrackingViewport();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The Service Worker caches the application shell only; canonical graph
// data stays in the Worker-owned IndexedDB repository.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
