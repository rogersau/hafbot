import type { RuntimeContextStores } from "../../../../src/runtime/app-context";
import type { Cache } from "../../../../src/runtime/discord-json-cache";
import type { DiscordAccountStore } from "../../../../src/runtime/contracts/discord-account-store";
import type { QueueProducer } from "../../../../src/runtime/queue-types";
import {
  createSqliteGameAccessStore,
  createGameAccessRuntime,
} from "./commerce/game-access-runtime";
import {
  createSqliteObservationStore,
  createAttendanceObservationRuntime,
} from "../observation-store";
import type { OperationalIncidentStore as BanIncidentStore } from "../../../../src/operations/incidents";
import type { EnforcementStore } from "../ban-case-enforcement/store";
import { createSqliteWardogsStore, createSqliteBanEnforcementStore } from "./sqlite-wardogs-store";
import { wardogsNetworkPolicy } from "../../../../src/wardogs/config";
import { WardogsService } from "../../../../src/wardogs/service";
import type { Env } from "../../test-env";
import { readSelfHostedSite, type SelfHostedSite } from "../../../../src/runtime/self-hosted-site";
import { assertValidDiscordPublicKey } from "../../../../src/discord";
import { createGatewayBotController } from "./gateway-bot-orchestration";
import { createSqliteAppConfigStore } from "./sqlite-app-config-store";
import { createSqliteBlocklistStore } from "./sqlite-blocklist-store";
import { createSqliteGuildRbacStore } from "./sqlite-guild-rbac-store";
import { createSqliteProductAnalyticsPreferenceStore } from "./sqlite-product-analytics-preference-store";
import { createSqliteLfgStore } from "./sqlite-lfg-store";
import { createSqliteClanStore } from "./sqlite-clan-store";
import { createSqliteEventStore } from "./sqlite-event-store";
import { createSqliteMarketplaceStore } from "./sqlite-marketplace-store";
import { createSqlitePlatformLinkStore } from "./sqlite-platform-link-store";
import { createSqliteTicketStore } from "./sqlite-ticket-store";
import { createSqliteTicketTranscriptCapabilityStore } from "./sqlite-ticket-transcript-capability-store";
import { createSqliteConfigurationRevisionStore } from "./sqlite-configuration-revision-store";
import { createSqliteTimedRoleStore } from "./sqlite-timed-role-store";
import { createSqliteWebhookProxyStore } from "./sqlite-webhook-proxy-store";
import { createSqlitePlayerCountStore } from "./sqlite-player-count-store";
import { createKvPlayerCountStreakReportedStore } from "./sqlite-player-count-streak-store";
import { createSqliteGuildEntitlementStore } from "./sqlite-guild-entitlement-store";
import { createSqliteGuildPlanProjectionStore } from "./sqlite-guild-plan-projection-store";
import { createSqliteReactionLimitStore } from "./sqlite-reaction-limit-store";
import { createSqliteEvidenceVaultStore } from "./sqlite-evidence-vault-store";
import { createSqliteImageRulesStore } from "./sqlite-image-rules-store";
import { createSqliteBotDefenseStore } from "./sqlite-bot-defense-store";
import { repairStrandedBotFlagQueueMessages } from "../../../../src/services/bot-defense/queue-repair";
import { createSqliteMentionProtectionStore } from "./sqlite-mention-protection-store";
import { createSqliteReactionRoleStore } from "./sqlite-reaction-role-store";
import { createSqliteGuildAuditLogStore } from "./sqlite-guild-audit-log-store";
import { createSqliteWhiteLabelBotStore } from "./sqlite-white-label-bot-store";
import { createSqliteGuildR2ObjectStore } from "./sqlite-guild-r2-object-store";
import { createSqliteBanCaseStore } from "./sqlite-ban-case-store";
import { createSqliteKnownGuildStore } from "./sqlite-known-guild-store";
import { createSqliteMemberVerificationStore } from "./sqlite-member-verification-store";
import { createSqliteManagedMessageStore } from "./sqlite-managed-message-store";
import { createSqlitePublicManagedMediaStore } from "./sqlite-public-managed-media-store";
import { createSqliteMessageTemplateStore } from "./sqlite-message-template-store";
import { createSqliteGuildServiceSuspensionStore } from "./sqlite-guild-service-suspension-store";
import { createSqliteFeatureSetupStore } from "./sqlite-feature-setup-store";
import { createSqliteSuggestionStore } from "./sqlite-suggestion-store";
import { createSqliteOperationalIncidentStore } from "./sqlite-operational-incident-store";
import { createSqliteAdminFeedbackStore } from "./sqlite-admin-feedback-store";
import { createSqliteOneTimeTokenStore } from "./sqlite-one-time-token-store";
import { createSqliteServerLevelStore } from "./sqlite-server-level-store";
import { createSqliteServerLevelCredentialStore } from "./sqlite-server-level-credential-store";
import { ServerLevelCredentialService } from "../../../../src/server-levels/credentials";
import { handleServerLevelIngress } from "../../../../src/server-levels/ingress";
import { createSqliteDiscordAccountStore } from "./sqlite-discord-account-store";
import { createSqliteUserPreferencesStore } from "./sqlite-user-preferences-store";
import { createSqliteWorkspaceStore } from "./sqlite-workspace-store";
import { putManagedGuildR2Object } from "./r2-quota";
import { parseFeatureFlags } from "../../../../src/runtime/features";
import { createCustomerAuth } from "./auth/auth";
import { getGuildEntitlementLimits } from "../../../../src/types";
import {
  parseImageRulesEnv,
  type ImageRulesClassifierEnv,
} from "../../../../src/services/image-rules/env";
import {
  parseAiTranscriptSummarizerEnv,
  type AiTranscriptSummarizerEnv,
} from "../../../../src/services/tickets/ai-transcript-summarizer-env";
import type { CustomerAuth, CustomerAuthConfig } from "./auth/auth";
import type {
  GatewayController,
  TicketTranscriptBlobStore,
  GuildEntitlementStore,
} from "../../../../src/runtime/contracts";
import type { EvidenceVaultBlobStore, RuntimeAppOptions } from "../../../../src/runtime/app-types";
import type { PublicManagedMediaStore } from "../../../../src/managed-media";

