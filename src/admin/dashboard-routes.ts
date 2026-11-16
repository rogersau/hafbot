export const ADMIN_GUILD_FEATURE_ROUTES = [
  { id: "automation", path: "/admin/automation", label: "Custom Replies and Schedules" },
  { id: "chat-moderation", path: "/admin/chat-moderation", label: "Chat Moderation" },
  { id: "content-feeds", path: "/admin/content-feeds", label: "Content Feeds" },
  { id: "reputation", path: "/admin/reputation", label: "Reputation" },
  { id: "reaction-roles", path: "/admin/reaction-roles", label: "Reaction Roles" },
  { id: "reaction-rules", path: "/admin/blocklist", label: "Reaction Rules" },
  { id: "timed-roles", path: "/admin/timed-roles", label: "Timed Roles" },
  { id: "tickets", path: "/admin/tickets", label: "Tickets" },
  { id: "managed-messages", path: "/admin/managed-messages", label: "Managed Messages" },
  { id: "commerce", path: "/admin/commerce", label: "Commerce" },
  { id: "marketplace", path: "/admin/marketplace", label: "Marketplace" },
  { id: "lfg", path: "/admin/lfg", label: "LFG" },
  { id: "clans", path: "/admin/clans", label: "Clan Management" },
  { id: "suggestions", path: "/admin/suggestions", label: "Suggestions" },
  { id: "events", path: "/admin/events", label: "Events" },
  { id: "player-count", path: "/admin/playercount", label: "Player Count" },
  { id: "wardogs", path: "/admin/wardogs", label: "WARDOGS targets" },
  { id: "server-levels", path: "/admin/server-levels", label: "Server Levels (Beta)" },
  { id: "player-link", path: "/admin/player-link", label: "Player Link" },
  { id: "evidence-vault", path: "/admin/evidence-vault", label: "Evidence Vault" },
  { id: "image-rules", path: "/admin/image-rules", label: "Image Rules" },
  { id: "bot-defense", path: "/admin/bot-defense", label: "Bot Defense" },
  { id: "mention-protection", path: "/admin/mention-protection", label: "Mention Protection" },
  { id: "member-verification", path: "/admin/member-verification", label: "Member Verification" },
  { id: "guild-audit-log", path: "/admin/audit-log", label: "Guild Audit Log" },
  { id: "webhooks", path: "/admin/webhooks", label: "Webhooks" },
  { id: "ban-cases", path: "/admin/ban-cases", label: "Ban Cases" },
] as const;

export const ADMIN_DASHBOARD_ROUTES = [
  { path: "/admin", label: "Overview" },
  { path: "/admin/billing", label: "Billing" },
  { path: "/admin/troubleshooting", label: "Troubleshooting" },
  { path: "/admin/channel-permissions", label: "Channel Permissions" },
  { path: "/admin/profile", label: "Profile" },
  ...ADMIN_GUILD_FEATURE_ROUTES.map(({ path, label }) => ({ path, label })),
  { path: "/admin/guild-settings", label: "Guild Settings" },
] as const;

const ADMIN_GUIDE_FALLBACK = "https://docs.hafbot.xyz/admin-dashboard";
const ADMIN_GUIDE_BY_ROUTE: Record<string, string> = {
  "/admin/reaction-roles": "https://docs.hafbot.xyz/features/reaction-roles",
  "/admin": ADMIN_GUIDE_FALLBACK,
  "/admin/billing": "https://docs.hafbot.xyz/features/premium-entitlements",
  "/admin/troubleshooting": ADMIN_GUIDE_FALLBACK,
  "/admin/channel-permissions": "https://docs.hafbot.xyz/features/channel-permissions",
  "/admin/profile": ADMIN_GUIDE_FALLBACK,
  "/admin/guild-settings": "https://docs.hafbot.xyz/configuration",
  "/admin/blocklist": "https://docs.hafbot.xyz/features/reaction-rules",
  "/admin/timed-roles": "https://docs.hafbot.xyz/features/timed-roles",
  "/admin/tickets": "https://docs.hafbot.xyz/features/tickets",
  "/admin/managed-messages": "https://docs.hafbot.xyz/features/managed-messages",
  "/admin/commerce": "https://docs.hafbot.xyz/features/commerce",
  "/admin/marketplace": "https://docs.hafbot.xyz/features/marketplace",
  "/admin/lfg": "https://docs.hafbot.xyz/features/lfg",
  "/admin/clans": "https://docs.hafbot.xyz/features/clan-management",
  "/admin/suggestions": "https://docs.hafbot.xyz/features/suggestions",
  "/admin/events": "https://docs.hafbot.xyz/features/events",
  "/admin/playercount": "https://docs.hafbot.xyz/features/player-count",
  "/admin/server-levels": "https://docs.hafbot.xyz/features/server-levels",
  "/admin/player-link": "https://docs.hafbot.xyz/features/player-link",
  "/admin/evidence-vault": "https://docs.hafbot.xyz/features/evidence-vault",
  "/admin/image-rules": "https://docs.hafbot.xyz/features/image-rules",
  "/admin/bot-defense": "https://docs.hafbot.xyz/features/bot-defense",
  "/admin/mention-protection": "https://docs.hafbot.xyz/features/mention-protection",
  "/admin/member-verification": "https://docs.hafbot.xyz/features/member-verification",
  "/admin/audit-log": "https://docs.hafbot.xyz/features/guild-audit-log",
  "/admin/webhooks": "https://docs.hafbot.xyz/features/webhook-proxy",
  "/admin/ban-cases": "https://docs.hafbot.xyz/features/ban-cases",
};

