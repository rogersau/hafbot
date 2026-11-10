import { useEffect } from "react";

/**
 * Registers a global keyboard listener for `Cmd+K` / `Ctrl+K` and invokes
 * `onTrigger` when the chord is pressed. Returns nothing; the caller owns
 * the open state.
 */
export function useCommandPaletteShortcut(onTrigger: () => void, enabled = true) {
  // eslint-disable-next-line custom/no-use-effect -- Registers a global Cmd/Ctrl+K listener.
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        onTrigger();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onTrigger, enabled]);
}
