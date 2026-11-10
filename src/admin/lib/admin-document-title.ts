import type { AdminGuildDirectoryEntry } from "../../runtime/admin-types";
import { ADMIN_DASHBOARD_ROUTES, ADMIN_GUILD_FEATURE_ROUTES } from "../dashboard-routes";

interface AdminDocumentTitleInput {
  authenticated: boolean;
  currentPath: string;
  selectedGuildId: string;
  guildDirectory: AdminGuildDirectoryEntry[] | null;
}

const GUILD_SCOPED_TITLE_PATHS = new Set([
  ...ADMIN_GUILD_FEATURE_ROUTES.map((route) => route.path),
  "/admin/guild-settings",
]);

export function buildAdminDocumentTitle({
  authenticated,
  currentPath,
  selectedGuildId,
  guildDirectory,
}: AdminDocumentTitleInput): string {
  if (!authenticated) return "Sign in | HAF Bot";

  const canonicalPath = getCanonicalAdminPath(currentPath);
  const pageLabel =
    ADMIN_DASHBOARD_ROUTES.find((route) => route.path === canonicalPath)?.label ?? "Overview";
  if (!GUILD_SCOPED_TITLE_PATHS.has(canonicalPath)) return `${pageLabel} | HAF Bot`;

  const guildName = guildDirectory?.find((guild) => guild.guildId === selectedGuildId)?.name.trim();
  return guildName ? `${pageLabel} · ${guildName} | HAF Bot` : `${pageLabel} | HAF Bot`;
}

function getCanonicalAdminPath(path: string): string {
  if (ADMIN_DASHBOARD_ROUTES.some((route) => route.path === path)) return path;
  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments[0] === "admin" && segments.length >= 3 ? `/admin/${segments[2]}` : path;
}