import type { FeatureFlags } from "../../../../src/runtime/features";
import type { WorkspaceStore } from "../../../../src/runtime/workspace-store";
import { createEffectiveGuildPlanStore } from "../../../../src/runtime/effective-guild-plan";
import type { PlayerCountStreakReportedStore } from "../../../../src/services/player-count-service";
import { createSqliteBillingRuntime } from "./billing/sqlite-billing-runtime";
import { createSqliteBillingDeliveryRuntime } from "./billing/sqlite-delivery-runtime";
import {
  createSqliteCommerceBuyerRuntime,
  createSqliteCommerceFinancialOperationsRuntime,
  createSqliteCommerceSafeguardsRuntime,
  createSqliteCommerceSupportRuntime,
  createSqliteCommerceRuntime,
  readCommerceConfig,
} from "./commerce/sqlite-commerce-runtime";
import { isCommerceFeatureEnabled } from "../../../../src/commerce/production-readiness";
import { createSqlitePaidRoleRuntime } from "./commerce/sqlite-paid-role-runtime";
import { createSqliteCommerceStore } from "./sqlite-commerce-store";
import { SqliteCommerceBrandingStore } from "./commerce/sqlite-branding-store";
import { SqliteCommerceOfferingStore } from "./commerce/sqlite-offering-store";
import { StripeCommerceOfferingProvider } from "../../../../src/runtime/commerce/stripe-offering-provider";
import { StripeConnectClient } from "../../../../src/runtime/commerce/stripe-connect-client";
import { CommerceOfferingService } from "../../../../src/commerce/offering-service";
import { CommerceSellerLifecycleService } from "../../../../src/commerce/seller-lifecycle";
import { CommerceSellerReviewNotificationService } from "../../../../src/commerce/seller-review-notifications";
import { CommerceSalesPanelService } from "../../../../src/commerce/sales-panel";
import { createDiscordGuildResourceValidator } from "../../../../src/discord/guild-resource-validator";
import { createDiscordCommerceSalesPanelAdapter } from "../../../../src/runtime/commerce/discord-sales-panel";
import {
  createEvidenceMediaCapability,
  type EvidenceMediaCapability,
} from "../../../../src/security/evidence-media-capability";
import type { WebhookIngressGuardNamespace } from "../../../../src/runtime/contracts/webhook-ingress-guard";
import { createSqliteWebhookCredentialStore } from "../security/webhook-credentials/sqlite-store";
import { createWebhookCredentialKeyRing } from "../../../../src/security/webhook-credentials";
import { WebhookCredentialService } from "../../../../src/security/webhook-credentials/store";
import { createHafDatabaseCapability, type HafDatabaseCapability } from "./haf-database-capability";
import {
  createComponentIdSigner,
  type ComponentIdSigner,
} from "../../../../src/security/component-id-signer";
import { postMemberAuditEvent } from "../../../../src/services/guild-audit-log-service";
import { logServerLevelTelemetry } from "../../../../src/server-levels/telemetry";

