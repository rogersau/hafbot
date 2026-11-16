import type { ObservationStore } from "../../server-levels/observations/store";
import type { GatewayCommerceLifecycle } from "../gateway-commerce-lifecycle";
import type { GatewayReactionStore } from "../contracts/gateway-reaction-store";
import type {
  GuildAuditLogStore,
  GuildServiceSuspensionStore,
  BlocklistStore,
  BotDefenseStore,
  ImageRulesStore,
  GuildEntitlementStore,
  GuildRbacStore,
  KnownGuildStore,
  ProductAnalyticsPreferenceStore,
  LfgStore,
  ClanStore,
  ManagedMessageStore,
  MemberVerificationStore,
  MentionProtectionStore,
  PlatformLinkStore,
  ReactionLimitStore,
  TicketStore,
  TimedRoleStore,
  WhiteLabelBotStore,
  SuggestionStore,
  ServerLevelStore,
} from "../contracts";
import type { WebhookCredentialStore } from "../../security/webhook-credentials/store";
import type { Env } from "../../env";
import type { GatewayEventOperationRunner } from "../gateway-event-idempotency";
import type { parseFeatureFlags } from "../features";
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
  readonly commerceLifecycle: GatewayCommerceLifecycle | null;
  readonly discord: GatewayDiscordCapabilities;
  readonly standardDiscord: GatewayDiscordCapabilities;
  readonly mentionProtection: MentionProtectionMessageDependencies;
  readonly stores: GatewayEventStores;
  readonly clanService: Pick<
    ClanService,
    "handleGuildMemberDeparture" | "handleManagedResourceDeleted"
  >;
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
  reactionRole: import("../contracts/reaction-role-store").ReactionRoleStore;
  audit: GuildAuditLogStore;
  guildServiceSuspensions: GuildServiceSuspensionStore;
  blocklist: BlocklistStore;
  botDefense: BotDefenseStore;
  imageRules: ImageRulesStore;
  entitlement: GuildEntitlementStore;
  guildRbac: GuildRbacStore;
  knownGuild: KnownGuildStore;
  productAnalyticsPreferences: ProductAnalyticsPreferenceStore;
  lfg: LfgStore;
  clan: ClanStore;
  managedMessage: ManagedMessageStore;
  memberVerification: MemberVerificationStore;
  mentionProtection: MentionProtectionStore;
  platformLink: PlatformLinkStore;
  reactionLimit: ReactionLimitStore;
  reactionMutations: GatewayReactionStore;
  ticket: TicketStore;
  timedRole: TimedRoleStore;
  whiteLabel: WhiteLabelBotStore;
  suggestion: SuggestionStore;
  serverLevel: ServerLevelStore;
  observations: Pick<ObservationStore, "eraseGuild">;
  webhookCredential: WebhookCredentialStore;
}
