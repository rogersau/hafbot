import type { GatewayEventHandler } from "./dispatcher";
import { dispatchGatewayEventHandlers } from "./dispatcher";
import type {
  GatewayEventCapabilities,
  GatewayEventEnvelope,
  GatewayEventQueueLogger,
} from "./contracts";
import { auditGatewayHandlers } from "./handlers/audit";
import { guildLifecycleGatewayHandler } from "./handlers/guild-lifecycle";
import { lfgGatewayHandler } from "./handlers/lfg";
import { memberGatewayHandlers } from "./handlers/members";
import { moderationGatewayHandlers } from "./handlers/moderation";
import { reactionLimitGatewayHandler } from "./handlers/reaction-limits";
import { ticketGatewayHandler } from "./handlers/tickets";
import { clanGatewayHandler } from "./handlers/clans";
import { suggestionGatewayHandler } from "./handlers/suggestions";
import { reactionRoleGatewayHandler } from "./handlers/reaction-roles";
import { communityToolsGatewayHandler } from "./handlers/community-tools";

export const gatewayEventHandlers: readonly GatewayEventHandler<
  GatewayEventEnvelope,
  GatewayEventCapabilities
>[] = [
  communityToolsGatewayHandler,
  ...moderationGatewayHandlers,
  reactionLimitGatewayHandler,
  ticketGatewayHandler,
  ...memberGatewayHandlers,
  ...auditGatewayHandlers,
  guildLifecycleGatewayHandler,
  clanGatewayHandler,
  lfgGatewayHandler,
  suggestionGatewayHandler,
  reactionRoleGatewayHandler,
];

export async function dispatchRegisteredGatewayEvent(
  capabilities: GatewayEventCapabilities,
  envelope: GatewayEventEnvelope,
  logger: GatewayEventQueueLogger,
): Promise<void> {
  await dispatchGatewayEventHandlers(gatewayEventHandlers, capabilities, envelope, (result) => {
    logger.info?.("gateway_event_handler", {
      eventKey: envelope.eventKey,
      eventType: envelope.type,
      ...result,
    });
  });
}
