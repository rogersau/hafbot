import type { PostgresDatabaseCapability } from "../runtime/postgres/postgres-capability";
import type { RuntimeStores } from "../runtime/app-types";
import {
  createGatewayEventOperationRunner,
  createGatewayEventOperationStore,
} from "../runtime/gateway-event-idempotency";
import { hasInteractionAdminAccess } from "../runtime/interaction-admin-access";
import { GuildServicePolicy } from "../runtime/guild-service-policy";
import { CommunityToolsStore } from "./store";
import { ContentFeedReader } from "./feeds";
import { CommunityToolsService } from "./service";
import { createCommunityDiscord } from "./discord";

export function createCommunityToolsRuntime(options: {
  database: PostgresDatabaseCapability;
  d1: D1Database;
  stores: RuntimeStores;
  resolveGuildBotIdentity: (guildId: string) => Promise<{ token: string; userId: string }>;
  twitchClientId?: string;
  twitchClientSecret?: string;
}) {
  const operations = createGatewayEventOperationStore(options.d1);
  const policy = new GuildServicePolicy(options.stores.guildServiceSuspensions);
  return new CommunityToolsService({
    store: new CommunityToolsStore(options.database),
    feedReader: new ContentFeedReader({
      clientId: options.twitchClientId,
      clientSecret: options.twitchClientSecret,
    }),
    discordForGuild: async (guildId) => {
      const bot = await options.resolveGuildBotIdentity(guildId);
      return createCommunityDiscord(guildId, bot.token, bot.userId);
    },
    operationsFor: (eventKey) => createGatewayEventOperationRunner({ eventKey, store: operations }),
    isSuspended: (guildId) => policy.isGuildSuspended(guildId),
    authorizeAdmin: (interaction) => hasInteractionAdminAccess(interaction, options.stores),
  });
}
