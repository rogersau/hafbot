export interface GuildServiceSuspension {
  guildId: string;
  reason: string;
  createdAtMs: number;
  createdByUserId: string;
  removedAtMs: number | null;
  removedByUserId: string | null;
}

export interface GuildServiceSuspensionAuditEvent {
  id: string;
  guildId: string;
  action: "suspended" | "restored";
  reason: string | null;
  actorUserId: string;
  occurredAtMs: number;
}

export interface GuildServiceSuspensionStore {
  readActiveSuspension(guildId: string): Promise<GuildServiceSuspension | null>;
  listSuspensions(input?: {
    query?: string;
    activeOnly?: boolean;
  }): Promise<GuildServiceSuspension[]>;
  suspendGuild(input: {
    guildId: string;
    reason: string;
    actorUserId: string;
    occurredAtMs: number;
  }): Promise<void>;
  restoreGuild(input: {
    guildId: string;
    actorUserId: string;
    occurredAtMs: number;
  }): Promise<void>;
  listAuditEvents(guildId: string): Promise<GuildServiceSuspensionAuditEvent[]>;
}