export function getAdminGuideUrl(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/admin";
  const segments = normalizedPath.split("/").filter(Boolean);
  const route =
    segments[0] === "admin" && segments.length >= 3 ? `/admin/${segments[2]}` : normalizedPath;
  return (
    ADMIN_GUIDE_BY_ROUTE[route] ??
    (ADMIN_GUILD_FEATURE_ROUTES.some((feature) => feature.path === route)
      ? `https://docs.hafbot.xyz/features/${route.slice(7)}`
      : ADMIN_GUIDE_FALLBACK)
  );
}

const PAID_ADMIN_FEATURES: Record<string, string> = {
  "/admin/image-rules": "Image Rules",
  "/admin/webhooks": "Webhooks",
  "/admin/ban-cases": "Ban Cases",
  "/admin/events": "Events",
  "/admin/playercount": "Player Count",
  "/admin/server-levels": "Server Levels (Beta)",
};

export function getPaidAdminFeature(path: string): string | null {
  return PAID_ADMIN_FEATURES[path] ?? null;
}

const ADMIN_RESERVED_PATHS = new Set(["login", "logout", "global", "api", "assets"]);
export const ADMIN_GUILD_DASHBOARD_SECTIONS = [
  "automation",
  "chat-moderation",
  "content-feeds",
  "reputation",
  "reaction-roles",
  "blocklist",
  "timed-roles",
  "tickets",
  "managed-messages",
  "commerce",
  "marketplace",
  "lfg",
  "clans",
  "suggestions",
  "events",
  "playercount",
  "wardogs",
  "server-levels",
  "player-link",
  "evidence-vault",
  "image-rules",
  "bot-defense",
  "mention-protection",
  "member-verification",
  "audit-log",
  "webhooks",
  "ban-cases",
  "troubleshooting",
  "channel-permissions",
  "guild-settings",
];
export const ADMIN_GUILD_DASHBOARD_PATHS = ADMIN_GUILD_DASHBOARD_SECTIONS.map(
  (section) => `/admin/${section}`,
);
const ADMIN_GUILD_DASHBOARD_SECTION_SET = new Set(ADMIN_GUILD_DASHBOARD_SECTIONS);
const ADMIN_NON_GUILD_SEGMENTS = new Set([
  "gateway",
  "workspaces",
  ...ADMIN_GUILD_DASHBOARD_SECTION_SET,
]);

export type AdminDashboardPath = string;

export function isAdminDashboardPath(pathname: string): pathname is AdminDashboardPath {
  if (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  if (pathname === "/admin" || pathname === "/admin/billing") {
    return true;
  }

  if (!pathname.startsWith("/admin/")) {
    return false;
  }

  const segments = pathname.slice("/admin/".length).split("/");
  if (segments.some((segment) => !segment)) {
    return false;
  }

  const [guildId, section] = segments;
  if (!guildId || ADMIN_RESERVED_PATHS.has(guildId) || ADMIN_NON_GUILD_SEGMENTS.has(guildId)) {
    return false;
  }

  if (segments.length === 1) {
    return true;
  }

  return segments.length === 2 && !!section && ADMIN_GUILD_DASHBOARD_SECTION_SET.has(section);
}

export function normalizeAdminDashboardPath(pathname: string): AdminDashboardPath {
  return isAdminDashboardPath(pathname) ? pathname : "/admin";
}
