import { useState } from "react";

/**
 * A folded-or-open flag that survives leaving the tab and restarting the app.
 *
 * Stored as "1"/"0" under `key`. Storage can be missing or refuse (a private
 * window, a locked-down webview), and then it is simply not remembered, which
 * only costs a click next time.
 */
export function useRememberedOpen(key: string, fallback = true): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v !== "0";
    } catch {
      return fallback;
    }
  });
  function toggle() {
    setOpen((v) => {
      try {
        localStorage.setItem(key, v ? "0" : "1");
      } catch {
        // Not remembered.
      }
      return !v;
    });
  }
  return [open, toggle];
}
