import type {
  WorkspaceEntitlement,
  WorkspaceGuildAuditEvent,
  WorkspaceGuildLink,
  WorkspaceGuildLinkInput,
  WorkspaceGuildUnlinkInput,
} from "../../src/runtime/workspace-types";
import {
  WorkspaceGuildAlreadyLinkedError,
  type WorkspaceStore,
} from "../../src/runtime/workspace-store";

export function createMemoryWorkspaceStore(): WorkspaceStore {
  const guildLinks = new Map<string, WorkspaceGuildLink>();
  const auditEvents: WorkspaceGuildAuditEvent[] = [];
  const entitlements = new Map<string, WorkspaceEntitlement>();

  return {
    async linkGuildToWorkspace(input: WorkspaceGuildLinkInput): Promise<void> {
      const existing = guildLinks.get(input.guildId);
      if (existing && existing.workspaceId !== input.workspaceId) {
        throw new WorkspaceGuildAlreadyLinkedError();
      }
      guildLinks.set(input.guildId, input);
      auditEvents.push({
        id: `workspace-guild-audit-${auditEvents.length + 1}`,
        workspaceId: input.workspaceId,
        guildId: input.guildId,
        action: "linked",
        actorUserId: input.linkedByUserId,
        occurredAtMs: input.linkedAtMs,
        previousWorkspaceId: existing?.workspaceId ?? null,
      });
    },
    async unlinkGuildFromWorkspace(input: WorkspaceGuildUnlinkInput): Promise<void> {
      const existing = guildLinks.get(input.guildId);
      if (existing?.workspaceId === input.workspaceId) {
        guildLinks.delete(input.guildId);
        auditEvents.push({
          id: `workspace-guild-audit-${auditEvents.length + 1}`,
          workspaceId: input.workspaceId,
          guildId: input.guildId,
          action: "unlinked",
          actorUserId: input.unlinkedByUserId,
          occurredAtMs: input.unlinkedAtMs,
          previousWorkspaceId: existing.workspaceId,
        });
      }
    },
    async listGuildsForWorkspace(workspaceId: string): Promise<WorkspaceGuildLink[]> {
      return [...guildLinks.values()]
        .filter((link) => link.workspaceId === workspaceId)
        .sort((left, right) => left.linkedAtMs - right.linkedAtMs);
    },
    async listWorkspaceGuildAuditEvents(
      workspaceId: string,
      limit = 100,
    ): Promise<WorkspaceGuildAuditEvent[]> {
      return auditEvents
        .filter((event) => event.workspaceId === workspaceId)
        .sort((left, right) => right.occurredAtMs - left.occurredAtMs)
        .slice(0, Math.min(Math.max(limit, 1), 500));
    },
    async isGuildLinkedToWorkspace(workspaceId: string, guildId: string): Promise<boolean> {
      return guildLinks.get(guildId)?.workspaceId === workspaceId;
    },
    async readWorkspaceIdForGuild(guildId: string): Promise<string | null> {
      return guildLinks.get(guildId)?.workspaceId ?? null;
    },
    async readEntitlement(workspaceId: string): Promise<WorkspaceEntitlement> {
      return (
        entitlements.get(workspaceId) ?? {
          workspaceId,
          plan: "free",
          status: "manual",
          enabledFlags: [],
          updatedAtMs: 0,
        }
      );
    },
    async upsertEntitlement(entitlement: WorkspaceEntitlement): Promise<void> {
      entitlements.set(entitlement.workspaceId, entitlement);
    },
  };
}
