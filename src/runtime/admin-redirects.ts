import { normalizeAdminDashboardPath } from "../admin/dashboard-routes";

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
