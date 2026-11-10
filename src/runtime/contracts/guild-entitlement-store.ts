import type { GuildEntitlement } from "../../types";

export interface GuildEntitlementStore {
  readGuildEntitlement(guildId: string): Promise<GuildEntitlement>;
}
