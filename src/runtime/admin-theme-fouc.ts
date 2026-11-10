/**
 * The inline FOUC (flash-of-unstyled-content) script, embedded into the admin
 * shell's `<head>` so it runs synchronously before first paint.
 *
 * Resolution fallback chain: `theme` cookie → `prefers-color-scheme` → dark.
 * The cookie holds the resolved `dark` | `light` value (never `system`), so the
 * Worker can serve the correct class on first paint without media-query access.
 *
 * The `resolveTheme` step mirrors {@link "./theme" `resolveTheme`} and must
 * stay in sync with it. It is kept dependency-free so it can run in a bare
 * browser context (no module system, no bundler).
 */
export const ADMIN_THEME_FOUC_SCRIPT = `(function () {
  function resolveCookieTheme(cookie) {
    var match = /(?:^|; )theme=(dark|light)/.exec(cookie);
    return match ? match[1] : null;
  }
  var stored = resolveCookieTheme(document.cookie);
  var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  function resolveTheme(theme, systemPrefersDark) {
    if (theme === "system") return systemPrefersDark ? "dark" : "light";
    return theme;
  }
  var resolved = stored ? stored : resolveTheme("system", prefersDark);
  var root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(resolved);
  // Backfill the cookie when we resolved from a non-cookie source, so the
  // next server render can paint the right class without waiting for JS.
  // Secure is set only over https, matching the admin app's https-only deploys.
  if (!stored) {
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = "theme=" + resolved + "; Path=/; Max-Age=31536000; SameSite=Lax" + secure;
  }
})();`;
