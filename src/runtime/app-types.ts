import type { Cache } from "./discord-json-cache";
import type { QueueProducer } from "./queue-types";
import type { OperationalIncidentStore as BanIncidentStore } from "../operations/incidents";
import type { EnforcementStore } from "../ban-case-enforcement/store";
import type { WardogsService } from "../wardogs/service";
import type { DiscordEmbed } from "../discord/messages";
import type {
  BlocklistStore,
  AppConfigStore,
  TimedRoleStore,
  TicketStore,
  MarketplaceStore,
  EventStore,
  LfgStore,
  ClanStore,
  WebhookProxyStore,
  PlayerCountStore,
  PlatformLinkStore,
  GuildRbacStore,
  GuildEntitlementStore,
  GuildR2ObjectStore,
  ReactionLimitStore,
  EvidenceVaultStore,
  ImageRulesStore,
  BotDefenseStore,
  MentionProtectionStore,
  UserPreferencesStore,
  GuildAuditLogStore,
  WhiteLabelBotStore,
  BanCaseStore,
  MemberVerificationStore,
  ManagedMessageStore,
  MessageTemplateStore,
  GatewayController,
  TicketTranscriptBlobStore,
  GuildServiceSuspensionStore,
  FeatureSetupStore,
  SuggestionStore,
  OperationalIncidentStore,
  AdminFeedbackStore,
  OneTimeTokenStore,
  ProductAnalyticsPreferenceStore,
  ServerLevelStore,
} from "./contracts";
import type { FeatureFlags } from "./features";
import type { ServiceFactory } from "./service-factory";
import type { GatewayService } from "../services/gateway-service";
import type { CustomerAuth } from "./auth/customer-auth";
import type { CustomerSession } from "./auth/customer-session";
import type { DiscordAccountStore } from "./contracts/discord-account-store";
import type { GuildDiscoveryService } from "./discord-guild-discovery";
import type { WorkspaceStore } from "./workspace-store";
import type { PlayerCountStreakReportedStore } from "../services/player-count-service";
import type { AiTranscriptSummarizerEnv } from "../services/tickets/ai-transcript-summarizer-env";
import type { WebhookProxyConfigCache } from "../services/webhook-proxy-service";
import type { BanCaseSourceCache } from "../services/ban-case-service";
import type { EvidenceMediaCapability } from "../security/evidence-media-capability";
import type { WebhookCredentialService } from "../security/webhook-credentials/store";
import type { WebhookIngressGuardNamespace } from "./contracts/webhook-ingress-guard";
import type { BillingCheckoutService } from "./billing/checkout";
import type { BillingAssignmentStore } from "./billing/assignments";
import type { ReturnTypeBillingManagement } from "./billing/management-types";
import type { BillingHistoryStore } from "./billing/history";
import type { ReturnTypeBillingSupport } from "./billing/support-types";
import type { LandingPriceCatalog } from "./billing/landing-catalog";
import type { ConfigurationRevisionStore } from "../configuration-revisions";
import type { reportOperationalEvent } from "../observability/operational-reporter";
import type { CommerceBuyerCheckoutService } from "../commerce/buyer-checkout";
import type { PublicManagedMediaStore } from "../managed-media";
import type { CommerceSupportService } from "../commerce/support-payments";
import type { CommerceBrandingStore } from "../commerce/branding";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import type { ComponentIdSigner } from "../security/component-id-signer";
import type { ProductAnalyticsReporter } from "../product-analytics";
import type { ServerLevelCredentialService } from "../server-levels/credentials";

export interface DiscordInteraction {
  id?: string;
  type: number;
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    nick?: string | null;
    joined_at?: string;
    permissions?: string;
    roles?: unknown;
    user?: {
      id?: string;
      username?: string;
      global_name?: string | null;
    };
  };
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
  };
  message?: {
    id?: string;
    channel_id?: string;
    components?: unknown[];
    embeds?: DiscordEmbed[];
  };
  data?: unknown;
}

