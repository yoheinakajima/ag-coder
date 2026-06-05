import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Dragging the resizable panel dividers fires rapid ResizeObserver callbacks.
// When they run synchronously the browser emits a benign "ResizeObserver loop
// ..." notification as an uncaught ErrorEvent (with no real Error object), which
// trips dev/canvas error overlays into a full-screen crash.
//
// Primary fix: defer ResizeObserver callbacks to the next animation frame, which
// breaks the synchronous loop so the notification is never emitted.
if (typeof window !== "undefined" && "ResizeObserver" in window) {
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => callback(entries, observer));
      });
    }
  };
}

// Backup: if the notification still surfaces, swallow only that specific benign
// error so it can't reach the error overlay.
const RESIZE_OBSERVER_ERROR = /ResizeObserver loop (limit exceeded|completed)/;
window.addEventListener(
  "error",
  (event) => {
    if (event.message && RESIZE_OBSERVER_ERROR.test(event.message)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  },
  true,
);

createRoot(document.getElementById("root")!).render(<App />);
