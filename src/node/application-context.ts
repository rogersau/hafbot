import { createPostgresGameAccessStore } from "../runtime/postgres/postgres-game-access-store";
import type { RuntimeAppContext } from "../runtime/app-context";
import type { PostgresDatabaseCapability } from "../runtime/postgres/postgres-capability";
import { createPostgresCustomerAuth } from "../runtime/postgres/postgres-customer-auth";

import { createGameAccessRuntime } from "../runtime/postgres/postgres-commerce-game-access-runtime";

import {
  createPostgresWardogsStore,
  createPostgresBanEnforcementStore,
} from "../runtime/postgres/postgres-wardogs-store";
import { wardogsNetworkPolicy } from "../wardogs/config";
import { WardogsService } from "../wardogs/service";
import type { Env } from "../env";
import { readSelfHostedSite } from "../runtime/self-hosted-site";
import { assertValidDiscordPublicKey } from "../discord";

import { createPostgresTicketTranscriptCapabilityStore } from "../runtime/postgres/postgres-ticket-transcript-capability-store";

import { createPostgresPlayerCountStreakReportedStore } from "../runtime/postgres/postgres-player-count-streak-store";

import { repairStrandedBotFlagQueueMessages } from "../services/bot-defense/queue-repair";

import { createPostgresOperationalIncidentStore } from "../runtime/postgres/postgres-operational-incident-store";

import { createPostgresServerLevelCredentialStore } from "../runtime/postgres/postgres-server-level-credential-store";
import { ServerLevelCredentialService } from "../server-levels/credentials";
import { handleServerLevelIngress } from "../server-levels/ingress";
import { createPostgresDiscordAccountStore } from "../runtime/postgres/postgres-discord-account-store";

import { createPostgresWorkspaceStore } from "../runtime/postgres/postgres-workspace-store";

import { parseFeatureFlags } from "../runtime/features";

import { getGuildEntitlementLimits } from "../types";
import { parseImageRulesEnv } from "../services/image-rules/env";
import { parseAiTranscriptSummarizerEnv } from "../services/tickets/ai-transcript-summarizer-env";

import type { GuildEntitlementStore } from "../runtime/contracts";

import { createPostgresBillingRuntime } from "../runtime/billing/postgres-runtime";
import { createPostgresBillingDeliveryRuntime } from "../runtime/billing/postgres-delivery-runtime";
import {
  createPostgresCommerceBuyerRuntime,
  createPostgresCommerceFinancialOperationsRuntime,
  createPostgresCommerceSafeguardsRuntime,
  createPostgresCommerceSupportRuntime,
  createPostgresCommerceRuntime,
  readCommerceConfig,
} from "../runtime/commerce/postgres-runtime";
import { isCommerceFeatureEnabled } from "../commerce/production-readiness";
import { createPostgresPaidRoleRuntime } from "../runtime/commerce/postgres-paid-role-runtime";
import { createPostgresCommerceStore } from "../runtime/postgres/postgres-commerce-store";
import { PostgresCommerceBrandingStore } from "../runtime/postgres/postgres-commerce-branding-store";
import { PostgresCommerceOfferingStore } from "../runtime/postgres/postgres-commerce-offering-store";
import { StripeCommerceOfferingProvider } from "../runtime/commerce/stripe-offering-provider";
import { StripeConnectClient } from "../runtime/commerce/stripe-connect-client";
import { CommerceOfferingService } from "../commerce/offering-service";
import { CommerceSellerLifecycleService } from "../commerce/seller-lifecycle";
import { CommerceSellerReviewNotificationService } from "../commerce/seller-review-notifications";
import { CommerceSalesPanelService } from "../commerce/sales-panel";
import { createDiscordGuildResourceValidator } from "../discord/guild-resource-validator";
import { createDiscordCommerceSalesPanelAdapter } from "../runtime/commerce/discord-sales-panel";
import { createEvidenceMediaCapability } from "../security/evidence-media-capability";
import type { WebhookIngressGuardNamespace } from "../runtime/contracts/webhook-ingress-guard";
import { createPostgresWebhookCredentialStore } from "../security/webhook-credentials/postgres-store";
import { createWebhookCredentialKeyRing } from "../security/webhook-credentials";
import { WebhookCredentialService } from "../security/webhook-credentials/store";

