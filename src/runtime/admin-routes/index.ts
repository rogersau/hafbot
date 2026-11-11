import type { Cache } from "../discord-json-cache";
import { createBanEnforcementRoutes } from "./ban-case-enforcement";
import { createAttendanceObservationRoutes } from "./attendance-observations";
import { createWardogsAdminRoutes } from "./wardogs";
import type { WardogsService } from "../../wardogs/service";
import type { Route } from "../admin-route-registry";
import type { AdminAccess } from "../admin-access";
import type { RuntimeStores } from "../app-types";
import type { CustomerSession } from "../auth/customer-session";
import type { GuildDiscoveryService } from "../discord-guild-discovery";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import type { BotGuild } from "../admin-discord-cache";
import type { ServiceFactory } from "../service-factory";
import type { FeatureFlags } from "../features";
import type { GatewayService } from "../../services/gateway-service";
import type { AdminOverviewService } from "../../services/admin-overview-service";
import type { BlocklistService } from "../../services/blocklist-service";
import type { TimedRoleService } from "../../services/timed-role-service";
import type { AiTranscriptSummarizerEnv } from "../../services/tickets/ai-transcript-summarizer-env";
import type { WebhookCredentialService } from "../../security/webhook-credentials/store";
import type { WebhookIngressGuardNamespace } from "../contracts/webhook-ingress-guard";
import type { AdminWorkspaceGuildsResponse, AdminWorkspaceListResponse } from "../admin-types";
import { createPermissionsAdminRoutes } from "./permissions";
import { createGuildFeaturesAdminRoutes } from "./guild-features";
import { createSocialAdminRoutes } from "./social";
import { createEventsAdminRoutes } from "./events";
import { createIntegrationsAdminRoutes } from "./integrations";
import { createSpaAdminRoutes } from "./spa";
import { createTicketAdminRoutes } from "./tickets";
import { createUserProfileAdminRoutes } from "./profile";
import { createGuildOverviewAdminRoutes } from "./guild-overview";
import { createGuildAuditLogAdminRoutes } from "./guild-audit-log";
import { createBanCasesAdminRoutes } from "./ban-cases";
import { createManagedMessageAdminRoutes } from "./managed-messages";
import { createMessageTemplateAdminRoutes } from "./message-templates";
import { createClanAdminRoutes } from "./clans";
import { createFeatureResourceSetupAdminRoutes } from "./feature-resource-setup";
import { createSuggestionsAdminRoutes } from "./suggestions";
import { createOperationalIncidentAdminRoutes } from "./operations-incidents";
import { createConfigurationRevisionAdminRoutes } from "./configuration-revisions";
import { createAdminFeedbackRoute } from "./feedback";
import { createChannelPermissionCopyAdminRoutes } from "./channel-permission-copy";
import { createCommerceAdminRoutes, type CommerceAdminServices } from "./commerce";
export type { CommerceAdminServices } from "./commerce";
import type { reportOperationalEvent } from "../../observability/operational-reporter";
import type { AdminFeedbackRecord } from "../contracts/admin-feedback-store";
import type { TicketTranscriptCapabilityAccess } from "../contracts";
import type { ProductAnalyticsReporter } from "../../product-analytics";
import type { ServerLevelCredentialService } from "../../server-levels/credentials";
import { createServerLevelsAdminRoutes } from "./server-levels";
import { createReactionRolesAdminRoutes } from "./reaction-roles";
import { createCommunityToolsAdminRoutes } from "./community-tools";
import { createBanAppealAdminRoutes } from "../../moderation-appeals/routes";
import { createReputationAdminRoutes } from "./reputation";
import type { ComponentIdSigner } from "../../security/component-id-signer";

export interface AdminRouteServices {
  gatewayService: GatewayService;
  adminOverviewService: AdminOverviewService;
  blocklistService: BlocklistService;
  timedRoleService: TimedRoleService;
}

