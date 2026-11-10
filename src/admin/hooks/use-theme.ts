import { useEffect } from "react";

import { resolveTheme } from "../../runtime/theme";
import type { UserPreferencesTheme } from "../../runtime/admin-types";

const THEME_COOKIE_NAME = "theme";
const THEME_COOKIE_MAX_AGE = 31536000; // one year

function writeThemeCookie(resolved: "dark" | "light") {
  const secure =
    typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE_NAME}=${resolved}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

function applyThemeClass(resolved: "dark" | "light") {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(resolved);
}

/**
 * Keeps the `<html>` theme class and the `theme` cookie in sync with the user's
 * theme preference. On mount and on every `theme` change it resolves the theme
 * via {@link resolveTheme} and writes the result to both the document and the
 * cookie. While the user is in `system` mode it also subscribes to OS theme
 * changes so the dashboard follows them live.
 *
 * Lives in a `.ts` hook (not `.tsx`) by repo convention: the FOUC script owns
 * first paint, and this owns runtime reactivity.
 */
export function useTheme(theme: UserPreferencesTheme): void {
  useEffect(() => {
    const media =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;

    const systemPrefersDark = media ? media.matches : true;
    const resolved = resolveTheme(theme, systemPrefersDark);
    applyThemeClass(resolved);
    writeThemeCookie(resolved);

    if (theme !== "system" || !media) return;

    const onChange = (event: MediaQueryListEvent) => {
      const next = resolveTheme("system", event.matches);
      applyThemeClass(next);
      writeThemeCookie(next);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [theme]);
}
