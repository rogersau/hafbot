import { readJsonOrThrow } from "./api";

export type ChannelPermissionCopyMode = "roles_only" | "exact";

export interface ChannelPermissionCopyChannel {
  id: string;
  name: string;
  type: string;
  categoryId?: string | null;
  categoryName?: string | null;
}

export interface ChannelPermissionCopyResources {
  channels: ChannelPermissionCopyChannel[];
}

export interface PermissionOverwriteChange {
  targetId: string;
  targetName: string;
  targetType: "everyone" | "role" | "member";
  change: "added" | "removed" | "changed" | "retained";
  allow: string[];
  deny: string[];
  inherit: string[];
}

export interface PermissionCopyNotice {
  code: string;
  message: string;
}

export interface ChannelPermissionCopyPreview {
  previewToken: string;
  expiresAt: string;
  source: ChannelPermissionCopyChannel;
  target: ChannelPermissionCopyChannel;
  mode: ChannelPermissionCopyMode;
  changes: PermissionOverwriteChange[];
  blockers: PermissionCopyNotice[];
  warnings: PermissionCopyNotice[];
  summary?: string[];
}

export interface ChannelPermissionCopyResult {
  source: ChannelPermissionCopyChannel;
  target: ChannelPermissionCopyChannel;
  mode: ChannelPermissionCopyMode;
}

const path = (guildId: string, operation: string) =>
  `/admin/api/guilds/${encodeURIComponent(guildId)}/channel-permission-copy/${operation}`;

function scopedPath(guildId: string, operation: string, workspaceId: string): string {
  const query = new URLSearchParams();
  if (workspaceId.trim()) query.set("workspaceId", workspaceId.trim());
  const suffix = query.toString();
  return `${path(guildId, operation)}${suffix ? `?${suffix}` : ""}`;
}

export function getChannelPermissionCopyResources(workspaceId: string, guildId: string) {
  return readJsonOrThrow<ChannelPermissionCopyResources>(
    scopedPath(guildId, "resources", workspaceId),
  );
}

export function previewChannelPermissionCopy(
  workspaceId: string,
  guildId: string,
  input: { sourceChannelId: string; targetChannelId: string; mode: ChannelPermissionCopyMode },
) {
  return readJsonOrThrow<ChannelPermissionCopyPreview>(
    scopedPath(guildId, "preview", workspaceId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function applyChannelPermissionCopy(
  workspaceId: string,
  guildId: string,
  input: { previewToken: string; confirmationTargetName: string },
) {
  return readJsonOrThrow<ChannelPermissionCopyResult>(scopedPath(guildId, "apply", workspaceId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
