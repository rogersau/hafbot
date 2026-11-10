import type { QueueProducer } from "./queue-types";
import {
  createCloudflareGameAccessStore,
  createGameAccessRuntime,
} from "./commerce/game-access-runtime";
import {
  createCloudflareObservationStore,
  createAttendanceObservationRuntime,
} from "./attendance-observation-runtime";
import type { OperationalIncidentStore as BanIncidentStore } from "../operations/incidents";
import type { EnforcementStore } from "../ban-case-enforcement/store";
import {
  createCloudflareWardogsStore,
  createCloudflareBanEnforcementStore,
} from "./cloudflare-wardogs-store";
import { wardogsNetworkPolicy } from "../wardogs/config";
import { WardogsService } from "../wardogs/service";
import type { Env } from "../env";
import { readSelfHostedSite, type SelfHostedSite } from "./self-hosted-site";
import { assertValidDiscordPublicKey } from "../discord";
import { createGatewayBotController } from "./gateway-bot-orchestration";
import { createCloudflareAppConfigStore } from "./cloudflare-app-config-store";
import { createCloudflareBlocklistStore } from "./cloudflare-blocklist-store";
import { createCloudflareGuildRbacStore } from "./cloudflare-guild-rbac-store";
import { createCloudflareProductAnalyticsPreferenceStore } from "./cloudflare-product-analytics-preference-store";
import { createCloudflareLfgStore } from "./cloudflare-lfg-store";
import { createCloudflareClanStore } from "./cloudflare-clan-store";
import { createCloudflareEventStore } from "./cloudflare-event-store";
import { createCloudflareMarketplaceStore } from "./cloudflare-marketplace-store";
import { createCloudflarePlatformLinkStore } from "./cloudflare-platform-link-store";
import { createCloudflareTicketStore } from "./cloudflare-ticket-store";
import { createCloudflareTicketTranscriptCapabilityStore } from "./cloudflare-ticket-transcript-capability-store";
import { createCloudflareConfigurationRevisionStore } from "./cloudflare-configuration-revision-store";
import { createCloudflareTimedRoleStore } from "./cloudflare-timed-role-store";
import { createCloudflareWebhookProxyStore } from "./cloudflare-webhook-proxy-store";
import { createCloudflarePlayerCountStore } from "./cloudflare-player-count-store";
import { createKvPlayerCountStreakReportedStore } from "./cloudflare-player-count-streak-store";
import { createCloudflareGuildEntitlementStore } from "./cloudflare-guild-entitlement-store";
import { createCloudflareGuildPlanProjectionStore } from "./cloudflare-guild-plan-projection-store";
import { createCloudflareReactionLimitStore } from "./cloudflare-reaction-limit-store";
import { createCloudflareEvidenceVaultStore } from "./cloudflare-evidence-vault-store";
import { createCloudflareImageRulesStore } from "./cloudflare-image-rules-store";
import { createCloudflareBotDefenseStore } from "./cloudflare-bot-defense-store";
import { repairStrandedBotFlagQueueMessages } from "../services/bot-defense/queue-repair";
import { createCloudflareMentionProtectionStore } from "./cloudflare-mention-protection-store";
import { createCloudflareReactionRoleStore } from "./cloudflare-reaction-role-store";
import { createCloudflareGuildAuditLogStore } from "./cloudflare-guild-audit-log-store";
import { createCloudflareWhiteLabelBotStore } from "./cloudflare-white-label-bot-store";
import { createCloudflareGuildR2ObjectStore } from "./cloudflare-guild-r2-object-store";
import { createCloudflareBanCaseStore } from "./cloudflare-ban-case-store";
import { createCloudflareKnownGuildStore } from "./cloudflare-known-guild-store";
import { createCloudflareMemberVerificationStore } from "./cloudflare-member-verification-store";
import { createCloudflareManagedMessageStore } from "./cloudflare-managed-message-store";
import { createCloudflarePublicManagedMediaStore } from "./cloudflare-public-managed-media-store";
import { createCloudflareMessageTemplateStore } from "./cloudflare-message-template-store";
import { createCloudflareGuildServiceSuspensionStore } from "./cloudflare-guild-service-suspension-store";
import { createCloudflareFeatureSetupStore } from "./cloudflare-feature-setup-store";
import { createCloudflareSuggestionStore } from "./cloudflare-suggestion-store";
import { createCloudflareOperationalIncidentStore } from "./cloudflare-operational-incident-store";
import { createCloudflareAdminFeedbackStore } from "./cloudflare-admin-feedback-store";
import { createCloudflareOneTimeTokenStore } from "./cloudflare-one-time-token-store";
import { createCloudflareServerLevelStore } from "./cloudflare-server-level-store";
import { createCloudflareServerLevelCredentialStore } from "./cloudflare-server-level-credential-store";
import { ServerLevelCredentialService } from "../server-levels/credentials";
import { handleServerLevelIngress } from "../server-levels/ingress";
import {
  createCloudflareDiscordAccountStore,
  type DiscordAccountStore,
} from "./cloudflare-discord-account-store";
import { createCloudflareUserPreferencesStore } from "./cloudflare-user-preferences-store";
import { createCloudflareWorkspaceStore } from "./cloudflare-workspace-store";
import { putManagedGuildR2Object } from "./r2-quota";
import { parseFeatureFlags } from "./features";
import { createCustomerAuth } from "./auth/auth";
import { createFreeGuildEntitlement, getGuildEntitlementLimits } from "../types";
import { parseImageRulesEnv, type ImageRulesClassifierEnv } from "../services/image-rules/env";
import {
  parseAiTranscriptSummarizerEnv,
  type AiTranscriptSummarizerEnv,
} from "../services/tickets/ai-transcript-summarizer-env";
import type { CustomerAuth, CustomerAuthConfig } from "./auth/auth";
import type {
  GatewayController,
  TicketTranscriptBlobStore,
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
  GuildPlanProjectionStore,
  GuildR2ObjectStore,
  GuildR2QuotaStore,
  ReactionLimitStore,
  EvidenceVaultStore,
  ImageRulesStore,
  BotDefenseStore,
  MentionProtectionStore,
  KnownGuildStore,
  UserPreferencesStore,
  GuildAuditLogStore,
  WhiteLabelBotStore,
  BanCaseStore,
  MemberVerificationStore,
  ManagedMessageStore,
  GuildServiceSuspensionStore,
  FeatureSetupStore,
  SuggestionStore,
  OperationalIncidentStore,
  AdminFeedbackStore,
  OneTimeTokenStore,
  ProductAnalyticsPreferenceStore,
  ServerLevelStore,
} from "./contracts";
import type { EvidenceVaultBlobStore, RuntimeAppOptions } from "./app-types";
import type { PublicManagedMediaStore } from "../managed-media";
import type { ConfigurationRevisionStore } from "../configuration-revisions";
import type { FeatureFlags } from "./features";
import type { WorkspaceStore } from "./workspace-store";
import {
  createEffectiveGuildPlanStore,
  type EffectiveGuildPlanStore,
} from "./effective-guild-plan";
import type { PlayerCountStreakReportedStore } from "../services/player-count-service";
import { createCloudflareBillingRuntime } from "./billing/cloudflare-billing-runtime";
import { createCloudflareBillingDeliveryRuntime } from "./billing/cloudflare-delivery-runtime";
import {
  createCloudflareCommerceBuyerRuntime,
  createCloudflareCommerceFinancialOperationsRuntime,
  createCloudflareCommerceSafeguardsRuntime,
  createCloudflareCommerceSupportRuntime,
  createCloudflareCommerceRuntime,
  readCommerceConfig,
} from "./commerce/cloudflare-commerce-runtime";
import { isCommerceFeatureEnabled } from "../commerce/production-readiness";
import { createCloudflarePaidRoleRuntime } from "./commerce/cloudflare-paid-role-runtime";
import { createCloudflareCommerceStore } from "./cloudflare-commerce-store";
import { CloudflareCommerceBrandingStore } from "./commerce/cloudflare-branding-store";
import { CloudflareCommerceOfferingStore } from "./commerce/cloudflare-offering-store";
import { StripeCommerceOfferingProvider } from "./commerce/stripe-offering-provider";
import { StripeConnectClient } from "./commerce/stripe-connect-client";
import { CommerceOfferingService } from "../commerce/offering-service";
import { CommerceSellerLifecycleService } from "../commerce/seller-lifecycle";
import { CommerceSellerReviewNotificationService } from "../commerce/seller-review-notifications";
import { CommerceSalesPanelService } from "../commerce/sales-panel";
import { createDiscordGuildResourceValidator } from "../discord/guild-resource-validator";
import { createDiscordCommerceSalesPanelAdapter } from "./commerce/discord-sales-panel";
import {
  createEvidenceMediaCapability,
  type EvidenceMediaCapability,
} from "../security/evidence-media-capability";
import type { WebhookIngressGuardNamespace } from "./contracts/webhook-ingress-guard";
import { createCloudflareWebhookCredentialStore } from "../security/webhook-credentials/cloudflare-store";
import { createWebhookCredentialKeyRing } from "../security/webhook-credentials";
import { WebhookCredentialService } from "../security/webhook-credentials/store";
import { createHafDatabaseCapability, type HafDatabaseCapability } from "./haf-database-capability";
import { createComponentIdSigner, type ComponentIdSigner } from "../security/component-id-signer";
import { postMemberAuditEvent } from "../services/guild-audit-log-service";
import { logServerLevelTelemetry } from "../server-levels/telemetry";

