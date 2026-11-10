import type { Env } from "../../env";
import type { GatewayEventOperationRunner } from "../gateway-event-idempotency";
import type { parseFeatureFlags } from "../features";
import type { createCloudflareBlocklistStore } from "../cloudflare-blocklist-store";
import type { createCloudflareGuildAuditLogStore } from "../cloudflare-guild-audit-log-store";
import type { createCloudflareGuildEntitlementStore } from "../cloudflare-guild-entitlement-store";
import type { createCloudflareGuildRbacStore } from "../cloudflare-guild-rbac-store";
import type { createCloudflareKnownGuildStore } from "../cloudflare-known-guild-store";
import type { createCloudflareProductAnalyticsPreferenceStore } from "../cloudflare-product-analytics-preference-store";
import type { createCloudflareLfgStore } from "../cloudflare-lfg-store";
import type { createCloudflareClanStore } from "../cloudflare-clan-store";
import type { createCloudflareManagedMessageStore } from "../cloudflare-managed-message-store";
import type { createCloudflareMemberVerificationStore } from "../cloudflare-member-verification-store";
import type { createCloudflareMentionProtectionStore } from "../cloudflare-mention-protection-store";
import type { createCloudflarePlatformLinkStore } from "../cloudflare-platform-link-store";
import type { createCloudflareReactionLimitStore } from "../cloudflare-reaction-limit-store";
import type { createCloudflareTicketStore } from "../cloudflare-ticket-store";
import type { createCloudflareTimedRoleStore } from "../cloudflare-timed-role-store";
import type { createCloudflareWhiteLabelBotStore } from "../cloudflare-white-label-bot-store";
import type { createCloudflareSuggestionStore } from "../cloudflare-suggestion-store";
import type { createCloudflareServerLevelStore } from "../cloudflare-server-level-store";
import type { createCloudflareWebhookCredentialStore } from "../../security/webhook-credentials/cloudflare-store";
import type { GatewayDiscordCapabilities } from "./discord-capabilities";
import type { MentionProtectionMessageDependencies } from "../../services/mention-protection/message-handler";
import type { ClanService } from "../../services/clan-service";
import type { ProductAnalyticsReporter } from "../../product-analytics";
import type { MemberVerificationService } from "../../services/member-verification-service";

export interface GatewayEventEnvelope {
  version: 2;
  eventKey: string;
  receivedAtMs?: number;
  sessionId: string | null;
  sequence: number | null;
  type: string;
  data: unknown;
  botIdentityId?: string | null;
  botUserId?: string | null;
  previousRoleIds?: string[] | null;
  previousNick?: string | null;
  emptiedVoiceChannelId?: string | null;
}

export interface GatewayEventQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export interface GatewayEventCapabilities {
  readonly env: Env;
  readonly botEnv: Env;
  readonly features: ReturnType<typeof parseFeatureFlags>;
  readonly operations: GatewayEventOperationRunner;
  readonly discord: GatewayDiscordCapabilities;
  readonly standardDiscord: GatewayDiscordCapabilities;
  readonly mentionProtection: MentionProtectionMessageDependencies | null;
  readonly stores: GatewayEventStores | null;
  readonly clanService: Pick<
    ClanService,
    "handleGuildMemberDeparture" | "handleManagedResourceDeleted"
  > | null;
  readonly memberVerificationService: Pick<MemberVerificationService, "handleMemberAdd"> | null;
  readonly productAnalytics: ProductAnalyticsReporter;
  resolveBotDisplayName(guildId: string): Promise<string>;
  resolveFooterText(guildId: string): Promise<string>;
}

export interface GatewayEventStores {
  communityTools?: import("../../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../../reputation/service").ReputationService>;
  reactionRole?: import("../contracts/reaction-role-store").ReactionRoleStore;
  audit: ReturnType<typeof createCloudflareGuildAuditLogStore>;
  blocklist: ReturnType<typeof createCloudflareBlocklistStore>;
  entitlement: ReturnType<typeof createCloudflareGuildEntitlementStore>;
  guildRbac: ReturnType<typeof createCloudflareGuildRbacStore>;
  knownGuild: ReturnType<typeof createCloudflareKnownGuildStore>;
  productAnalyticsPreferences: ReturnType<typeof createCloudflareProductAnalyticsPreferenceStore>;
  lfg: ReturnType<typeof createCloudflareLfgStore>;
  clan: ReturnType<typeof createCloudflareClanStore>;
  managedMessage: ReturnType<typeof createCloudflareManagedMessageStore>;
  memberVerification: ReturnType<typeof createCloudflareMemberVerificationStore>;
  mentionProtection: ReturnType<typeof createCloudflareMentionProtectionStore>;
  platformLink: ReturnType<typeof createCloudflarePlatformLinkStore>;
  reactionLimit: ReturnType<typeof createCloudflareReactionLimitStore>;
  ticket: ReturnType<typeof createCloudflareTicketStore>;
  timedRole: ReturnType<typeof createCloudflareTimedRoleStore>;
  whiteLabel: ReturnType<typeof createCloudflareWhiteLabelBotStore>;
  suggestion: ReturnType<typeof createCloudflareSuggestionStore>;
  serverLevel: ReturnType<typeof createCloudflareServerLevelStore>;
  webhookCredential: ReturnType<typeof createCloudflareWebhookCredentialStore>;
}
