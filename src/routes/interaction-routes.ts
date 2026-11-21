import { isDiscordRateLimitError } from "../discord/client";
import { buildEphemeralMessage } from "../discord-interactions";
import type {
  GatewayController,
  TicketTranscriptBlobStore,
  TicketTranscriptCapabilityAccess,
} from "../runtime/contracts";
import type {
  EvidenceVaultBlobStore,
  RuntimeStores,
  RuntimeAppOptions,
} from "../runtime/app-types";
import type { FeatureFlags } from "../runtime/features";
import type { InteractionServices } from "../runtime/handler-services";
import type { WorkspaceStore } from "../runtime/workspace-store";
import type { InteractionHandlerOptions } from "../runtime/interaction-handler";
import type { ComponentIdSigner } from "../security/component-id-signer";

export type InteractionRouteServices = InteractionServices;

export interface InteractionRouteOptions {
  communityTools?: import("../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../reputation/service").ReputationService>;
  discordPublicKey: string;
  discordBotToken: string;
  selfHostedSite?: RuntimeAppOptions["selfHostedSite"];
  hafAdminGuildId?: string;
  hafAdminRoleId?: string;
  verifyDiscordRequest?: (timestamp: string, body: string, signature: string) => Promise<boolean>;
  stores: RuntimeStores;
  gateway: GatewayController;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  evidenceVaultBlobs?: EvidenceVaultBlobStore;
  attendanceObservations?: RuntimeAppOptions["attendanceObservations"];
  services: InteractionRouteServices;
  features?: FeatureFlags;
  workspaceStore?: WorkspaceStore;
  waitUntil?: (promise: Promise<unknown>) => void;
  componentIdSigner?: ComponentIdSigner;
  handleInteractionRequest: (
    request: Request,
    options: InteractionHandlerOptions,
  ) => Promise<Response>;
}

export function createInteractionRoutes(options: InteractionRouteOptions) {
  return async (request: Request): Promise<Response> => {
    try {
      return await options.handleInteractionRequest(request, options);
    } catch (error) {
      if (isDiscordRateLimitError(error)) {
        return Response.json(
          buildEphemeralMessage(
            "Discord is temporarily rate limiting this action. Try again shortly.",
          ),
        );
      }
      throw error;
    }
  };
}