interface CustomerAuthCacheEntry {
  betterAuthSecret: string;
  betterAuthUrl: string;
  discordOAuthClientId: string;
  discordOAuthClientSecret: string;
  customerAuth: CustomerAuth;
}

const customerAuthCache = new WeakMap<D1Database, CustomerAuthCacheEntry>();
const COMPONENT_ID_LEGACY_MIGRATION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const MEMBER_VERIFICATION_PANEL_LEGACY_MIGRATION_MAX_MS = 90 * 24 * 60 * 60 * 1000;

export interface RuntimeAppContext {
  banAppealServiceForGuild?: import("../moderation-appeals/routes").BanAppealServiceFactory;
  communityTools?: import("../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../reputation/service").ReputationService>;
  sweepReputationRewards?: () => Promise<unknown>;
  resolveGuildBotIdentity?: RuntimeAppOptions["resolveGuildBotIdentity"];
  database: HafDatabaseCapability;
  billingWebhookHandler?: (request: Request) => Promise<Response | null>;
  commerceWebhookHandler?: (request: Request) => Promise<Response | null>;
  commerceAdmin?: import("./admin-routes").CommerceAdminServices;
  commerceGameAccess?: ReturnType<typeof createGameAccessRuntime>;
  commerceBuyerCheckoutService?: import("../commerce/buyer-checkout").CommerceBuyerCheckoutService;
  commerceSupportService?: import("../commerce/support-payments").CommerceSupportService;
  commerceBrandingStore?: import("../commerce/branding").CommerceBrandingStore;
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
  billingCheckoutService?: import("./billing/checkout").BillingCheckoutService;
  billingAssignmentStore?: import("./billing/assignments").BillingAssignmentStore;
  billingManagementService?: import("./billing/management-types").ReturnTypeBillingManagement;
  processBillingGrace?: () => Promise<void>;
  billingHistoryStore?: import("./billing/history").BillingHistoryStore;
  billingSupportService?: import("./billing/support-types").ReturnTypeBillingSupport;
  billingSupportRoleId?: string;
  billingUrl?: string;
  landingPriceCatalog?: import("./billing/landing-catalog").LandingPriceCatalog;
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
  verifyDiscordRequest?: (timestamp: string, body: string, signature: string) => Promise<boolean>;
  stores: {
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
    effectiveGuildPlans: EffectiveGuildPlanStore;
    guildR2Objects: GuildR2ObjectStore;
    reactionLimits: ReactionLimitStore;
    evidenceVault: EvidenceVaultStore;
    imageRules: ImageRulesStore;
    botDefense: BotDefenseStore;
    mentionProtection: MentionProtectionStore;
    reactionRoles?: import("./contracts/reaction-role-store").ReactionRoleStore;
    knownGuilds: KnownGuildStore;
    userPreferences: UserPreferencesStore;
    guildAuditLog: GuildAuditLogStore;
    whiteLabelBots: WhiteLabelBotStore;
    banCases: BanCaseStore;
    memberVerification: MemberVerificationStore;
    managedMessages: ManagedMessageStore;
    messageTemplates?: import("./contracts").MessageTemplateStore;
    guildServiceSuspensions?: GuildServiceSuspensionStore;
    featureSetup?: FeatureSetupStore;
    suggestions: SuggestionStore;
    operationalIncidents: OperationalIncidentStore;
    adminFeedback: AdminFeedbackStore;
    oneTimeTokens: OneTimeTokenStore;
    productAnalyticsPreferences?: ProductAnalyticsPreferenceStore;
    serverLevels: ServerLevelStore;
  };
  gateway: GatewayController;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: import("./contracts").TicketTranscriptCapabilityAccess;
  evidenceVaultBlobs?: EvidenceVaultBlobStore;
  publicManagedMedia?: PublicManagedMediaStore;
  evidenceMediaCapability?: EvidenceMediaCapability;
  webhookCredentialService?: WebhookCredentialService;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  serverLevelIngressHandler?: (request: Request) => Promise<Response | null>;
  attendanceObservations?: ReturnType<typeof createAttendanceObservationRuntime>;
  wardogs?: WardogsService;
  banEnforcementStore?: EnforcementStore;
  banIncidentStore?: BanIncidentStore;
  banCasesEnabled?: boolean;
  wardogsPlayerCountEnabled?: boolean;
  serverLevelCredentialService?: ServerLevelCredentialService;
  serverLevelProcessingAvailable?: boolean;
  features: FeatureFlags;
  steamWebApiKey?: string;
  xboxOAuthClientId?: string;
  xboxOAuthClientSecret?: string;
  discordSupportInvite?: string;
  discordCacheKv?: KVNamespace;
  playerCountStreakReportedStore?: PlayerCountStreakReportedStore;
  imageRulesClassifierEnv?: ImageRulesClassifierEnv;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  publicUrl?: string;
  selfHostedSite?: SelfHostedSite;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  configurationRevisionSigningSecret?: string;
  componentIdSigner?: ComponentIdSigner;
  componentIdLegacyUntilMs?: number;
  memberVerificationPanelLegacyUntilMs?: number;
}