interface CustomerAuthCacheEntry {
  betterAuthSecret: string;
  betterAuthUrl: string;
  discordOAuthClientId: string;
  discordOAuthClientSecret: string;
  customerAuth: CustomerAuth;
}

const customerAuthCache = new WeakMap<D1Database, CustomerAuthCacheEntry>();

export interface RuntimeAppContext {
  banAppealServiceForGuild?: import("../../../../src/moderation-appeals/routes").BanAppealServiceFactory;
  communityTools?: import("../../../../src/community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../../../../src/reputation/service").ReputationService>;
  sweepReputationRewards?: () => Promise<unknown>;
  resolveGuildBotIdentity?: RuntimeAppOptions["resolveGuildBotIdentity"];
  database: HafDatabaseCapability;
  billingWebhookHandler?: (request: Request) => Promise<Response | null>;
  commerceWebhookHandler?: (request: Request) => Promise<Response | null>;
  commerceAdmin?: import("../../../../src/runtime/admin-routes").CommerceAdminServices;
  commerceGameAccess?: ReturnType<typeof createGameAccessRuntime>;
  commerceBuyerCheckoutService?: import("../../../../src/commerce/buyer-checkout").CommerceBuyerCheckoutService;
  commerceSupportService?: import("../../../../src/commerce/support-payments").CommerceSupportService;
  commerceBrandingStore?: import("../../../../src/commerce/branding").CommerceBrandingStore;
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
  billingCheckoutService?: import("../../../../src/runtime/billing/checkout").BillingCheckoutService;
  billingAssignmentStore?: import("../../../../src/runtime/billing/assignments").BillingAssignmentStore;
  billingManagementService?: import("../../../../src/runtime/billing/management-types").ReturnTypeBillingManagement;
  processBillingGrace?: () => Promise<void>;
  billingHistoryStore?: import("./billing/history").BillingHistoryStore;
  billingSupportService?: import("../../../../src/runtime/billing/support-types").ReturnTypeBillingSupport;
  billingSupportRoleId?: string;
  billingUrl?: string;
  landingPriceCatalog?: import("../../../../src/runtime/billing/landing-catalog").LandingPriceCatalog;
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
    import("../../../../src/services/tickets/ticket-lifecycle").TicketRecoveryEnvelope
  >;
  customerAuth?: CustomerAuth;
  discordAccounts?: Pick<DiscordAccountStore, "readDiscordAccessToken">;
  workspaceStore?: WorkspaceStore;
  verifyDiscordRequest?: (timestamp: string, body: string, signature: string) => Promise<boolean>;
  stores: RuntimeContextStores;
  gateway: GatewayController;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: import("../../../../src/runtime/contracts").TicketTranscriptCapabilityAccess;
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
  discordCache?: Cache<string>;
  playerCountStreakReportedStore?: PlayerCountStreakReportedStore;
  imageRulesClassifierEnv?: ImageRulesClassifierEnv;
  aiTranscriptSummarizerEnv?: AiTranscriptSummarizerEnv;
  publicUrl?: string;
  selfHostedSite?: SelfHostedSite;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  configurationRevisionSigningSecret?: string;
  componentIdSigner?: ComponentIdSigner;
}

