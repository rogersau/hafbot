import type { GuildAuditLogConfig } from "../../types";

export interface GuildAuditLogStore {
  readConfig(guildId: string): Promise<GuildAuditLogConfig | null>;
  upsertConfig(config: GuildAuditLogConfig): Promise<void>;
}