export interface WorkspaceAdminApi {
  listWorkspaces(request: Request): Promise<AdminWorkspaceListResponse>;
  listWorkspaceGuilds(
    request: Request,
    workspaceId: string,
  ): Promise<AdminWorkspaceGuildsResponse | Response>;
  linkGuild(request: Request, body: { workspaceId: string; guildId: string }): Promise<Response>;
  unlinkGuild(request: Request, body: { workspaceId: string; guildId: string }): Promise<Response>;
}

export interface AdminRoutesOptions {
  banAppealServiceForGuild?: import("../../moderation-appeals/routes").BanAppealServiceFactory;
  communityTools?: import("../../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../../reputation/service").ReputationService>;
  resolveGuildBotIdentity?: import("../app-types").RuntimeAppOptions["resolveGuildBotIdentity"];
  stores: RuntimeStores;
  adminAccess: AdminAccess;
  discordBotToken: string;
  discordBotUserId?: string;
  features?: FeatureFlags;
  invalidateWebhookProxyConfig?: (publicId: string) => void;
  invalidateBanCaseSources?: () => void;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  listAuthorizedCustomerGuildIds?: (
    request: Request,
    botGuilds?: Promise<BotGuild[]>,
  ) => Promise<string[] | Response | null>;
  discordSupportInvite?: string;
  discordCache?: Cache<string>;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  services: ServiceFactory;
  guildResources?: GuildResourceValidator;
  adminRouteServices?: AdminRouteServices;
  workspaceApi?: WorkspaceAdminApi;
  guildDiscoveryService?: GuildDiscoveryService;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  webhookCredentialService?: WebhookCredentialService;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  configurationRevisionSigningSecret?: string;
  opsFeedbackChannelId?: string;
  workerVersion?: string;
  environment?: string;
  reportOperationalEvent?: typeof reportOperationalEvent;
  notifyAdminFeedback?: (record: AdminFeedbackRecord) => Promise<void>;
  waitUntil?: (promise: Promise<unknown>) => void;
  commerce?: CommerceAdminServices;
  isCommerceGuildOwner?: (guildId: string, discordUserId: string) => Promise<boolean>;
  isCommercePlatformOperator?: (discordUserId: string) => Promise<boolean>;
  publicBaseUrl?: string;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  productAnalytics?: ProductAnalyticsReporter;
  authorizeAttendanceObservationAdmin?: (request: Request, guildId: string) => Promise<boolean>;
  attendanceObservations?: ReturnType<
    typeof import("../attendance-observation-runtime").createAttendanceObservationRuntime
  >;
  wardogs?: WardogsService;
  wardogsPlayerCountEnabled?: boolean;
  serverLevelCredentialService?: ServerLevelCredentialService;
  serverLevelProcessingAvailable?: boolean;
  componentIdSigner?: ComponentIdSigner;
}