export function createCloudflareContext(env: Env): RuntimeAppContext {
  if (!env.HAF_DB) throw new Error("HAF_DB binding is required.");
  const selfHostedSite = readSelfHostedSite(env);
  const database = createHafDatabaseCapability(env.HAF_DB);
  const componentIdSigningSecret = normalizeOptionalString(env.COMPONENT_ID_SIGNING_SECRET);
  if (!componentIdSigningSecret && env.STAGING_MODE !== "true") {
    throw new Error("COMPONENT_ID_SIGNING_SECRET must be configured in production.");
  }
  const componentIdSigner = componentIdSigningSecret
    ? createComponentIdSigner({
        currentSecret: componentIdSigningSecret,
        previousSecret: normalizeOptionalString(env.COMPONENT_ID_PREVIOUS_SIGNING_SECRET),
      })
    : undefined;
  const componentIdLegacyUntilMs = componentIdSigner
    ? parseComponentIdLegacyUntil(env.COMPONENT_ID_LEGACY_UNTIL)
    : undefined;
  const memberVerificationPanelLegacyUntilMs = componentIdSigner
    ? parseMemberVerificationPanelLegacyUntil(env.MEMBER_VERIFICATION_PANEL_LEGACY_UNTIL)
    : undefined;
  const hafAdminGuildId = normalizeOptionalString(env.HAF_ADMIN_GUILD_ID);
  const commerceConfig = readCommerceConfig(env);
  const paidRoles = createCloudflarePaidRoleRuntime(env);
  const hafDb = database.binding;
  const billing = createCloudflareBillingRuntime(env);
  const billingDelivery = createCloudflareBillingDeliveryRuntime(env);
  const parsedFeatures = parseFeatureFlags(env);
  const features: FeatureFlags = {
    ...parsedFeatures,
    webhookProxy: parsedFeatures.webhookProxy && Boolean(hafDb),
    playerCount: parsedFeatures.playerCount && Boolean(hafDb),
  };
  const webhookProxyStore = hafDb
    ? createCloudflareWebhookProxyStore(hafDb)
    : createDisabledWebhookProxyStore();
  const webhookCredentialService =
    hafDb && env.WEBHOOK_CREDENTIAL_KEY_V1
      ? new WebhookCredentialService(
          createCloudflareWebhookCredentialStore(hafDb),
          createWebhookCredentialKeyRing({
            keyV1: env.WEBHOOK_CREDENTIAL_KEY_V1,
            keyV2: env.WEBHOOK_CREDENTIAL_KEY_V2,
          }),
        )
      : undefined;
  const playerCountStore = hafDb
    ? createCloudflarePlayerCountStore(hafDb)
    : createDisabledPlayerCountStore();
  const guildEntitlementStore = hafDb
    ? createCloudflareGuildEntitlementStore(hafDb, env.HAF_DEPLOYMENT_MODE)
    : createDisabledGuildEntitlementStore();
  const commercePremium = {
    async isPremium(guildId: string) {
      const entitlement = await guildEntitlementStore.readGuildEntitlement(guildId);
      return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    },
  };
  const gameAccessStore = createCloudflareGameAccessStore(env.HAF_DB);
  const wardogs = new WardogsService({
    reservedAccessEnabled: false,
    mutationsEnabled: env.WARDOGS_MUTATIONS_ENABLED === "true",
    commerceGrantsEnabled: false,
    canChangeOrigin: (guildId, targetId) => gameAccessStore.canChangeOrigin(guildId, targetId),
    store: createCloudflareWardogsStore(hafDb),
    runtime: "cloudflare",
    policy: wardogsNetworkPolicy(env),
    keyRing: env.WEBHOOK_CREDENTIAL_KEY_V1
      ? () =>
          createWebhookCredentialKeyRing({
            keyV1: env.WEBHOOK_CREDENTIAL_KEY_V1!,
            keyV2: env.WEBHOOK_CREDENTIAL_KEY_V2,
          })
      : undefined,
  });
  const commerceGameAccess = createGameAccessRuntime({
    database: env.HAF_DB,
    store: gameAccessStore,
    wardogs,
    platformLink: createCloudflarePlatformLinkStore(env.HAF_DB),
    botUserId: env.BOT_USER_ID,
    botToken: env.DISCORD_BOT_TOKEN,
    queue: env.COMMERCE_GAME_QUEUE,
    premium: commercePremium,
    enabled: false,
    steamEnabled: features.steamLink,
  });
  const commerceSupportService = createCloudflareCommerceSupportRuntime(env, commercePremium);
  const commerceBrandingStore = new CloudflareCommerceBrandingStore(env.HAF_DB);
  const commerceFinancialOperations =
    createCloudflareCommerceFinancialOperationsRuntime(env) ?? undefined;
  const commerceSafeguards = createCloudflareCommerceSafeguardsRuntime(env) ?? undefined;
  const commerceAdmin =
    isCommerceFeatureEnabled(env) && commerceConfig
      ? createCommerceAdminServices(
          env.HAF_DB,
          guildEntitlementStore,
          commerceConfig,
          commerceSupportService ?? undefined,
          commerceFinancialOperations,
          commerceSafeguards,
          commerceBrandingStore,
          {
            discordBotToken: env.DISCORD_BOT_TOKEN,
            publicBaseUrl: normalizeOptionalString(env.BETTER_AUTH_URL),
            reviewChannelId: normalizeOptionalString(env.COMMERCE_APPROVAL_CHANNEL_ID),
            signingGuildId: hafAdminGuildId,
            componentIdSigner,
          },
        )
      : undefined;
  const commerce = createCloudflareCommerceRuntime(env, commerceAdmin?.sellerReviews);
  const commerceBuyerCheckoutService = createCloudflareCommerceBuyerRuntime(
    env,
    commercePremium,
    commerceGameAccess.hooks,
  );
  if (commerceAdmin) commerceAdmin.gameAccess = commerceGameAccess;
  const guildR2ObjectStore = hafDb
    ? createCloudflareGuildR2ObjectStore(hafDb)
    : createDisabledGuildR2ObjectStore();
  const guildPlanProjectionStore = hafDb
    ? createCloudflareGuildPlanProjectionStore(hafDb)
    : createDisabledGuildPlanProjectionStore();
  const effectiveGuildPlanStore = createEffectiveGuildPlanStore({
    projections: guildPlanProjectionStore,
  });
  const reactionLimitStore = hafDb
    ? createCloudflareReactionLimitStore(hafDb)
    : createDisabledReactionLimitStore();
  const evidenceVaultStore = hafDb
    ? createCloudflareEvidenceVaultStore(hafDb)
    : createDisabledEvidenceVaultStore();
  const imageRulesStore = hafDb
    ? createCloudflareImageRulesStore(hafDb)
    : createDisabledImageRulesStore();
  const botDefenseStore = hafDb
    ? createCloudflareBotDefenseStore(hafDb)
    : createDisabledBotDefenseStore();
  const mentionProtectionStore = hafDb
    ? createCloudflareMentionProtectionStore(hafDb)
    : createDisabledMentionProtectionStore();
  const guildAuditLogStore = hafDb
    ? createCloudflareGuildAuditLogStore(hafDb)
    : createDisabledGuildAuditLogStore();
  const whiteLabelBotStore = hafDb
    ? createCloudflareWhiteLabelBotStore(hafDb)
    : createDisabledWhiteLabelBotStore();
  const banCaseStore = hafDb ? createCloudflareBanCaseStore(hafDb) : createDisabledBanCaseStore();
  const memberVerificationStore = hafDb
    ? createCloudflareMemberVerificationStore(hafDb)
    : createDisabledMemberVerificationStore();
  const managedMessageStore = hafDb
    ? createCloudflareManagedMessageStore(hafDb)
    : createDisabledManagedMessageStore();
  const messageTemplateStore = hafDb ? createCloudflareMessageTemplateStore(hafDb) : undefined;
  const guildServiceSuspensionStore = hafDb
    ? createCloudflareGuildServiceSuspensionStore(hafDb)
    : undefined;
  const featureSetupStore = hafDb ? createCloudflareFeatureSetupStore(hafDb) : undefined;
  const suggestionStore = createCloudflareSuggestionStore(hafDb);
  const operationalIncidentStore = createCloudflareOperationalIncidentStore(hafDb);
  const adminFeedbackStore = createCloudflareAdminFeedbackStore(hafDb);
  const oneTimeTokenStore = createCloudflareOneTimeTokenStore(hafDb);
  const serverLevelStore = createCloudflareServerLevelStore(hafDb);
  const serverLevelCredentialService = env.WEBHOOK_CREDENTIAL_KEY_V1
    ? new ServerLevelCredentialService(
        createCloudflareServerLevelCredentialStore(hafDb),
        createWebhookCredentialKeyRing({
          keyV1: env.WEBHOOK_CREDENTIAL_KEY_V1,
          keyV2: env.WEBHOOK_CREDENTIAL_KEY_V2,
        }),
      )
    : undefined;
  const serverLevelIngressHandler =
    features.serverLevels !== false && serverLevelCredentialService
      ? async (request: Request): Promise<Response | null> => {
          const match =
            /^\/webhooks\/server-levels\/cftools\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
              new URL(request.url).pathname,
            );
          if (!match) return null;
          return handleServerLevelIngress(request, match[1] ?? "", {
            store: serverLevelStore,
            credentials: serverLevelCredentialService,
            queue: env.SERVER_LEVELS_QUEUE,
            admissionGuard: env.WEBHOOK_INGRESS_GUARD_DO,
            emitTelemetry: logServerLevelTelemetry,
            onWebhookVerified: (server) =>
              postMemberAuditEvent(
                "server-level.webhook-verified",
                { guildId: server.guildId, context: { Server: server.displayName } },
                createCloudflareGuildAuditLogStore(hafDb),
                env.DISCORD_BOT_TOKEN,
              ),
          });
        }
      : undefined;
  const knownGuildStore = hafDb
    ? createCloudflareKnownGuildStore(hafDb)
    : createDisabledKnownGuildStore();
  const blocklistStore = hafDb
    ? createCloudflareBlocklistStore(hafDb, env.BOT_USER_ID)
    : createDisabledBlocklistStore(env.BOT_USER_ID);
  const appConfigStore = hafDb
    ? createCloudflareAppConfigStore(hafDb)
    : createDisabledAppConfigStore();
  const userPreferencesStore = hafDb
    ? createCloudflareUserPreferencesStore(hafDb)
    : createDisabledUserPreferencesStore();
  const guildRbacStore = hafDb
    ? createCloudflareGuildRbacStore(hafDb)
    : createDisabledGuildRbacStore();
  const productAnalyticsPreferenceStore = hafDb
    ? createCloudflareProductAnalyticsPreferenceStore(hafDb)
    : undefined;
  const timedRoleStore = hafDb
    ? createCloudflareTimedRoleStore(hafDb)
    : createDisabledTimedRoleStore();
  const ticketStore = hafDb ? createCloudflareTicketStore(hafDb) : createDisabledTicketStore();
  const ticketTranscriptCapabilities = createCloudflareTicketTranscriptCapabilityStore(hafDb);
  const configurationRevisionStore = hafDb
    ? createCloudflareConfigurationRevisionStore(hafDb)
    : undefined;
  const marketplaceStore = hafDb
    ? createCloudflareMarketplaceStore(hafDb)
    : createDisabledMarketplaceStore();
  const eventStore = hafDb ? createCloudflareEventStore(hafDb) : createDisabledEventStore();
  const lfgStore = hafDb ? createCloudflareLfgStore(hafDb) : createDisabledLfgStore();
  const clanStore = hafDb ? createCloudflareClanStore(hafDb) : undefined;
  const platformLinkStore = hafDb
    ? createCloudflarePlatformLinkStore(hafDb)
    : createDisabledPlatformLinkStore();
  const gatewayClient = createGatewayBotController({
    enabled: isEnabled(env.GATEWAY_ENABLED),
    standardBotToken: env.DISCORD_BOT_TOKEN,
    gatewayNamespace: env.GATEWAY_SESSION_DO,
    whiteLabelBots: whiteLabelBotStore,
    resolveToken: async (secretRef) => resolveWhiteLabelBotToken(env, secretRef),
  });
  const steamWebApiKey = normalizeOptionalString(env.STEAM_WEB_API_KEY);
  const xboxOAuthClientId = normalizeOptionalString(env.XBOX_OAUTH_CLIENT_ID);
  const xboxOAuthClientSecret = normalizeOptionalString(env.XBOX_OAUTH_CLIENT_SECRET);
  const imageRulesClassifierEnv = parseImageRulesEnv(env);
  const aiTranscriptSummarizerEnv = parseAiTranscriptSummarizerEnv(env);
  const webhookProxyLogPersistenceEnabled =
    features.webhookProxy && isEnabled(env.ENABLE_WEBHOOK_PROXY_LOGS);

  const customerAuth =
    hafDb &&
    env.BETTER_AUTH_SECRET &&
    env.BETTER_AUTH_URL &&
    env.DISCORD_OAUTH_CLIENT_ID &&
    env.DISCORD_OAUTH_CLIENT_SECRET
      ? getCustomerAuth({
          database: hafDb,
          betterAuthSecret: env.BETTER_AUTH_SECRET,
          betterAuthUrl: env.BETTER_AUTH_URL,
          discordOAuthClientId: env.DISCORD_OAUTH_CLIENT_ID,
          discordOAuthClientSecret: env.DISCORD_OAUTH_CLIENT_SECRET,
        })
      : undefined;
  const discordAccounts = hafDb
    ? createCloudflareDiscordAccountStore(hafDb)
    : createDisabledDiscordAccountStore();
  const workspaceStore = hafDb ? createCloudflareWorkspaceStore(hafDb) : undefined;
  const ticketTranscriptBlobs: TicketTranscriptBlobStore | undefined = env.TICKET_TRANSCRIPTS_BUCKET
    ? {
        async putHtml(key: string, html: string): Promise<void> {
          await putManagedGuildR2Object({
            key,
            body: html,
            bucket: env.TICKET_TRANSCRIPTS_BUCKET!,
            guildEntitlements: guildEntitlementStore,
            guildR2Objects: guildR2ObjectStore,
            putOptions: {
              httpMetadata: { contentType: "text/html; charset=utf-8" },
              customMetadata: { visibility: "private", contentClass: "ticket-transcript" },
            },
          });
        },
        async getHtml(key: string): Promise<string | null> {
          const object = await env.TICKET_TRANSCRIPTS_BUCKET?.get(key);
          if (!object) {
            return null;
          }

          return object.text();
        },
        async putAttachment(
          key: string,
          body: ReadableStream<Uint8Array> | ArrayBuffer | string,
          options: { contentType: string | null; sizeBytes?: number },
        ): Promise<void> {
          await putManagedGuildR2Object({
            key,
            body,
            declaredSizeBytes: options.sizeBytes,
            bucket: env.TICKET_TRANSCRIPTS_BUCKET!,
            guildEntitlements: guildEntitlementStore,
            guildR2Objects: guildR2ObjectStore,
            putOptions: {
              httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
              customMetadata: { visibility: "private", contentClass: "ticket-transcript" },
            },
          });
        },
        async getAttachment(key: string): Promise<{
          body: ReadableStream<Uint8Array> | ArrayBuffer | string;
          contentType: string | null;
        } | null> {
          const object = await env.TICKET_TRANSCRIPTS_BUCKET?.get(key);
          if (!object) {
            return null;
          }

          return {
            body: object.body,
            contentType: object.httpMetadata?.contentType ?? null,
          };
        },
        async deleteTranscriptArtifacts(input): Promise<void> {
          const bucket = env.TICKET_TRANSCRIPTS_BUCKET!;
          const htmlKey = `${input.guildId}/${input.channelId}/${input.objectId}.html`;
          await bucket.delete(htmlKey);
          await guildR2ObjectStore.deleteObject({ guildId: input.guildId, key: htmlKey });

          const prefix = `${input.guildId}/${input.channelId}/${input.objectId}/attachments/`;
          let cursor: string | undefined;
          do {
            const page = await bucket.list({ prefix, cursor, limit: 1_000 });
            const keys = page.objects.map((object) => object.key);
            if (keys.length > 0) {
              await bucket.delete(keys);
              await Promise.all(
                keys.map((key) => guildR2ObjectStore.deleteObject({ guildId: input.guildId, key })),
              );
            }
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
        },
      }
    : undefined;
  const evidenceVaultBlobs: EvidenceVaultBlobStore | undefined = env.TICKET_TRANSCRIPTS_BUCKET
    ? {
        async putImage(key, body, options): Promise<void> {
          await putManagedGuildR2Object({
            key,
            body,
            declaredSizeBytes: options.sizeBytes,
            bucket: env.TICKET_TRANSCRIPTS_BUCKET!,
            guildEntitlements: guildEntitlementStore,
            guildR2Objects: guildR2ObjectStore,
            putOptions: {
              httpMetadata: { contentType: options.contentType },
              customMetadata: { visibility: "private", contentClass: "evidence-vault" },
            },
          });
        },
        async getImage(key): Promise<{
          body: ReadableStream<Uint8Array> | ArrayBuffer | string;
          contentType: string | null;
        } | null> {
          const object = await env.TICKET_TRANSCRIPTS_BUCKET?.get(key);
          if (!object) return null;
          return {
            body: object.body,
            contentType: object.httpMetadata?.contentType ?? null,
          };
        },
        async deleteImage(key, options): Promise<void> {
          await env.TICKET_TRANSCRIPTS_BUCKET?.delete(key);
          await guildR2ObjectStore.deleteObject({
            guildId: options.guildId,
            key,
            deletedAtMs: Date.now(),
          });
        },
      }
    : undefined;
  const publicManagedMedia: PublicManagedMediaStore | undefined = env.TICKET_TRANSCRIPTS_BUCKET
    ? createCloudflarePublicManagedMediaStore({
        bucket: env.TICKET_TRANSCRIPTS_BUCKET,
        guildEntitlements: guildEntitlementStore,
        guildR2Objects: guildR2ObjectStore,
      })
    : undefined;
  const evidenceMediaCapability = env.EVIDENCE_MEDIA_SIGNING_SECRET
    ? createEvidenceMediaCapability(env.EVIDENCE_MEDIA_SIGNING_SECRET)
    : undefined;
  const context: RuntimeAppContext = {
    resolveGuildBotIdentity: async (guildId) => {
      const bot = await whiteLabelBotStore.readWhiteLabelBot(guildId);
      return bot?.status === "active"
        ? { token: resolveWhiteLabelBotToken(env, bot.tokenSecretRef), userId: bot.botUserId }
        : { token: env.DISCORD_BOT_TOKEN, userId: env.BOT_USER_ID };
    },
    database,
    landingPriceCatalog: billing?.landingPriceCatalog,
    billingWebhookHandler: billing?.webhookHandler,
    commerceWebhookHandler: commerce?.webhookHandler,
    commerceAdmin,
    commerceBuyerCheckoutService: commerceBuyerCheckoutService ?? undefined,
    commerceSupportService: commerceSupportService ?? undefined,
    commerceBrandingStore,
    commercePurchaseSigningSecret: normalizeOptionalString(env.BETTER_AUTH_SECRET),
    sweepBillingSyncOutbox: billing?.sweepOutbox,
    sweepCommerceSyncOutbox: commerce?.sweepOutbox,
    sweepCommerceFinancialActions: commerce?.sweepFinancialActions,
    scheduleCommerceReconciliation: commerce?.scheduleReconciliation,
    sweepCommerceSellerReviews: commerce?.sweepSellerReviews,
    sweepCommerceRoleOutbox: paidRoles?.sweepOutbox,
    repairBotDefenseQueueDeliveries: hafDb
      ? () =>
          repairStrandedBotFlagQueueMessages({
            store: botDefenseStore,
            resolveBotToken: async (guildId) => {
              const bot = await whiteLabelBotStore.readWhiteLabelBot(guildId);
              return bot?.status === "active"
                ? resolveWhiteLabelBotToken(env, bot.tokenSecretRef)
                : env.DISCORD_BOT_TOKEN;
            },
            componentIdSigningSecret: normalizeOptionalString(env.COMPONENT_ID_SIGNING_SECRET),
            componentIdPreviousSigningSecret: normalizeOptionalString(
              env.COMPONENT_ID_PREVIOUS_SIGNING_SECRET,
            ),
          })
      : undefined,
    sweepReactionLimitCounterRetention: hafDb
      ? () => reactionLimitStore.purgeExpiredCounters(Date.now() - 30 * 24 * 60 * 60 * 1_000)
      : undefined,
    reconcileCommerceRoles: paidRoles?.scheduleDriftAndRepairs,
    reconcileBillingOwners: billing?.reconcileAllOwners,
    sweepBillingDeliveryOutbox: billingDelivery?.sweep,
    billingCheckoutService: billing?.checkoutService,
    billingAssignmentStore: billing?.assignmentStore,
    billingManagementService: billing?.managementService,
    processBillingGrace: billing?.processGrace,
    billingHistoryStore: billing?.historyStore,
    billingSupportService: billing?.supportService,
    billingSupportRoleId: normalizeOptionalString(env.BILLING_SUPPORT_ROLE_ID),
    billingUrl: env.BETTER_AUTH_URL
      ? `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/admin/billing`
      : undefined,
    discordPublicKey: assertValidDiscordPublicKey(env.DISCORD_PUBLIC_KEY),
    discordBotToken: env.DISCORD_BOT_TOKEN,
    opsFeedbackChannelId: env.OPS_FEEDBACK_CHANNEL_ID,
    workerVersion: env.WORKER_VERSION?.tag ?? env.WORKER_VERSION?.id ?? "unknown",
    environment: env.STAGING_MODE === "true" ? "staging" : "production",
    discordBotUserId: env.BOT_USER_ID,
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordInstallPermissions: env.DISCORD_INSTALL_PERMISSIONS,
    hafAdminGuildId,
    hafAdminRoleId: normalizeOptionalString(env.HAF_ADMIN_ROLE_ID),
    webhookProxyLogPersistenceEnabled,
    webhookProxyDeliveryQueue: env.WEBHOOK_PROXY_DELIVERY_QUEUE,
    steamBanLookupQueue: env.STEAM_BAN_LOOKUP_QUEUE,
    ticketRecoveryQueue: env.TICKET_RECOVERY_QUEUE,
    customerAuth,
    discordAccounts,
    workspaceStore,
    stores: {
      blocklist: blocklistStore as BlocklistStore,
      appConfig: appConfigStore,
      guildRbac: guildRbacStore,
      productAnalyticsPreferences: productAnalyticsPreferenceStore,
      timedRoles: timedRoleStore,
      tickets: ticketStore,
      configurationRevisions: configurationRevisionStore,
      marketplace: marketplaceStore,
      events: eventStore,
      lfg: lfgStore,
      clans: clanStore,
      platformLink: platformLinkStore,
      webhookProxy: {
        readWebhookProxyConfig: webhookProxyStore.readWebhookProxyConfig,
        listWebhookProxyConfigs: webhookProxyStore.listWebhookProxyConfigs,
        upsertWebhookProxyConfig: webhookProxyStore.upsertWebhookProxyConfig,
        deleteWebhookProxyConfig: webhookProxyStore.deleteWebhookProxyConfig,
        createWebhookProxyForwardLog: webhookProxyLogPersistenceEnabled
          ? webhookProxyStore.createWebhookProxyForwardLog
          : async () => {},
        listWebhookProxyForwardLogs: webhookProxyLogPersistenceEnabled
          ? webhookProxyStore.listWebhookProxyForwardLogs
          : async () => [],
      },
      playerCount: playerCountStore,
      guildEntitlements: guildEntitlementStore,
      effectiveGuildPlans: effectiveGuildPlanStore,
      guildR2Objects: guildR2ObjectStore,
      reactionLimits: reactionLimitStore,
      reactionRoles: hafDb
        ? createCloudflareReactionRoleStore(hafDb, {
            guildId: normalizeOptionalString(env.HAF_ADMIN_GUILD_ID),
            roleIds: [env.HAF_ADMIN_ROLE_ID, env.BILLING_SUPPORT_ROLE_ID],
          })
        : undefined,
      evidenceVault: evidenceVaultStore,
      imageRules: imageRulesStore,
      botDefense: botDefenseStore,
      mentionProtection: mentionProtectionStore,
      guildAuditLog: guildAuditLogStore,
      whiteLabelBots: whiteLabelBotStore,
      knownGuilds: knownGuildStore,
      userPreferences: userPreferencesStore,
      banCases: banCaseStore,
      memberVerification: memberVerificationStore,
      managedMessages: managedMessageStore,
      messageTemplates: messageTemplateStore,
      guildServiceSuspensions: guildServiceSuspensionStore,
      featureSetup: featureSetupStore,
      suggestions: suggestionStore,
      operationalIncidents: operationalIncidentStore,
      adminFeedback: adminFeedbackStore,
      oneTimeTokens: oneTimeTokenStore,
      serverLevels: serverLevelStore,
    },
    steamWebApiKey,
    xboxOAuthClientId,
    xboxOAuthClientSecret,
    gateway: {
      start: gatewayClient.start,
      status: gatewayClient.status,
      stop: gatewayClient.stop,
    },
    ticketTranscriptBlobs,
    ticketTranscriptCapabilities,
    evidenceVaultBlobs,
    publicManagedMedia,
    evidenceMediaCapability,
    webhookCredentialService,
    serverLevelIngressHandler,
    wardogsPlayerCountEnabled: env.WARDOGS_PLAYER_COUNT_ENABLED === "true",
    wardogs,
    commerceGameAccess,
    banIncidentStore: hafDb
      ? createCloudflareOperationalIncidentStore(hafDb, "ban-cases")
      : undefined,
    banEnforcementStore: hafDb ? createCloudflareBanEnforcementStore(hafDb) : undefined,
    serverLevelCredentialService,
    serverLevelProcessingAvailable: Boolean(env.SERVER_LEVELS_QUEUE),
    webhookIngressGuard: env.WEBHOOK_INGRESS_GUARD_DO,
    features,
    discordSupportInvite: normalizeOptionalString(env.DISCORD_SUPPORT_INVITE),
    discordCacheKv: env.DISCORD_CACHE_KV,
    playerCountStreakReportedStore: env.PLAYER_COUNT_STREAK_REPORTED_KV
      ? createKvPlayerCountStreakReportedStore(env.PLAYER_COUNT_STREAK_REPORTED_KV)
      : undefined,
    imageRulesClassifierEnv,
    aiTranscriptSummarizerEnv,
    publicUrl: normalizeOptionalString(env.BETTER_AUTH_URL),
    selfHostedSite,
    turnstileSiteKey: normalizeOptionalString(env.TURNSTILE_SITE_KEY),
    turnstileSecretKey: normalizeOptionalString(env.TURNSTILE_SECRET_KEY),
    configurationRevisionSigningSecret: normalizeOptionalString(
      env.CONFIGURATION_REVISION_SIGNING_SECRET,
    ),
    componentIdSigner,
    componentIdLegacyUntilMs,
    memberVerificationPanelLegacyUntilMs,
  };

  context.attendanceObservations = createAttendanceObservationRuntime({
    store: createCloudflareObservationStore(hafDb),
    wardogs,
    stores: context.stores,
    enabled: features.serverLevels !== false,
    steamEnabled: features.steamLink,
    processingAvailable: Boolean(env.SERVER_LEVELS_QUEUE),
    botToken: env.DISCORD_BOT_TOKEN,
    botUserId: env.BOT_USER_ID,
  });
  return context;
}

