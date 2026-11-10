import { useEffect, useState } from "react";

const SERVER_FALLBACK_MATCHES: Record<string, boolean> = {
  // SSR / test rendering assumes the desktop (md+) layout, matching the
  // `hidden md:block` / `block md:hidden` conventions elsewhere in the shell.
  "(min-width: 768px)": true,
};

/**
 * Subscribes to a `window.matchMedia` query and re-renders when it changes.
 *
 * Returns the SSR fallback (`true` for the desktop media query) during the
 * first render on the server and the initial client render, then synchronizes
 * to the live media query afterwards. Pass a `getServerSnapshot`-style
 * default via `fallback` when a different initial value is desired.
 */
export function useMediaQuery(query: string, fallback?: boolean): boolean {
  const initialValue =
    fallback ?? (query in SERVER_FALLBACK_MATCHES ? SERVER_FALLBACK_MATCHES[query] : false);
  const [matches, setMatches] = useState(initialValue);

  // eslint-disable-next-line custom/no-use-effect -- Synchronizes a media query with React state.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mediaQueryList = window.matchMedia(query);
    setMatches(mediaQueryList.matches);

    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}
