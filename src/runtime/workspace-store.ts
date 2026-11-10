import type {
  WorkspaceEntitlement,
  WorkspaceGuildAuditEvent,
  WorkspaceGuildLink,
  WorkspaceGuildLinkInput,
  WorkspaceGuildUnlinkInput,
} from "./workspace-types";

export class WorkspaceGuildAlreadyLinkedError extends Error {
  constructor() {
    super("Workspace Guild link conflict.");
    this.name = "WorkspaceGuildAlreadyLinkedError";
  }
}

export interface WorkspaceStore {
  linkGuildToWorkspace(input: WorkspaceGuildLinkInput): Promise<void>;
  unlinkGuildFromWorkspace(input: WorkspaceGuildUnlinkInput): Promise<void>;
  listGuildsForWorkspace(workspaceId: string): Promise<WorkspaceGuildLink[]>;
  listWorkspaceGuildAuditEvents(
    workspaceId: string,
    limit?: number,
  ): Promise<WorkspaceGuildAuditEvent[]>;
  isGuildLinkedToWorkspace(workspaceId: string, guildId: string): Promise<boolean>;
  readWorkspaceIdForGuild(guildId: string): Promise<string | null>;
  readEntitlement(workspaceId: string): Promise<WorkspaceEntitlement>;
  upsertEntitlement(entitlement: WorkspaceEntitlement): Promise<void>;
}