function createCommerceAdminServices(
  database: D1Database,
  guildEntitlements: GuildEntitlementStore,
  stripeConfig: { secretKey: string; apiVersion: string },
  support?: import("../commerce/support-payments").CommerceSupportService,
  financialOperations?: import("../commerce/financial-operations").CommerceFinancialOperationsService,
  safeguards?: import("../commerce/safeguards").CommerceSafeguardsService,
  brandingStore?: import("../commerce/branding").CommerceBrandingStore,
  options?: {
    discordBotToken: string;
    publicBaseUrl?: string;
    reviewChannelId?: string;
    signingGuildId?: string;
    componentIdSigner?: ComponentIdSigner;
  },
): import("./admin-routes").CommerceAdminServices {
  const commerceStore = createCloudflareCommerceStore(database);
  const premium = {
    async isPremium(guildId: string) {
      const entitlement = await guildEntitlements.readGuildEntitlement(guildId);
      return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    },
  };
  const offeringStore = new CloudflareCommerceOfferingStore(database, premium);
  const stripe = new StripeConnectClient(stripeConfig);
  const publicBaseUrl = options?.publicBaseUrl;
  const guildResources = options
    ? createDiscordGuildResourceValidator(options.discordBotToken)
    : undefined;
  const salesPanel =
    publicBaseUrl && guildResources && options
      ? new CommerceSalesPanelService({
          store: commerceStore,
          catalog: offeringStore,
          discord: createDiscordCommerceSalesPanelAdapter({
            discordBotToken: options.discordBotToken,
            guildResources,
          }),
          support,
          safeguards,
          publicBaseUrl,
        })
      : undefined;
  const sellerLifecycle = new CommerceSellerLifecycleService(commerceStore, premium, stripe);
  const sellerReviews =
    options?.reviewChannelId && options.signingGuildId
      ? new CommerceSellerReviewNotificationService({
          store: commerceStore,
          lifecycle: sellerLifecycle,
          discordBotToken: options.discordBotToken,
          reviewChannelId: options.reviewChannelId,
          signingGuildId: options.signingGuildId,
          componentIdSigner: options.componentIdSigner,
        })
      : undefined;
  return {
    store: commerceStore,
    catalog: offeringStore,
    offerings: new CommerceOfferingService(
      offeringStore,
      new StripeCommerceOfferingProvider(stripe),
      Date.now,
      () => crypto.randomUUID(),
      salesPanel
        ? async (guildId) => {
            await salesPanel.refreshForGuild(guildId);
          }
        : undefined,
      async (offeringId) => {
        if (await createCloudflareGameAccessStore(database).config(offeringId))
          throw new Error("commerce_reserved_access_unavailable");
      },
    ),
    sellerLifecycle,
    sellerReviews,
    support,
    financialOperations,
    safeguards,
    salesPanel,
    branding: brandingStore,
    currentTermsVersion: "seller-terms-2026-07",
  };
}

