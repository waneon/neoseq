import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./ui/app.css";

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
