import { normalizeAdminDashboardPath } from "../admin/dashboard-routes";
import { ADMIN_SHELL_HTML } from "./admin-shell-template";
import type { FeatureFlags } from "./features";
import { htmlResponse } from "../http/html-response";

export interface AdminShellUserProfile {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderAdminShell(
  authenticated = false,
  initialPath = "/admin",
  initialSearch = "",
  pageTitle?: string,
  userProfile?: AdminShellUserProfile | null,
  features?: Pick<FeatureFlags, "playstationLink">,
  workerVersion?: string,
): Response {
  const styleNonce = crypto.randomUUID().replaceAll("-", "");
  const attributes = [
    authenticated ? 'data-authenticated="true"' : "",
    features?.playstationLink === false ? 'data-playstation-link-enabled="false"' : "",
    `data-csp-style-nonce="${styleNonce}"`,
    `data-initial-path="${escapeHtmlAttribute(initialPath)}"`,
    `data-initial-search="${escapeHtmlAttribute(initialSearch)}"`,
    userProfile?.name ? `data-user-name="${escapeHtmlAttribute(userProfile.name)}"` : "",
    userProfile?.email ? `data-user-email="${escapeHtmlAttribute(userProfile.email)}"` : "",
    userProfile?.image ? `data-user-image="${escapeHtmlAttribute(userProfile.image)}"` : "",
    workerVersion ? `data-worker-version="${escapeHtmlAttribute(workerVersion)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  let html = ADMIN_SHELL_HTML.replace(
    '<div id="admin-root"></div>',
    `<div id="admin-root" ${attributes}></div>`,
  );
  if (pageTitle) {
    html = html.replace("<title>Admin</title>", `<title>${escapeHtmlAttribute(pageTitle)}</title>`);
  }
  return htmlResponse({ profile: "admin", html, styleNonce });
}

export function getAdminLoginLocation(pathnameAndSearch: string): string {
  const url = new URL(pathnameAndSearch, "https://admin.hafbot.invalid");
  const normalizedPath = normalizeAdminDashboardPath(url.pathname);
  if (normalizedPath === "/admin") {
    return "/admin/login";
  }

  return `/admin/login?next=${encodeURIComponent(`${normalizedPath}${url.search}`)}`;
}

export function redirect(location: string, headersInit?: HeadersInit): Response {
  const headers = new Headers(headersInit);
  headers.set("location", location);
  return new Response(null, { status: 302, headers });
}