function createDisabledReactionLimitStore(): ReactionLimitStore {
  return {
    async readReactionLimitConfig() {
      return null;
    },
    async upsertReactionLimitConfig() {},
    async incrementMessageReactionCount() {
      return 1;
    },
    async incrementUserMessageReactionCount() {
      return 1;
    },
    async incrementBreachCounter() {
      return 1;
    },
    async readBreachCounters() {
      return [];
    },
    async resetBreachCounter() {},
    async resetAllBreachCounters() {},
    async purgeExpiredCounters() {
      return 0;
    },
  };
}

function createDisabledEvidenceVaultStore(): EvidenceVaultStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
    async createRecord() {},
    async readRecord() {
      return null;
    },
    async listRecords() {
      return [];
    },
    async searchRecordsBySubject() {
      return [];
    },
    async updateRecordStatus() {},
    async updateRecordSubjects() {},
    async updateRecordEvidenceFieldValues() {},
    async updateRecordPlaceholder() {},
    async readImage() {
      return null;
    },
    async listEnabledIdentityPatterns() {
      return [];
    },
    async listIdentityPatterns() {
      return [];
    },
    async addIdentityPattern(input) {
      return {
        ...input,
        id: "disabled",
        position: 1,
        disabled: false,
        createdAtMs: 0,
      };
    },
    async disableIdentityPattern() {
      return false;
    },
  };
}