import { createComponentIdSigner, type ComponentIdSigner } from "../security/component-id-signer";
import { postMemberAuditEvent } from "../services/guild-audit-log-service";
import { logServerLevelTelemetry } from "../server-levels/telemetry";

export function createNodeApplicationContext(
  env: Env,
  database: PostgresDatabaseCapability,
  stores: RuntimeAppContext["stores"],
  webhookIngressGuard?: WebhookIngressGuardNamespace,
): RuntimeAppContext {
  const selfHostedSite = readSelfHostedSite(env);
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
  const paidRoles = createPostgresPaidRoleRuntime(env, database);
  const billing = createPostgresBillingRuntime(env, database);
  const billingDelivery = createPostgresBillingDeliveryRuntime(env, database);
  const features = parseFeatureFlags(env);
  const webhookProxyStore = stores.webhookProxy;
  const webhookCredentialService = env.WEBHOOK_CREDENTIAL_KEY_V1
    ? new WebhookCredentialService(
        createPostgresWebhookCredentialStore(database),
        createWebhookCredentialKeyRing({
          keyV1: env.WEBHOOK_CREDENTIAL_KEY_V1,
          keyV2: env.WEBHOOK_CREDENTIAL_KEY_V2,
        }),
      )
    : undefined;
  const playerCountStore = stores.playerCount;
  const guildEntitlementStore = stores.guildEntitlements;
  const commercePremium = {
    async isPremium(guildId: string) {
      const entitlement = await guildEntitlementStore.readGuildEntitlement(guildId);
      return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    },
  };
  const gameAccessStore = createPostgresGameAccessStore(database);
  const wardogs = new WardogsService({
    reservedAccessEnabled: false,
    mutationsEnabled: env.WARDOGS_MUTATIONS_ENABLED === "true",
    commerceGrantsEnabled: false,
    canChangeOrigin: (guildId, targetId) => gameAccessStore.canChangeOrigin(guildId, targetId),
    store: createPostgresWardogsStore(database),
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
    database: database,
    store: gameAccessStore,
    wardogs,
    platformLink: stores.platformLink,
    botUserId: env.BOT_USER_ID,
    botToken: env.DISCORD_BOT_TOKEN,
    queue: env.COMMERCE_GAME_QUEUE,
    premium: commercePremium,
    enabled: false,
    steamEnabled: features.steamLink,
  });
  const commerceSupportService = createPostgresCommerceSupportRuntime(
    env,
    database,
    commercePremium,
  );
  const commerceBrandingStore = new PostgresCommerceBrandingStore(database);
  const commerceFinancialOperations =
    createPostgresCommerceFinancialOperationsRuntime(env, database) ?? undefined;
  const commerceSafeguards = createPostgresCommerceSafeguardsRuntime(database) ?? undefined;
  const commerceAdmin =
    isCommerceFeatureEnabled(env) && commerceConfig
      ? createCommerceAdminServices(
          database,
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
  const commerce = createPostgresCommerceRuntime(env, database, commerceAdmin?.sellerReviews);
  const commerceBuyerCheckoutService = createPostgresCommerceBuyerRuntime(
    env,
    database,
    commercePremium,
    commerceGameAccess.hooks,
  );
  if (commerceAdmin) commerceAdmin.gameAccess = commerceGameAccess;
  const guildR2ObjectStore = stores.guildR2Objects;
  const effectiveGuildPlanStore = stores.effectiveGuildPlans;
  const reactionLimitStore = stores.reactionLimits;
  const evidenceVaultStore = stores.evidenceVault;
  const imageRulesStore = stores.imageRules;
  const botDefenseStore = stores.botDefense;
  const mentionProtectionStore = stores.mentionProtection;
  const guildAuditLogStore = stores.guildAuditLog;
  const whiteLabelBotStore = stores.whiteLabelBots;
  const banCaseStore = stores.banCases;
  const memberVerificationStore = stores.memberVerification;
  const managedMessageStore = stores.managedMessages;
  const messageTemplateStore = stores.messageTemplates;
  const guildServiceSuspensionStore = stores.guildServiceSuspensions;
  const featureSetupStore = stores.featureSetup;
  const suggestionStore = stores.suggestions;
  const operationalIncidentStore = stores.operationalIncidents;
  const adminFeedbackStore = stores.adminFeedback;
  const oneTimeTokenStore = stores.oneTimeTokens;
  const serverLevelStore = stores.serverLevels;
  const serverLevelCredentialService = env.WEBHOOK_CREDENTIAL_KEY_V1
    ? new ServerLevelCredentialService(
        createPostgresServerLevelCredentialStore(database),
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
            admissionGuard: webhookIngressGuard,
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
  const knownGuildStore = stores.knownGuilds;
  const blocklistStore = stores.blocklist;
  const appConfigStore = stores.appConfig;
  const userPreferencesStore = stores.userPreferences;
  const guildRbacStore = stores.guildRbac;
  const productAnalyticsPreferenceStore = stores.productAnalyticsPreferences;
  const timedRoleStore = stores.timedRoles;
  const ticketStore = stores.tickets;
  const ticketTranscriptCapabilities = createPostgresTicketTranscriptCapabilityStore(database);
  const configurationRevisionStore = stores.configurationRevisions;
  const marketplaceStore = stores.marketplace;
  const eventStore = stores.events;
  const lfgStore = stores.lfg;
  const clanStore = stores.clans;
  const platformLinkStore = stores.platformLink;
  const steamWebApiKey = normalizeOptionalString(env.STEAM_WEB_API_KEY);
  const xboxOAuthClientId = normalizeOptionalString(env.XBOX_OAUTH_CLIENT_ID);
  const xboxOAuthClientSecret = normalizeOptionalString(env.XBOX_OAUTH_CLIENT_SECRET);
  const imageRulesClassifierEnv = parseImageRulesEnv(env);
  const aiTranscriptSummarizerEnv = parseAiTranscriptSummarizerEnv(env);
  const webhookProxyLogPersistenceEnabled =
    features.webhookProxy && isEnabled(env.ENABLE_WEBHOOK_PROXY_LOGS);

  const customerAuth = createOptionalPostgresAuth(env, database);
  const discordAccounts = createPostgresDiscordAccountStore(database);
  const workspaceStore = createPostgresWorkspaceStore(database);
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
    workerVersion: env.releaseVersion ?? "development",
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
      reactionRoles: stores.reactionRoles,
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
    ticketTranscriptCapabilities,
    evidenceMediaCapability,
    webhookCredentialService,
    serverLevelIngressHandler,
    wardogsPlayerCountEnabled: env.WARDOGS_PLAYER_COUNT_ENABLED === "true",
    wardogs,
    commerceGameAccess,
    banIncidentStore: createPostgresOperationalIncidentStore(database, "ban-cases"),
    banEnforcementStore: createPostgresBanEnforcementStore(database),
    serverLevelCredentialService,
    serverLevelProcessingAvailable:
      Boolean(env.SERVER_LEVELS_QUEUE) &&
      env.HAF_JOBS_ENABLED === "true" &&
      env.HAF_SCHEDULER_ENABLED === "true",
    webhookIngressGuard: webhookIngressGuard,
    features,
    discordSupportInvite: normalizeOptionalString(env.DISCORD_SUPPORT_INVITE),
    discordCache: env.discordCache,
    playerCountStreakReportedStore: createPostgresPlayerCountStreakReportedStore(database),
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

  return context;
}

function createCommerceAdminServices(
  database: PostgresDatabaseCapability,
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
): import("../runtime/admin-routes").CommerceAdminServices {
  const commerceStore = createPostgresCommerceStore(database);
  const premium = {
    async isPremium(guildId: string) {
      const entitlement = await guildEntitlements.readGuildEntitlement(guildId);
      return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    },
  };
  const offeringStore = new PostgresCommerceOfferingStore(database, premium);
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
        if (await createPostgresGameAccessStore(database).config(offeringId))
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
  const bindingName = secretRef;
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

function createOptionalPostgresAuth(environment: Env, database: PostgresDatabaseCapability) {
  const names = [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "DISCORD_OAUTH_CLIENT_ID",
    "DISCORD_OAUTH_CLIENT_SECRET",
  ] as const;
  const values = names.map((name) => normalizeOptionalString(environment[name]));
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error(`PostgreSQL customer auth requires ${names.join(", ")} together.`);
  }
  return createPostgresCustomerAuth({
    database,
    betterAuthSecret: values[0]!,
    betterAuthUrl: values[1]!,
    discordOAuthClientId: values[2]!,
    discordOAuthClientSecret: values[3]!,
  });
}
