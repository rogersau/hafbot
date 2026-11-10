import type { AdminGuildDirectoryEntry } from "../../runtime/admin-types";
import { normalizeAdminDashboardPath } from "../dashboard-routes";
import {
  buildAdminDashboardHref,
  encodeGuildIdForSearch,
  getSelectedGuildIdFromPath,
  getSelectedGuildIdFromSearch,
  getSelectedWorkspaceIdFromSearch,
} from "./dashboard-urls";

export type ReactionRulesTab = "blocklist" | "limits";
export type PlayerLinkPlatform = "steam" | "xbox" | "playstation";
export type TicketsTab = "setup" | "panel" | "types" | "rules" | "history" | "closed";
export type CommerceTab = "offerings" | "storefront" | "support" | "seller" | "safety";

export interface AdminRouteState {
  currentPath: string;
  pathGuildId: string;
  selectedGuildId: string;
  selectedWorkspaceId: string;
  reactionRulesTab: ReactionRulesTab;
  playerLinkPlatform: PlayerLinkPlatform;
  ticketsTab: TicketsTab;
  commerceTab: CommerceTab;
}

export function getAdminRouteState({
  pathname,
  search,
}: {
  pathname: string;
  search: string;
}): AdminRouteState {
  const currentPath = normalizeAdminDashboardPath(pathname);
  const pathGuildId = getSelectedGuildIdFromPath(currentPath);

  return {
    currentPath,
    pathGuildId,
    selectedGuildId: pathGuildId || getSelectedGuildIdFromSearch(search),
    selectedWorkspaceId: getSelectedWorkspaceIdFromSearch(search),
    reactionRulesTab: getReactionRulesTabFromSearch(search),
    playerLinkPlatform: getPlayerLinkPlatformFromSearch(search),
    ticketsTab: getTicketsTabFromSearch(search),
    commerceTab: getCommerceTabFromSearch(search),
  };
}

export function getDefaultAdminRedirectTarget({
  currentPath,
  search,
  selectedWorkspaceId,
  selectedGuildId,
  guildDirectory,
  defaultGuildId,
  hiddenGuildIds,
  preferencesLoading,
  lastUsedGuildId,
}: {
  currentPath: string;
  search: string;
  selectedWorkspaceId: string;
  selectedGuildId: string;
  guildDirectory: AdminGuildDirectoryEntry[] | null;
  defaultGuildId: string | null;
  hiddenGuildIds: string[];
  preferencesLoading: boolean;
  lastUsedGuildId: string | null;
}): string | null {
  if (selectedGuildId) return null;
  if (preferencesLoading || !guildDirectory) return null;

  const visibleGuilds = guildDirectory.filter((guild) => !hiddenGuildIds.includes(guild.guildId));
  if (visibleGuilds.length === 0) return null;

  const defaultExists =
    defaultGuildId && visibleGuilds.some((guild) => guild.guildId === defaultGuildId);
  const lastUsedExists =
    lastUsedGuildId && visibleGuilds.some((guild) => guild.guildId === lastUsedGuildId);
  const fallbackGuildId = defaultExists
    ? defaultGuildId
    : lastUsedExists
      ? lastUsedGuildId
      : visibleGuilds[0]!.guildId;

  if (currentPath === "/admin/billing") {
    return setSearchParam(currentPath, search, "guildId", encodeGuildIdForSearch(fallbackGuildId));
  }
  return buildAdminDashboardHref(currentPath, selectedWorkspaceId, fallbackGuildId);
}

export function buildReactionRulesTabHref(href: string, tab: ReactionRulesTab): string {
  const [pathnameAndSearch = ""] = href.split("#");
  const [pathname = "", search = ""] = pathnameAndSearch.split("?");
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getReactionRulesTabFromSearch(search: string): ReactionRulesTab {
  return new URLSearchParams(search).get("tab") === "limits" ? "limits" : "blocklist";
}

export function getTicketsTabFromSearch(search: string): TicketsTab {
  const tab = new URLSearchParams(search).get("tab");
  if (
    tab === "setup" ||
    tab === "types" ||
    tab === "rules" ||
    tab === "history" ||
    tab === "closed"
  )
    return tab;
  return "panel";
}

export function buildTicketsTabHref(href: string, tab: TicketsTab): string {
  const [pathnameAndSearch = ""] = href.split("#");
  const [pathname = "", search = ""] = pathnameAndSearch.split("?");
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getCommerceTabFromSearch(search: string): CommerceTab {
  const tab = new URLSearchParams(search).get("tab");
  if (tab === "storefront" || tab === "support" || tab === "seller" || tab === "safety") {
    return tab;
  }
  return "offerings";
}

export function buildCommerceTabHref(href: string, tab: CommerceTab): string {
  const [pathnameAndSearch = ""] = href.split("#");
  const [pathname = "", search = ""] = pathnameAndSearch.split("?");
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildPlayerLinkPlatformHref(href: string, platform: PlayerLinkPlatform): string {
  const [pathnameAndSearch = ""] = href.split("#");
  const [pathname = "", search = ""] = pathnameAndSearch.split("?");
  const params = new URLSearchParams(search);
  params.set("platform", platform);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getPlayerLinkPlatformFromSearch(search: string): PlayerLinkPlatform {
  const platform = new URLSearchParams(search).get("platform");
  return platform === "xbox" || platform === "playstation" ? platform : "steam";
}

function setSearchParam(pathname: string, search: string, key: string, value: string) {
  const params = new URLSearchParams(search);
  params.set(key, value);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