function createDisabledImageRulesStore(): ImageRulesStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
    async deleteConfig() {},
    async createModQueueItem(item) {
      return { ...item, id: "disabled" };
    },
    async readModQueueItem() {
      return null;
    },
    async setModQueueItemQueueMessage() {},
    async claimModQueueItemRestore() {
      return null;
    },
    async markModQueueItemApproved() {
      return null;
    },
    async markModQueueItemRestored() {
      return null;
    },
    async markModQueueItemRestoreFailed() {
      return null;
    },
  };
}

function createDisabledBotDefenseStore(): BotDefenseStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
    async deleteConfig() {},
    async openBotFlag() {
      return null;
    },
    async resolveBotFlag() {
      return null;
    },
    async readOpenBotFlag() {
      return null;
    },
    async isConfirmedMember() {
      return false;
    },
    async setBotFlagQueueMessage() {},
    async listOpenBotFlagsMissingQueueMessage() {
      return [];
    },
    async recordRateMessage() {},
    async listMatchingMessageChannelsInWindow() {
      return [];
    },
  };
}

function createDisabledMentionProtectionStore(): MentionProtectionStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
    async deleteConfig() {},
    async clearBurstWindow() {},
    async recordBurstMessage() {
      return 0;
    },
    async claimMessageBreaches() {
      return [];
    },
    async claimAction() {
      return "satisfied";
    },
    async recordActionOutcome() {},
  };
}

