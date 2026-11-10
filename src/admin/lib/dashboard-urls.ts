import {
  ADMIN_GUILD_DASHBOARD_PATHS,
  isAdminDashboardPath,
  normalizeAdminDashboardPath,
} from "../dashboard-routes";
import type { PageDataPolicy } from "../types";

const GUILD_SCOPED_ADMIN_PATHS = new Set(ADMIN_GUILD_DASHBOARD_PATHS);
const NON_GUILD_DASHBOARD_PATHS = new Set(["/admin/billing", "/admin/profile"]);
const GUILD_SEARCH_PREFIX = "guild_";

export function getSelectedGuildIdFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  const value = params.get("guildId")?.trim() ?? "";
  return value.startsWith(GUILD_SEARCH_PREFIX) ? value.slice(GUILD_SEARCH_PREFIX.length) : value;
}

export function encodeGuildIdForSearch(guildId: string): string {
  const normalized = guildId.trim();
  return normalized ? `${GUILD_SEARCH_PREFIX}${normalized}` : "";
}

export function getSelectedGuildIdFromPath(path: string): string {
  const normalizedPath = normalizeAdminDashboardPath(path);
  if (normalizedPath === "/admin" || NON_GUILD_DASHBOARD_PATHS.has(normalizedPath)) {
    return "";
  }

  const [guildId = ""] = normalizedPath.slice("/admin/".length).split("/");
  return decodeURIComponent(guildId).trim();
}

export function getSelectedWorkspaceIdFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  return params.get("workspaceId")?.trim() ?? "";
}

export function buildAdminDashboardHref(
  path: string,
  workspaceId: string,
  guildId: string,
): string {
  const normalizedGuildId = guildId.trim();
  const scopedPath = buildGuildScopedAdminPath(path, normalizedGuildId);
  const params = new URLSearchParams();
  if (workspaceId.trim()) params.set("workspaceId", workspaceId.trim());
  if (normalizeAdminDashboardPath(path) === "/admin/billing" && normalizedGuildId) {
    params.set("guildId", encodeGuildIdForSearch(normalizedGuildId));
  }
  const query = params.toString();
  return query ? `${scopedPath}?${query}` : scopedPath;
}

function buildGuildScopedAdminPath(path: string, guildId: string): string {
  const normalizedPath = normalizeAdminDashboardPath(path);
  const section = getGuildScopedAdminSection(path, normalizedPath);

  if (!guildId) {
    return section || isGuildOverviewPath(normalizedPath) ? "/admin" : path;
  }

  if (section) {
    return `/admin/${encodeURIComponent(guildId)}/${section}`;
  }

  if (path === "/admin" || isGuildOverviewPath(normalizedPath)) {
    return `/admin/${encodeURIComponent(guildId)}`;
  }

  return path;
}

function getGuildScopedAdminSection(path: string, normalizedPath: string): string {
  if (GUILD_SCOPED_ADMIN_PATHS.has(path)) return path.slice("/admin/".length);

  const [, section = ""] = normalizedPath.slice("/admin/".length).split("/");
  return GUILD_SCOPED_ADMIN_PATHS.has(`/admin/${section}`) ? section : "";
}

function isGuildOverviewPath(normalizedPath: string): boolean {
  if (!normalizedPath.startsWith("/admin/")) return false;
  if (normalizedPath === "/admin/billing" || normalizedPath === "/admin/profile") {
    return false;
  }
  return normalizedPath.slice("/admin/".length).split("/").length === 1;
}

export function buildAdminOverviewApiPath(refreshDiscordCache: boolean, workspaceId = ""): string {
  const params = new URLSearchParams();
  if (workspaceId.trim()) params.set("workspaceId", workspaceId.trim());
  if (refreshDiscordCache) params.set("refresh", "1");
  const query = params.toString();
  return query ? `/admin/api/overview?${query}` : "/admin/api/overview";
}

export function buildAdminGuildDirectoryApiPath(
  refreshDiscordCache: boolean,
  workspaceId = "",
): string {
  const params = new URLSearchParams();
  if (workspaceId.trim()) params.set("workspaceId", workspaceId.trim());
  if (refreshDiscordCache) params.set("refresh", "1");
  const query = params.toString();
  return query ? `/admin/api/guilds?${query}` : "/admin/api/guilds";
}

export function appendWorkspaceParam(path: string, workspaceId: string): string {
  const [pathname, search = ""] = path.split("?");
  const params = new URLSearchParams(search);
  if (workspaceId.trim()) params.set("workspaceId", workspaceId.trim());
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getDiscordSignInCallbackUrl(initialSearch: string): string {
  const next = new URLSearchParams(initialSearch).get("next");
  if (!next) return "/admin";
  const url = new URL(next, "https://admin.hafbot.invalid");
  if (url.origin !== "https://admin.hafbot.invalid") return "/admin";
  const normalizedPath = normalizeAdminDashboardPath(url.pathname);
  if (normalizedPath !== url.pathname) return "/admin";
  if (!isAdminDashboardPath(normalizedPath)) return "/admin";
  return `${normalizedPath}${url.search}`;
}

export function getDashboardPageDataPolicy(path: string): PageDataPolicy {
  const currentPath = normalizeAdminDashboardPath(path);

  if (currentPath === "/admin") {
    return {
      loadOverview: true,
      loadGuildDirectory: true,
      monitorGateway: true,
      refreshOverviewAfterGatewayStart: true,
    };
  }

  if (currentPath === "/admin/troubleshooting" || currentPath.endsWith("/troubleshooting")) {
    return {
      loadOverview: false,
      loadGuildDirectory: true,
      monitorGateway: false,
      refreshOverviewAfterGatewayStart: false,
    };
  }

  return {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  };
}
