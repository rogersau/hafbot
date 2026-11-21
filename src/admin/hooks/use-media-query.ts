import { useMemo, useSyncExternalStore } from "react";

const SERVER_FALLBACK_MATCHES: Record<string, boolean> = {
  "(min-width: 768px)": true,
};

export function useMediaQuery(query: string, fallback?: boolean): boolean {
  const serverMatch =
    fallback ?? (Object.hasOwn(SERVER_FALLBACK_MATCHES, query) && SERVER_FALLBACK_MATCHES[query]);
  const { subscribe, getSnapshot } = useMemo(() => {
    const media = typeof window === "undefined" ? undefined : window.matchMedia?.(query);
    return {
      subscribe(onChange: () => void) {
        media?.addEventListener("change", onChange);
        return () => media?.removeEventListener("change", onChange);
      },
      getSnapshot: () => media?.matches ?? serverMatch,
    };
  }, [query, serverMatch]);

  return useSyncExternalStore(subscribe, getSnapshot, () => serverMatch);
}
