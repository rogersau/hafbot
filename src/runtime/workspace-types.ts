export type WorkspaceRole = "owner" | "admin" | "viewer";

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
}

export interface WorkspaceGuildLinkInput {
  workspaceId: string;
  guildId: string;
  linkedByUserId: string;
  linkedAtMs: number;
}

export interface WorkspaceGuildLink extends WorkspaceGuildLinkInput {}

export interface WorkspaceGuildUnlinkInput {
  workspaceId: string;
  guildId: string;
  unlinkedByUserId: string;
  unlinkedAtMs: number;
}

export type WorkspaceGuildAuditAction = "linked" | "unlinked";

export interface WorkspaceGuildAuditEvent {
  id: string;
  workspaceId: string;
  guildId: string;
  action: WorkspaceGuildAuditAction;
  actorUserId: string;
  occurredAtMs: number;
  previousWorkspaceId: string | null;
}

export interface WorkspaceEntitlement {
  workspaceId: string;
  plan: "free" | "paid" | "internal";
  status: "manual" | "active" | "suspended";
  enabledFlags: string[];
  updatedAtMs: number;
}
