import { Route as wardogsRoute } from "./$guildId/wardogs";
import { Route as automationRoute } from "./$guildId/automation";
import { Route as chatModerationRoute } from "./$guildId/chat-moderation";
import { Route as contentFeedsRoute } from "./$guildId/content-feeds";
import { Route as reputationRoute } from "./$guildId/reputation";
import { Route as rootRoute } from "./__root";
import { Route as adminIndexRoute } from "./index";
import { Route as billingRoute } from "./billing";
import { Route as profileRoute } from "./profile";
import { Route as guildRoute } from "./$guildId";
import { Route as guildIndexRoute } from "./$guildId.index";
import { Route as blocklistRoute } from "./$guildId/blocklist";
import { Route as timedRolesRoute } from "./$guildId/timed-roles";
import { Route as reactionRolesRoute } from "./$guildId/reaction-roles";
import { Route as ticketsRoute } from "./$guildId/tickets";
import { Route as commerceRoute } from "./$guildId/commerce";
import { Route as marketplaceRoute } from "./$guildId/marketplace";
import { Route as lfgRoute } from "./$guildId/lfg";
import { Route as clansRoute } from "./$guildId/clans";
import { Route as eventsRoute } from "./$guildId/events";
import { Route as playercountRoute } from "./$guildId/playercount";
import { Route as serverLevelsRoute } from "./$guildId/server-levels";
import { Route as playerLinkRoute } from "./$guildId/player-link";
import { Route as steamLinkRoute } from "./$guildId/steam-link";
import { Route as evidenceVaultRoute } from "./$guildId/evidence-vault";
import { Route as imageRulesRoute } from "./$guildId/image-rules";
import { Route as botDefenseRoute } from "./$guildId/bot-defense";
import { Route as mentionProtectionRoute } from "./$guildId/mention-protection";
import { Route as auditLogRoute } from "./$guildId/audit-log";
import { Route as managedMessagesRoute } from "./$guildId/managed-messages";
import { Route as webhooksRoute } from "./$guildId/webhooks";
import { Route as banCasesRoute } from "./$guildId/ban-cases";
import { Route as memberVerificationRoute } from "./$guildId/member-verification";
import { Route as troubleshootingRoute } from "./$guildId/troubleshooting";
import { Route as guildSettingsRoute } from "./$guildId/guild-settings";
import { Route as suggestionsRoute } from "./$guildId/suggestions";
import { Route as channelPermissionsRoute } from "./$guildId/channel-permissions";

const guildRouteTree = guildRoute.addChildren([
  automationRoute,
  chatModerationRoute,
  contentFeedsRoute,
  reputationRoute,
  guildIndexRoute,
  blocklistRoute,
  timedRolesRoute,
  reactionRolesRoute,
  ticketsRoute,
  commerceRoute,
  marketplaceRoute,
  lfgRoute,
  clansRoute,
  eventsRoute,
  playercountRoute,
  serverLevelsRoute,
  wardogsRoute,
  playerLinkRoute,
  steamLinkRoute,
  evidenceVaultRoute,
  imageRulesRoute,
  botDefenseRoute,
  mentionProtectionRoute,
  auditLogRoute,
  managedMessagesRoute,
  webhooksRoute,
  banCasesRoute,
  memberVerificationRoute,
  troubleshootingRoute,
  guildSettingsRoute,
  suggestionsRoute,
  channelPermissionsRoute,
]);

export const routeTree = rootRoute.addChildren([
  adminIndexRoute,
  billingRoute,
  profileRoute,
  guildRouteTree,
]);