export function createAdminRoutes(options: AdminRoutesOptions): Route[] {
  const routeOptions: AdminRoutesOptions = {
    ...options,
    guildResources:
      options.guildResources ?? createDiscordGuildResourceValidator(options.discordBotToken),
  };
  const {
    managedMessageService,
    managedMediaService,
    messageTemplateService,
    clanService,
    clanFeatureSetupService,
    suggestionService,
    operationalIncidentService,
  } = options.services;
  const userProfileRoutes = options.readCustomerAdminSession
    ? createUserProfileAdminRoutes({
        store: options.stores.userPreferences,
        readCustomerSession: options.readCustomerAdminSession,
      })
    : [];

  return [
    ...(options.banAppealServiceForGuild
      ? createBanAppealAdminRoutes({
          serviceForGuild: options.banAppealServiceForGuild,
          readCustomerSession: options.readCustomerAdminSession ?? (async () => null),
        })
      : []),
    ...(options.communityTools ? createCommunityToolsAdminRoutes(options.communityTools) : []),
    ...(options.reputationServiceForGuild
      ? createReputationAdminRoutes({ serviceForGuild: options.reputationServiceForGuild })
      : []),
    ...createReactionRolesAdminRoutes(routeOptions),
    ...createChannelPermissionCopyAdminRoutes(options),
    ...createCommerceAdminRoutes({
      services: options.commerce,
      discordBotToken: options.discordBotToken,
      discordBotUserId: options.discordBotUserId,
      readCustomerAdminSession: options.readCustomerAdminSession,
      isGuildOwner: options.isCommerceGuildOwner,
      isPlatformOperator: options.isCommercePlatformOperator,
      publicBaseUrl: options.publicBaseUrl,
      guildResources: routeOptions.guildResources,
    }),
    ...createPermissionsAdminRoutes(routeOptions),
    ...(createAdminFeedbackRoute(options) as unknown as Route[]),
    ...createGuildFeaturesAdminRoutes({
      stores: options.stores,
      adminAccess: options.adminAccess,
      discordBotToken: options.discordBotToken,
      discordBotUserId: options.discordBotUserId,
      discordSupportInvite: options.discordSupportInvite,
      guildResources: routeOptions.guildResources,
      memberVerificationService: options.services.memberVerificationService,
      readCustomerAdminSession: options.readCustomerAdminSession,
    }),
    ...createGuildOverviewAdminRoutes(options),
    ...createWardogsAdminRoutes(options),
    ...createAttendanceObservationRoutes(options),
    ...createBanEnforcementRoutes(options),
    ...createServerLevelsAdminRoutes({
      stores: options.stores,
      credentials: options.serverLevelCredentialService,
      processingAvailable: options.serverLevelProcessingAvailable ?? false,
      processor: options.services.serverLevelProcessor,
      publicBaseUrl: options.publicBaseUrl,
      discordBotToken: options.discordBotToken,
      discordBotUserId: options.discordBotUserId,
      guildResources: routeOptions.guildResources!,
      readCustomerAdminSession: options.readCustomerAdminSession,
    }),
    ...(operationalIncidentService
      ? createOperationalIncidentAdminRoutes({
          stores: options.stores,
          service: operationalIncidentService,
          managedMessageService,
          playerCountService: options.services.playerCountService,
          readCustomerAdminSession: options.readCustomerAdminSession,
        })
      : []),
    ...createFeatureResourceSetupAdminRoutes(routeOptions),
    ...createConfigurationRevisionAdminRoutes(routeOptions),
    ...createSocialAdminRoutes(routeOptions),
    ...createEventsAdminRoutes(routeOptions),
    ...createIntegrationsAdminRoutes(routeOptions),
    ...createSpaAdminRoutes(routeOptions),
    ...createTicketAdminRoutes(routeOptions),
    ...createGuildAuditLogAdminRoutes({
      stores: options.stores,
      discordBotToken: options.discordBotToken,
      readCustomerAdminSession: options.readCustomerAdminSession,
    }),
    ...createBanCasesAdminRoutes({
      stores: options.stores,
      discordBotToken: options.discordBotToken,
      webhookIngressGuard: options.webhookIngressGuard,
      invalidateBanCaseSources: options.invalidateBanCaseSources,
    }),
    ...createClanAdminRoutes({
      stores: options.stores,
      service: clanService,
      setupService: clanFeatureSetupService,
      readCustomerAdminSession: options.readCustomerAdminSession,
    }),
    ...createSuggestionsAdminRoutes({
      stores: options.stores,
      service: suggestionService,
      token: options.discordBotToken,
      botUserId: options.discordBotUserId,
      guildResources: routeOptions.guildResources,
      webhookCredentialService: options.webhookCredentialService,
      readCustomerAdminSession: options.readCustomerAdminSession,
    }),
    ...(managedMessageService
      ? createManagedMessageAdminRoutes({
          service: managedMessageService,
          mediaService: managedMediaService,
          readCustomerAdminSession: options.readCustomerAdminSession,
          discordBotToken: options.discordBotToken,
        })
      : []),
    ...(messageTemplateService
      ? createMessageTemplateAdminRoutes({
          service: messageTemplateService,
          readCustomerAdminSession: options.readCustomerAdminSession,
        })
      : []),
    ...userProfileRoutes,
  ];
}
