export interface KnownGuildRecord {
  guildId: string;
  name: string;
  memberCount: number;
  ownerId: string;
  icon: string | null;
  installedAtMs: number;
  removedAtMs: number | null;
}

export interface KnownGuildStore {
  readKnownGuild(guildId: string): Promise<KnownGuildRecord | null>;
  insertKnownGuild(record: KnownGuildRecord): Promise<boolean>;
  upsertKnownGuild(record: KnownGuildRecord): Promise<void>;
  setRemoved(guildId: string, removedAtMs: number): Promise<void>;
  clearRemoved(guildId: string): Promise<void>;
  updateMetadata(
    guildId: string,
    fields: { name?: string; memberCount?: number; icon?: string | null },
  ): Promise<void>;
}