export interface RuntimeStores {
  reactionRoles: import("./contracts/reaction-role-store").ReactionRoleStore;
  blocklist: BlocklistStore;
  appConfig: AppConfigStore;
  timedRoles: TimedRoleStore;
  tickets: TicketStore;
  configurationRevisions?: ConfigurationRevisionStore;
  marketplace: MarketplaceStore;
  events: EventStore;
  lfg: LfgStore;
  clans?: ClanStore;
  webhookProxy: WebhookProxyStore;
  playerCount: PlayerCountStore;
  platformLink: PlatformLinkStore;
  guildRbac: GuildRbacStore;
  guildEntitlements: GuildEntitlementStore;
  guildR2Objects: GuildR2ObjectStore;
  reactionLimits: ReactionLimitStore;
  evidenceVault: EvidenceVaultStore;
  imageRules: ImageRulesStore;
  botDefense: BotDefenseStore;
  mentionProtection: MentionProtectionStore;
  userPreferences: UserPreferencesStore;
  guildAuditLog: GuildAuditLogStore;
  whiteLabelBots: WhiteLabelBotStore;
  banCases: BanCaseStore;
  memberVerification: MemberVerificationStore;
  managedMessages: ManagedMessageStore;
  messageTemplates?: MessageTemplateStore;
  guildServiceSuspensions?: GuildServiceSuspensionStore;
  featureSetup?: FeatureSetupStore;
  suggestions: SuggestionStore;
  operationalIncidents: OperationalIncidentStore;
  adminFeedback?: AdminFeedbackStore;
  oneTimeTokens: OneTimeTokenStore;
  productAnalyticsPreferences?: ProductAnalyticsPreferenceStore;
  serverLevels?: ServerLevelStore;
}

/**
 * The complete writable feature-service graph built once by service composition.
 *
 * Production callers consume this selected graph; nothing rebuilds or partially
 * overrides it at request time. Every member reflects the composition's real
 * capability selection, so genuinely optional capabilities stay optional.
 */
export type ApplicationServices = ServiceFactory & {
  /** The composed Gateway controller service with command-sync wired. */
  gatewayService: GatewayService;
};

