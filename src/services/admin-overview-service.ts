import type { BlocklistStore, TimedRoleStore, GatewayController } from "../runtime/contracts";
import type { BlocklistConfig, TimedRoleAssignment } from "../types";

export interface AdminOverviewGuild {
  guildId: string;
  emojis: string[];
  timedRoles: TimedRoleAssignment[];
  roleNamesById: Record<string, string>;
}

export interface AdminOverviewData {
  gateway: unknown;
  guilds: AdminOverviewGuild[];
}

export class AdminOverviewService {
  constructor(
    private readonly blocklistStore: BlocklistStore,
    private readonly timedRoleStore: TimedRoleStore,
    private readonly gateway: GatewayController,
    private readonly buildOverviewGuilds: (
      config: BlocklistConfig,
      timedRoles: TimedRoleAssignment[],
      refreshDiscordCache: boolean,
    ) => Promise<AdminOverviewGuild[]>,
  ) {}

  async getOverview(refreshDiscordCache = false): Promise<AdminOverviewData> {
    const [gateway, config, timedRoles] = await Promise.all([
      this.gateway.status(),
      this.blocklistStore.readConfig(),
      this.timedRoleStore.listTimedRoles(),
    ]);

    return {
      gateway,
      guilds: await this.buildOverviewGuilds(config, timedRoles, refreshDiscordCache),
    };
  }
}
