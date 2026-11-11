import type { Cache } from "./discord-json-cache";
import type { DiscordAccountStore } from "./contracts/discord-account-store";
import type { QueueProducer } from "./queue-types";
import type { createGameAccessRuntime } from "./postgres/postgres-commerce-game-access-runtime";
import type { createAttendanceObservationRuntime } from "./attendance-observation-runtime";
import type { OperationalIncidentStore as BanIncidentStore } from "../operations/incidents";
import type { EnforcementStore } from "../ban-case-enforcement/store";
import type { WardogsService } from "../wardogs/service";
import type { SelfHostedSite } from "./self-hosted-site";
import type { ServerLevelCredentialService } from "../server-levels/credentials";
import type { ImageRulesClassifierEnv } from "../services/image-rules/env";
import type { AiTranscriptSummarizerEnv } from "../services/tickets/ai-transcript-summarizer-env";
import type { CustomerAuth } from "./auth/customer-auth";
import type { TicketTranscriptBlobStore } from "./contracts";
import type { EvidenceVaultBlobStore, RuntimeAppOptions, RuntimeStores } from "./app-types";
import type { PublicManagedMediaStore } from "../managed-media";

import type { FeatureFlags } from "./features";
import type { WorkspaceStore } from "./workspace-store";

import type { PlayerCountStreakReportedStore } from "../services/player-count-service";
import type { EvidenceMediaCapability } from "../security/evidence-media-capability";
import type { WebhookIngressGuardNamespace } from "./contracts/webhook-ingress-guard";
import type { WebhookCredentialService } from "../security/webhook-credentials/store";
import type { ComponentIdSigner } from "../security/component-id-signer";

export interface RuntimeContextStores extends Required<RuntimeStores> {
  knownGuilds: import("./contracts").KnownGuildStore;
  effectiveGuildPlans: import("./effective-guild-plan").EffectiveGuildPlanStore;
  guildR2Objects: import("./contracts").GuildR2QuotaStore;
}

export interface RuntimeAppContext {
  banAppealServiceForGuild?: import("../moderation-appeals/routes").BanAppealServiceFactory;
  communityTools?: import("../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../reputation/service").ReputationService>;
  sweepReputationRewards?: () => Promise<unknown>;
  resolveGuildBotIdentity: NonNullable<RuntimeAppOptions["resolveGuildBotIdentity"]>;
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
  stores: RuntimeContextStores;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: import("./contracts").TicketTranscriptCapabilityAccess;
  evidenceVaultBlobs?: EvidenceVaultBlobStore;
  publicManagedMedia?: PublicManagedMediaStore;
  evidenceMediaCapability?: EvidenceMediaCapability;
  webhookCredentialService?: WebhookCredentialService;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  serverLevelIngressHandler?: (request: Request) => Promise<Response | null>;
  attendanceObservations?: ReturnType<typeof createAttendanceObservationRuntime>;
  wardogs: WardogsService;
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