function createDisabledGuildAuditLogStore(): GuildAuditLogStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
  };
}

function createDisabledWhiteLabelBotStore(): WhiteLabelBotStore {
  return {
    async readWhiteLabelBot() {
      return null;
    },
    async listActiveWhiteLabelBots() {
      return [];
    },
    async upsertWhiteLabelBot() {},
  };
}

function createDisabledBanCaseStore(): BanCaseStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
    async readBanCaseSourceByPublicId() {
      return null;
    },
    async listBanCaseSources() {
      return [];
    },
    async upsertBanCaseSource() {},
    async deleteBanCaseSource() {},
    async createBanCase() {},
    async readBanCase() {
      return null;
    },
    async readBanCaseBySubject() {
      return null;
    },
    async listBanCases() {
      return [];
    },
    async updateBanCaseStatus() {
      return null;
    },
    async updateBanCaseThread() {},
  };
}

function createDisabledMemberVerificationStore(): MemberVerificationStore {
  return {
    async readConfig() {
      return null;
    },
    async upsertConfig() {},
    async readVerificationState() {
      return null;
    },
    async upsertVerificationState() {},
    async createVerificationAttempt() {},
    async readVerificationAttempt() {
      return null;
    },
    async updateVerificationAttempt() {},
    async deleteVerificationAttempt() {},
    async listActiveVerificationAttempts() {
      return [];
    },
    async tryClaimVerificationAttempt() {
      return false;
    },
    async consumeManualDmRateLimit() {
      return { allowed: false, retryAfterMs: 60_000 };
    },
  };
}

function createDisabledManagedMessageStore(): ManagedMessageStore {
  return {
    async registerMediaAsset() {},
    async listPendingMediaAssets() {
      return [];
    },
    async deleteMediaAsset() {},
    async claimMediaAssetDeletion() {
      return false;
    },
    async syncMediaReferences() {
      return [];
    },
    async deleteMediaReferences() {
      return [];
    },
    async listByGuild() {
      return [];
    },
    async listDraftsByGuild() {
      return [];
    },
    async readById() {
      return null;
    },
    async readDraftById() {
      return null;
    },
    async readByCanonicalMessage() {
      return null;
    },
    async countByGuild() {
      return 0;
    },
    async countDraftsByGuild() {
      return 0;
    },
    async upsert() {
      return [];
    },
    async upsertDraft() {
      return [];
    },
    async claimDueDrafts() {
      return [];
    },
    async recordDraftPublicationFailure() {
      return null;
    },
    async publishDraft() {},
    async markMissingByCanonicalMessage() {
      return null;
    },
    async claimCanonicalMessageDeleteAudit() {
      return { status: "missing" };
    },
    async markCanonicalMessageDeleteAuditDelivered() {},
    async releaseCanonicalMessageDeleteAuditClaim() {},
    async delete() {
      return [];
    },
    async deleteDraft() {
      return [];
    },
  };
}

function createDisabledKnownGuildStore(): KnownGuildStore {
  return {
    async readKnownGuild() {
      return null;
    },
    async insertKnownGuild() {
      return true;
    },
    async upsertKnownGuild() {},
    async setRemoved() {},
    async clearRemoved() {},
    async updateMetadata() {},
  };
}

function createDisabledGuildEntitlementStore(): GuildEntitlementStore {
  return {
    async readGuildEntitlement(guildId: string) {
      return createFreeGuildEntitlement(guildId, 0);
    },
  };
}

function createDisabledGuildR2ObjectStore(): GuildR2QuotaStore {
  return {
    async upsertObject() {},
    async deleteObject() {},
    async getGuildUsageBytes() {
      return 0;
    },
    async getGuildUsage() {
      return { usedBytes: 0, reservedBytes: 0, lastReconciledAtMs: null };
    },
    async reserveObject() {
      return { status: "reserved", previousCommittedBytes: 0 };
    },
    async commitObject() {
      return true;
    },
    async markUploadStarted() {
      return true;
    },
    async releaseReservation() {
      return true;
    },
    async releaseExpiredReservations() {
      return 0;
    },
    async listExpiredUploadReservations() {
      return [];
    },
    async resolveExpiredUploadReservation() {
      return true;
    },
  };
}

function createDisabledGuildPlanProjectionStore(): GuildPlanProjectionStore {
  return {
    async readGuildPlanProjection() {
      return null;
    },
    async upsertGuildPlanProjection() {},
  };
}

function createDisabledDiscordAccountStore(): DiscordAccountStore {
  return {
    async readDiscordAccessToken() {
      return null;
    },
  };
}

function createDisabledUserPreferencesStore(): UserPreferencesStore {
  return {
    async readUserPreferences() {
      return null;
    },
    async upsertUserPreferences() {},
  };
}

function createDisabledBlocklistStore(botUserId: string): BlocklistStore & {
  readGuildNotificationChannel(guildId: string, feature: string): Promise<string | null>;
  upsertGuildNotificationChannel(body: {
    guildId: string;
    feature: string;
    notificationChannelId: string | null;
  }): Promise<void>;
} {
  return {
    async readConfig() {
      return { guilds: {}, botUserId };
    },
    async readGuildConfig() {
      return { guilds: {}, botUserId };
    },
    async applyGuildEmojiMutation() {
      return { guilds: {}, botUserId };
    },
    async upsertGuildChannelFilter() {
      return { guilds: {}, botUserId };
    },
    async readGuildNotificationChannel() {
      return null;
    },
    async upsertGuildNotificationChannel() {},
  };
}

function createDisabledAppConfigStore(): AppConfigStore {
  return {
    async upsertAppConfig() {},
  };
}

function createDisabledGuildRbacStore(): GuildRbacStore {
  return {
    async readManageServerAdminEnabled() {
      return true;
    },
    async setManageServerAdminEnabled() {
      throw new Error("Guild access storage is not configured.");
    },
    async readGuildAdminRoleId() {
      return null;
    },
    async listGuildAdminRoleAssignments() {
      return [];
    },
    async upsertGuildAdminRoleId() {},
  };
}

function createDisabledTimedRoleStore(): TimedRoleStore {
  return {
    async listTimedRoles() {
      return [];
    },
    async listTimedRolesByGuild() {
      return [];
    },
    async upsertTimedRole() {},
    async updateTimedRoleSuspension() {},
    async updateTimedRoleRestoration() {},
    async deleteTimedRole() {},
    async listExpiredTimedRoles() {
      return [];
    },
    async readNewMemberTimedRoleConfig(guildId: string) {
      return {
        guildId,
        roles: [],
      };
    },
    async upsertNewMemberTimedRoleConfig() {},
    async readManualAssignmentTimedRoleConfig(guildId: string) {
      return {
        guildId,
        roles: [],
      };
    },
    async upsertManualAssignmentTimedRoleConfig() {},
  };
}

