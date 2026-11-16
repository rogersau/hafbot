import type { Cache } from "./discord-json-cache";
import type { WardogsService } from "../wardogs/service";
import { checkRouteCollisions, dispatchAdminRoute } from "./admin-route-registry";
import { createAdminRoutes } from "./admin-routes";
import type { AdminAccess } from "./admin-access";
import { ALL_FEATURES_ENABLED, type FeatureFlags } from "./features";
import type { RuntimeStores } from "./app-types";
import type { AdminRouteServices, CommerceAdminServices, WorkspaceAdminApi } from "./admin-routes";
import type { CustomerSession } from "./auth/customer-session";
import type { GuildDiscoveryService } from "./discord-guild-discovery";
import type { ServiceFactory } from "./service-factory";
import type { AiTranscriptSummarizerEnv } from "../services/tickets/ai-transcript-summarizer-env";
import type { WebhookCredentialService } from "../security/webhook-credentials/store";
import type { WebhookIngressGuardNamespace } from "./contracts/webhook-ingress-guard";
import type { BotGuild } from "./admin-discord-cache";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import type { TicketTranscriptCapabilityAccess } from "./contracts";
import type { ProductAnalyticsReporter } from "../product-analytics";
import type { ServerLevelCredentialService } from "../server-levels/credentials";
import type { ComponentIdSigner } from "../security/component-id-signer";

export interface AdminApiHandlerOptions {
  banAppealServiceForGuild?: import("../moderation-appeals/routes").BanAppealServiceFactory;
  communityTools?: import("../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../reputation/service").ReputationService>;
  resolveGuildBotIdentity?: import("./app-types").RuntimeAppOptions["resolveGuildBotIdentity"];
  stores: RuntimeStores;
  discordBotToken: string;
  opsFeedbackChannelId?: string;
  workerVersion?: string;
  environment?: string;
  reportOperationalEvent?: typeof import("../observability/operational-reporter").reportOperationalEvent;
  notifyAdminFeedback?: (
    record: import("./contracts/admin-feedback-store").AdminFeedbackRecord,
  ) => Promise<void>;
  waitUntil?: (promise: Promise<unknown>) => void;
  discordBotUserId?: string;
  features?: FeatureFlags;
  invalidateWebhookProxyConfig?: (publicId: string) => void;
  invalidateBanCaseSources?: () => void;
  listAuthorizedCustomerGuildIds?: (
    request: Request,
    botGuilds?: Promise<BotGuild[]>,
  ) => Promise<string[] | Response | null>;
  adminAccess: AdminAccess;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  guildDiscoveryService?: GuildDiscoveryService;
  discordSupportInvite?: string;
  discordCache?: Cache<string>;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  services: ServiceFactory;
  guildResources?: GuildResourceValidator;
  adminRouteServices?: AdminRouteServices;
  workspaceApi?: WorkspaceAdminApi;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  webhookCredentialService?: WebhookCredentialService;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  configurationRevisionSigningSecret?: string;
  commerce?: CommerceAdminServices;
  isCommerceGuildOwner?: (guildId: string, discordUserId: string) => Promise<boolean>;
  isCommercePlatformOperator?: (discordUserId: string) => Promise<boolean>;
  publicBaseUrl?: string;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  productAnalytics?: ProductAnalyticsReporter;
  authorizeAttendanceObservationAdmin?: (request: Request, guildId: string) => Promise<boolean>;
  attendanceObservations?: ReturnType<
    typeof import("./attendance-observation-runtime").createAttendanceObservationRuntime
  >;
  wardogs?: WardogsService;
  wardogsPlayerCountEnabled?: boolean;
  serverLevelCredentialService?: ServerLevelCredentialService;
  serverLevelProcessingAvailable?: boolean;
  componentIdSigner?: ComponentIdSigner;
}

export function createAdminApiHandler(options: AdminApiHandlerOptions) {
  if (!options.stores) throw new Error("Admin API stores are required.");
  if (!options.discordBotToken) throw new Error("Admin API Discord bot token is required.");
  if (!options.adminAccess) throw new Error("Admin API authorizer is required.");

  const features = options.features ?? ALL_FEATURES_ENABLED;
  const adminAccess = options.adminAccess;
  const routeRegistry = createAdminRoutes({
    banAppealServiceForGuild: options.banAppealServiceForGuild,
    communityTools: options.communityTools,
    reputationServiceForGuild: options.reputationServiceForGuild,
    resolveGuildBotIdentity: options.resolveGuildBotIdentity,
    stores: options.stores,
    adminAccess,
    discordBotToken: options.discordBotToken,
    opsFeedbackChannelId: options.opsFeedbackChannelId,
    workerVersion: options.workerVersion,
    environment: options.environment,
    reportOperationalEvent: options.reportOperationalEvent,
    notifyAdminFeedback: options.notifyAdminFeedback,
    waitUntil: options.waitUntil,
    discordBotUserId: options.discordBotUserId,
    features,
    invalidateWebhookProxyConfig: options.invalidateWebhookProxyConfig,
    invalidateBanCaseSources: options.invalidateBanCaseSources,
    readCustomerAdminSession: options.readCustomerAdminSession,
    listAuthorizedCustomerGuildIds: options.listAuthorizedCustomerGuildIds,
    discordSupportInvite: options.discordSupportInvite,
    discordCache: options.discordCache,
    turnstileSiteKey: options.turnstileSiteKey,
    turnstileSecretKey: options.turnstileSecretKey,
    services: options.services,
    guildResources: options.guildResources,
    adminRouteServices: options.adminRouteServices,
    workspaceApi: options.workspaceApi,
    guildDiscoveryService: options.guildDiscoveryService,
    aiTranscriptSummarizerEnv: options.aiTranscriptSummarizerEnv,
    webhookCredentialService: options.webhookCredentialService,
    webhookIngressGuard: options.webhookIngressGuard,
    configurationRevisionSigningSecret: options.configurationRevisionSigningSecret,
    commerce: options.commerce,
    isCommerceGuildOwner: options.isCommerceGuildOwner,
    isCommercePlatformOperator: options.isCommercePlatformOperator,
    publicBaseUrl: options.publicBaseUrl,
    ticketTranscriptCapabilities: options.ticketTranscriptCapabilities,
    productAnalytics: options.productAnalytics,
    authorizeAttendanceObservationAdmin: options.authorizeAttendanceObservationAdmin,
    attendanceObservations: options.attendanceObservations,
    wardogs: options.wardogs,
    wardogsPlayerCountEnabled: options.wardogsPlayerCountEnabled,
    serverLevelCredentialService: options.serverLevelCredentialService,
    serverLevelProcessingAvailable: options.serverLevelProcessingAvailable,
    componentIdSigner: options.componentIdSigner,
  });
  checkRouteCollisions(routeRegistry);
  return async (request: Request, url: URL): Promise<Response | null> => {
    const registeredResponse = await dispatchAdminRoute(
      routeRegistry,
      request,
      {
        adminAccess,
        features,
        stores: options.stores,
        environment: options.environment,
        productAnalytics: options.productAnalytics,
        waitUntil: options.waitUntil,
      },
      url,
    );
    if (registeredResponse) {
      return registeredResponse;
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
