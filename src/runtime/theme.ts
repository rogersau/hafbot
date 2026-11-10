import type { UserPreferencesTheme } from "./admin-types";

/**
 * The concrete theme applied to the document. Exactly one of `.dark` or
 * `.light` is present on `<html>` whenever the admin SPA is loaded.
 */
export type ResolvedTheme = "dark" | "light";

/**
 * Resolve a user's theme preference to the concrete class applied to `<html>`.
 *
 * This is the single source of truth for theme resolution: the inline FOUC
 * script (see {@link "./admin-theme-fouc" `ADMIN_THEME_FOUC_SCRIPT`}) and the
 * React `<ThemeProvider>` both call it, so first-paint behaviour and runtime
 * behaviour cannot disagree.
 */
export function resolveTheme(
  theme: UserPreferencesTheme,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}