export function createSqliteContext(
  env: Env,
  stores: Partial<RuntimeAppContext["stores"]> = {},
): RuntimeAppContext {
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
  const hafAdminGuildId = normalizeOptionalString(env.HAF_ADMIN_GUILD_ID);
  const commerceConfig = readCommerceConfig(env);
  const paidRoles = createSqlitePaidRoleRuntime(env);
  const hafDb = database.binding;
  const billing = createSqliteBillingRuntime(env);
  const billingDelivery = createSqliteBillingDeliveryRuntime(env);
  const features = parseFeatureFlags(env);
  const webhookProxyStore = stores.webhookProxy ?? createSqliteWebhookProxyStore(hafDb);
  const webhookCredentialService = env.WEBHOOK_CREDENTIAL_KEY_V1
    ? new WebhookCredentialService(
        createSqliteWebhookCredentialStore(hafDb),
        createWebhookCredentialKeyRing({
          keyV1: env.WEBHOOK_CREDENTIAL_KEY_V1,
          keyV2: env.WEBHOOK_CREDENTIAL_KEY_V2,
        }),
      )
    : undefined;
  const playerCountStore = stores.playerCount ?? createSqlitePlayerCountStore(hafDb);
  const guildEntitlementStore =
    stores.guildEntitlements ?? createSqliteGuildEntitlementStore(hafDb, env.HAF_DEPLOYMENT_MODE);
  const commercePremium = {
    async isPremium(guildId: string) {
      const entitlement = await guildEntitlementStore.readGuildEntitlement(guildId);
      return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    },
  };
  const gameAccessStore = createSqliteGameAccessStore(env.HAF_DB);
  const wardogs = new WardogsService({
    reservedAccessEnabled: false,
    mutationsEnabled: env.WARDOGS_MUTATIONS_ENABLED === "true",
    commerceGrantsEnabled: false,
    canChangeOrigin: (guildId, targetId) => gameAccessStore.canChangeOrigin(guildId, targetId),
    store: createSqliteWardogsStore(hafDb),
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
    platformLink: stores.platformLink ?? createSqlitePlatformLinkStore(env.HAF_DB),
    botUserId: env.BOT_USER_ID,
    botToken: env.DISCORD_BOT_TOKEN,
    queue: env.COMMERCE_GAME_QUEUE,
    premium: commercePremium,
    enabled: false,
    steamEnabled: features.steamLink,
  });
  const commerceSupportService = createSqliteCommerceSupportRuntime(env, commercePremium);
  const commerceBrandingStore = new SqliteCommerceBrandingStore(env.HAF_DB);
  const commerceFinancialOperations =
    createSqliteCommerceFinancialOperationsRuntime(env) ?? undefined;
  const commerceSafeguards = createSqliteCommerceSafeguardsRuntime(env) ?? undefined;
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
  const commerce = createSqliteCommerceRuntime(env, commerceAdmin?.sellerReviews);
  const commerceBuyerCheckoutService = createSqliteCommerceBuyerRuntime(
    env,
    commercePremium,
    commerceGameAccess.hooks,
  );
  if (commerceAdmin) commerceAdmin.gameAccess = commerceGameAccess;
  const guildR2ObjectStore = stores.guildR2Objects ?? createSqliteGuildR2ObjectStore(hafDb);
  const guildPlanProjectionStore = createSqliteGuildPlanProjectionStore(hafDb);
  const effectiveGuildPlanStore = createEffectiveGuildPlanStore({
    projections: guildPlanProjectionStore,
  });
  const reactionLimitStore = stores.reactionLimits ?? createSqliteReactionLimitStore(hafDb);
  const evidenceVaultStore = stores.evidenceVault ?? createSqliteEvidenceVaultStore(hafDb);
  const imageRulesStore = stores.imageRules ?? createSqliteImageRulesStore(hafDb);
  const botDefenseStore = stores.botDefense ?? createSqliteBotDefenseStore(hafDb);
  const mentionProtectionStore =
    stores.mentionProtection ?? createSqliteMentionProtectionStore(hafDb);
  const guildAuditLogStore = stores.guildAuditLog ?? createSqliteGuildAuditLogStore(hafDb);
  const whiteLabelBotStore = stores.whiteLabelBots ?? createSqliteWhiteLabelBotStore(hafDb);
  const banCaseStore = stores.banCases ?? createSqliteBanCaseStore(hafDb);
  const memberVerificationStore =
    stores.memberVerification ?? createSqliteMemberVerificationStore(hafDb);
  const managedMessageStore = stores.managedMessages ?? createSqliteManagedMessageStore(hafDb);
  const messageTemplateStore = stores.messageTemplates ?? createSqliteMessageTemplateStore(hafDb);
  const guildServiceSuspensionStore =
    stores.guildServiceSuspensions ?? createSqliteGuildServiceSuspensionStore(hafDb);
  const featureSetupStore = stores.featureSetup ?? createSqliteFeatureSetupStore(hafDb);
  const suggestionStore = stores.suggestions ?? createSqliteSuggestionStore(hafDb);
  const operationalIncidentStore =
    stores.operationalIncidents ?? createSqliteOperationalIncidentStore(hafDb);
  const adminFeedbackStore = stores.adminFeedback ?? createSqliteAdminFeedbackStore(hafDb);
  const oneTimeTokenStore = stores.oneTimeTokens ?? createSqliteOneTimeTokenStore(hafDb);
  const serverLevelStore = stores.serverLevels ?? createSqliteServerLevelStore(hafDb);
  const serverLevelCredentialService = env.WEBHOOK_CREDENTIAL_KEY_V1
    ? new ServerLevelCredentialService(
        createSqliteServerLevelCredentialStore(hafDb),
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
                guildAuditLogStore,
                env.DISCORD_BOT_TOKEN,
              ),
          });
        }
      : undefined;
  const knownGuildStore = stores.knownGuilds ?? createSqliteKnownGuildStore(hafDb);
  const blocklistStore = stores.blocklist ?? createSqliteBlocklistStore(hafDb, env.BOT_USER_ID);
  const appConfigStore = stores.appConfig ?? createSqliteAppConfigStore(hafDb);
  const userPreferencesStore = stores.userPreferences ?? createSqliteUserPreferencesStore(hafDb);
  const guildRbacStore = stores.guildRbac ?? createSqliteGuildRbacStore(hafDb);
  const productAnalyticsPreferenceStore =
    stores.productAnalyticsPreferences ?? createSqliteProductAnalyticsPreferenceStore(hafDb);
  const timedRoleStore = stores.timedRoles ?? createSqliteTimedRoleStore(hafDb);
  const ticketStore = stores.tickets ?? createSqliteTicketStore(hafDb);
  const ticketTranscriptCapabilities = createSqliteTicketTranscriptCapabilityStore(hafDb);
  const configurationRevisionStore =
    stores.configurationRevisions ?? createSqliteConfigurationRevisionStore(hafDb);
  const marketplaceStore = stores.marketplace ?? createSqliteMarketplaceStore(hafDb);
  const eventStore = stores.events ?? createSqliteEventStore(hafDb);
  const lfgStore = stores.lfg ?? createSqliteLfgStore(hafDb);
  const clanStore = stores.clans ?? createSqliteClanStore(hafDb);
  const platformLinkStore = stores.platformLink ?? createSqlitePlatformLinkStore(hafDb);
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
  const discordAccounts = createSqliteDiscordAccountStore(hafDb);
  const workspaceStore = createSqliteWorkspaceStore(hafDb);
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
    ? createSqlitePublicManagedMediaStore({
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
    repairBotDefenseQueueDeliveries: () =>
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
      }),
    sweepReactionLimitCounterRetention: () =>
      reactionLimitStore.purgeExpiredCounters(Date.now() - 30 * 24 * 60 * 60 * 1_000),
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
      blocklist: blocklistStore,
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
      reactionRoles:
        stores.reactionRoles ??
        createSqliteReactionRoleStore(hafDb, {
          guildId: normalizeOptionalString(env.HAF_ADMIN_GUILD_ID),
          roleIds: [env.HAF_ADMIN_ROLE_ID, env.BILLING_SUPPORT_ROLE_ID],
        }),
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
    banIncidentStore: createSqliteOperationalIncidentStore(hafDb, "ban-cases"),
    banEnforcementStore: createSqliteBanEnforcementStore(hafDb),
    serverLevelCredentialService,
    serverLevelProcessingAvailable: Boolean(env.SERVER_LEVELS_QUEUE),
    webhookIngressGuard: env.WEBHOOK_INGRESS_GUARD_DO,
    features,
    discordSupportInvite: normalizeOptionalString(env.DISCORD_SUPPORT_INVITE),
    discordCache: env.discordCache,
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
  };

  context.attendanceObservations = createAttendanceObservationRuntime({
    store: createSqliteObservationStore(hafDb),
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
  support?: import("../../../../src/commerce/support-payments").CommerceSupportService,
  financialOperations?: import("../../../../src/commerce/financial-operations").CommerceFinancialOperationsService,
  safeguards?: import("../../../../src/commerce/safeguards").CommerceSafeguardsService,
  brandingStore?: import("../../../../src/commerce/branding").CommerceBrandingStore,
  options?: {
    discordBotToken: string;
    publicBaseUrl?: string;
    reviewChannelId?: string;
    signingGuildId?: string;
    componentIdSigner?: ComponentIdSigner;
  },
): import("../../../../src/runtime/admin-routes").CommerceAdminServices {
  const commerceStore = createSqliteCommerceStore(database);
  const premium = {
    async isPremium(guildId: string) {
      const entitlement = await guildEntitlements.readGuildEntitlement(guildId);
      return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    },
  };
  const offeringStore = new SqliteCommerceOfferingStore(database, premium);
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
        if (await createSqliteGameAccessStore(database).config(offeringId))
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