export interface RuntimeAppOptions {
  banAppealServiceForGuild?: import("../moderation-appeals/routes").BanAppealServiceFactory;
  communityTools?: import("../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../reputation/service").ReputationService>;
  sweepReputationRewards?: () => Promise<unknown>;
  resolveGuildBotIdentity?: (guildId: string) => Promise<{ token: string; userId: string }>;
  reportOperationalEvent?: typeof reportOperationalEvent;
  productAnalytics?: ProductAnalyticsReporter;
  billingWebhookHandler?: (request: Request) => Promise<Response | null>;
  commerceWebhookHandler?: (request: Request) => Promise<Response | null>;
  commerceAdmin?: import("./admin-routes").CommerceAdminServices;
  commerceGameAccess?: ReturnType<
    typeof import("./postgres/postgres-commerce-game-access-runtime").createGameAccessRuntime
  >;
  commerceBuyerCheckoutService?: CommerceBuyerCheckoutService;
  commerceSupportService?: CommerceSupportService;
  commerceBrandingStore?: CommerceBrandingStore;
  commercePurchaseSigningSecret?: string;
  sweepBillingSyncOutbox?: () => Promise<unknown>;
  sweepCommerceSyncOutbox?: () => Promise<unknown>;
  sweepCommerceFinancialActions?: () => Promise<unknown>;
  scheduleCommerceReconciliation?: () => Promise<unknown>;
  sweepCommerceSellerReviews?: () => Promise<unknown>;
  sweepCommerceRoleOutbox?: () => Promise<unknown>;
  repairBotDefenseQueueDeliveries?: () => Promise<unknown>;
  sweepReactionLimitCounterRetention?: () => Promise<unknown>;
  reconcileCommerceRoles?: () => Promise<unknown>;
  reconcileBillingOwners?: () => Promise<unknown>;
  sweepBillingDeliveryOutbox?: () => Promise<unknown>;
  sweepServerLevels?: () => Promise<unknown>;
  billingCheckoutService?: BillingCheckoutService;
  billingAssignmentStore?: BillingAssignmentStore;
  billingManagementService?: ReturnTypeBillingManagement;
  processBillingGrace?: () => Promise<void>;
  billingHistoryStore?: BillingHistoryStore;
  billingSupportService?: ReturnTypeBillingSupport;
  billingSupportRoleId?: string;
  billingUrl?: string;
  landingPriceCatalog?: LandingPriceCatalog;
  discordPublicKey: string;
  discordBotToken: string;
  opsFeedbackChannelId?: string;
  workerVersion?: string;
  environment?: string;
  discordBotUserId?: string;
  discordApplicationId?: string;
  discordInstallPermissions?: string;
  hafAdminGuildId?: string;
  hafAdminRoleId?: string;
  webhookProxyLogPersistenceEnabled?: boolean;
  webhookProxyDeliveryQueue?: QueueProducer<unknown>;
  steamBanLookupQueue?: QueueProducer<unknown>;
  ticketRecoveryQueue?: QueueProducer<
    import("../services/tickets/ticket-lifecycle").TicketRecoveryEnvelope
  >;
  customerAuth?: CustomerAuth;
  discordAccounts?: Pick<DiscordAccountStore, "readDiscordAccessToken">;
  workspaceStore?: WorkspaceStore;
  xboxOAuthClientId?: string;
  xboxOAuthClientSecret?: string;
  guildDiscoveryService?: GuildDiscoveryService;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  verifyDiscordRequest?: (timestamp: string, body: string, signature: string) => Promise<boolean>;
  stores: RuntimeStores;
  gateway: GatewayController;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: import("./contracts").TicketTranscriptCapabilityAccess;
  evidenceVaultBlobs?: EvidenceVaultBlobStore;
  publicManagedMedia?: PublicManagedMediaStore;
  evidenceMediaCapability?: EvidenceMediaCapability;
  webhookCredentialService?: WebhookCredentialService;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  serverLevelIngressHandler?: (request: Request) => Promise<Response | null>;
  attendanceObservations?: ReturnType<
    typeof import("./attendance-observation-runtime").createAttendanceObservationRuntime
  >;
  wardogs?: WardogsService;
  banEnforcementStore?: EnforcementStore;
  banIncidentStore?: BanIncidentStore;
  banCasesEnabled?: boolean;
  wardogsPlayerCountEnabled?: boolean;
  serverLevelCredentialService?: ServerLevelCredentialService;
  serverLevelProcessingAvailable?: boolean;
  publicWebhookSourceCaches?: {
    webhookProxy: WebhookProxyConfigCache;
    banCase: BanCaseSourceCache;
  };
  features?: FeatureFlags;
  /** The selected feature-service graph composed once before the app is created. */
  services: ApplicationServices;
  guildResources?: GuildResourceValidator;
  waitUntil?: (promise: Promise<unknown>) => void;
  steamWebApiKey?: string;
  discordSupportInvite?: string;
  discordCache?: Cache<string>;
  playerCountStreakReportedStore?: PlayerCountStreakReportedStore;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  publicUrl?: string;
  selfHostedSite?: import("./self-hosted-site").SelfHostedSite;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  configurationRevisionSigningSecret?: string;
  componentIdSigner?: ComponentIdSigner;
}

export interface EvidenceVaultBlobStore {
  putImage(
    key: string,
    body: ArrayBuffer,
    options: { contentType: string; sizeBytes: number },
  ): Promise<void>;
  getImage(key: string): Promise<{
    body: ReadableStream<Uint8Array> | ArrayBuffer | string;
    contentType: string | null;
  } | null>;
  deleteImage?(key: string, options: { guildId: string; sizeBytes: number }): Promise<void>;
}
