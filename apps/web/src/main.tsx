import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { initI18n } from "./i18n/index.ts";

// Applies the stored (or browser-detected) language before the first paint, so
// a non-English user doesn't see English flash past on every load.
initI18n();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