function createDisabledTicketStore(): TicketStore {
  return {
    async reserveNextTicketNumber() {
      return 1;
    },
    async readTicketPanelConfig() {
      return null;
    },
    async upsertTicketPanelConfig() {},
    async countOpenTicketsByUser() {
      return 0;
    },
    async createTicketInstance() {},
    async deleteTicketInstance() {},
    async readOpenTicketByChannel() {
      return null;
    },
    async readTicketParticipant() {
      return null;
    },
    async addTicketParticipant() {
      return { created: false, eventId: "unavailable" };
    },
    async removeTicketParticipant() {
      return { removed: false, eventId: null };
    },
    async listTicketParticipants() {
      return [];
    },
    async listTicketParticipantEvents() {
      return [];
    },
    async readLatestTicketParticipantEvent() {
      return null;
    },
    async claimTicketParticipantNotification() {
      return false;
    },
    async completeTicketParticipantNotification() {},
    async releaseTicketParticipantNotification() {},
    async updateTicketClaim() {},
    async updateTicketOpeningMessageId() {},
    async claimTicketClaimDelivery() {
      return false;
    },
    async completeTicketClaimDelivery() {},
    async releaseTicketClaimDelivery() {},
    async readOpenTicketByStaffThread() {
      return null;
    },
    async listClosedTicketInstances() {
      return { tickets: [], total: 0, nextCursor: null };
    },
    async countOpenTicketsForPanel() {
      return 0;
    },
    async deleteTicketPanelConfig() {},
    async closeTicketInstance() {
      throw new Error("Ticket storage is not configured.");
    },
    async updateTicketInstanceStaffThreadId() {},
    async recordStaffMessageMapping() {},
    async readStaffMessageMapping() {
      return null;
    },
    async readStaffMessageMappingByStaffMessage() {
      return null;
    },
    async updateStaffMessageMapping() {},
    async deleteStaffMessageMapping() {},
    async cleanupStaffMessages() {},
  };
}

function createDisabledMarketplaceStore(): MarketplaceStore {
  return {
    async readMarketplaceConfig() {
      return null;
    },
    async upsertMarketplaceConfig() {},
    async refreshMarketplaceNotice() {
      return false;
    },
    async listMarketplacePosts() {
      return [];
    },
    async readMarketplacePost() {
      return null;
    },
    async readActiveMarketplacePostByOwner() {
      return null;
    },
    async createMarketplacePost() {},
    async updateMarketplacePostMessage() {},
    async closeMarketplacePost() {
      throw new Error("Marketplace storage is not configured.");
    },
    async listMarketplaceLogs() {
      return [];
    },
    async createMarketplaceLog() {},
  };
}

function createDisabledEventStore(): EventStore {
  return {
    async createTemplate() {},
    async upsertTemplate() {},
    async readTemplate() {
      return null;
    },
    async listTemplates() {
      return [];
    },
    async createEvent() {},
    async upsertEvent() {},
    async readEvent() {
      return null;
    },
    async listEvents() {
      return [];
    },
    async listDueReminders() {
      return [];
    },
    async updateReminderSentAt() {},
    async listDueLifecycleEvents() {
      return [];
    },
    async upsertSignup() {},
    async deleteSignup() {},
    async listSignups() {
      return [];
    },
    async listUserSignups() {
      return [];
    },
    async createEventTeamWithCaptain() {},
    async addEventTeamMembership() {},
    async leaveEventTeamMembership() {},
    async listEventTeams() {
      return [];
    },
    async listActiveEventTeamMemberships() {
      return [];
    },
  };
}

function createDisabledLfgStore(): LfgStore {
  return {
    async readLfgConfig() {
      return null;
    },
    async upsertLfgConfig() {},
    async refreshLfgNotice() {
      return false;
    },
    async listLfgPosts() {
      return [];
    },
    async countActiveLfgPosts() {
      return 0;
    },
    async readLfgPost() {
      return null;
    },
    async readActiveLfgPostByOwner() {
      return null;
    },
    async createLfgPost() {},
    async updateLfgPostMessage() {},
    async updateLfgPost() {},
    async closeLfgPost() {
      throw new Error("LFG storage is not configured.");
    },
    async createLfgApplication() {},
    async readLfgApplication() {
      return null;
    },
    async listLfgApplicationsForPost() {
      return [];
    },
    async updateLfgApplication() {},
    async readLfgVoiceChannel() {
      return null;
    },
    async readLfgVoiceChannelByChannelId() {
      return null;
    },
    async upsertLfgVoiceChannel() {},
    async deleteLfgVoiceChannel() {},
    async listDueLfgPostExpiries() {
      return [];
    },
    async listDueLfgRenewalReminders() {
      return [];
    },
  };
}

function createDisabledPlatformLinkStore(): PlatformLinkStore {
  return {
    async readPlatformLinkConfig() {
      return null;
    },
    async upsertPlatformLinkConfig() {},
    async createPendingPlatformLink() {},
    async readPendingPlatformLink() {
      return null;
    },
    async deletePendingPlatformLink() {},
    async clearExpiredPendingPlatformLinks() {},
    async readPlatformLink() {
      return null;
    },
    async readPlatformLinkEntry() {
      return null;
    },
    async listPlatformLinksByUser() {
      return [];
    },
    async readPlatformLinkByPlatformId() {
      return null;
    },
    async upsertPlatformLink() {},
    async replacePlatformLinks() {},
    async deletePlatformLink() {},
    async listPlatformLinks() {
      return [];
    },
  };
}

function isEnabled(value: unknown): boolean {
  const normalized = normalizeFlagValue(value);
  if (!normalized) return false;
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseComponentIdLegacyUntil(value: unknown, nowMs = Date.now()): number | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isSafeInteger(parsed) || parsed > nowMs + COMPONENT_ID_LEGACY_MIGRATION_MAX_MS) {
    throw new Error("COMPONENT_ID_LEGACY_UNTIL must be within the next 30 days.");
  }
  if (parsed <= nowMs) return undefined;
  return parsed;
}

function parseMemberVerificationPanelLegacyUntil(
  value: unknown,
  nowMs = Date.now(),
): number | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > nowMs + MEMBER_VERIFICATION_PANEL_LEGACY_MIGRATION_MAX_MS
  ) {
    throw new Error("MEMBER_VERIFICATION_PANEL_LEGACY_UNTIL must be within the next 90 days.");
  }
  if (parsed <= nowMs) return undefined;
  return parsed;
}

function resolveWhiteLabelBotToken(env: Env, secretRef: string): string {
  const bindingName = secretRef.startsWith("secrets-store:")
    ? secretRef.split(":").at(-1)
    : secretRef;
  if (!bindingName) {
    throw new Error("White-Label Bot token secret reference is invalid.");
  }

  const token = env[bindingName];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error(`White-Label Bot token binding ${bindingName} is not configured.`);
  }
  return token;
}

function normalizeFlagValue(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function createDisabledWebhookProxyStore(): WebhookProxyStore {
  return {
    async readWebhookProxyConfig() {
      return null;
    },
    async listWebhookProxyConfigs() {
      return [];
    },
    async upsertWebhookProxyConfig() {},
    async deleteWebhookProxyConfig() {},
    async createWebhookProxyForwardLog() {},
    async listWebhookProxyForwardLogs() {
      return [];
    },
  };
}

function createDisabledPlayerCountStore(): PlayerCountStore {
  return {
    async listPlayerCountServers() {
      return [];
    },
    async listAllPlayerCountServers() {
      return [];
    },
    async readPlayerCountServer() {
      return null;
    },
    async upsertPlayerCountServer() {},
    async deletePlayerCountServer() {
      return false;
    },
    async updatePlayerCountSnapshot() {
      return false;
    },
    async updateLastRenamedAt() {},
    async incrementPlayerCountFailure() {
      return null;
    },
    async resetPlayerCountFailure() {
      return false;
    },
  };
}

function getCustomerAuth(config: CustomerAuthConfig): CustomerAuth {
  const cached = customerAuthCache.get(config.database);
  if (
    cached &&
    cached.betterAuthSecret === config.betterAuthSecret &&
    cached.betterAuthUrl === config.betterAuthUrl &&
    cached.discordOAuthClientId === config.discordOAuthClientId &&
    cached.discordOAuthClientSecret === config.discordOAuthClientSecret
  ) {
    return cached.customerAuth;
  }

  const customerAuth = createCustomerAuth(config);
  customerAuthCache.set(config.database, {
    betterAuthSecret: config.betterAuthSecret,
    betterAuthUrl: config.betterAuthUrl,
    discordOAuthClientId: config.discordOAuthClientId,
    discordOAuthClientSecret: config.discordOAuthClientSecret,
    customerAuth,
  });

  return customerAuth;
}
