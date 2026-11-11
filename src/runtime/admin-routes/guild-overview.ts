import { defineRoute, type Route } from "../admin-route-registry";
import { guildScopedAccess, requireGuildQueryId } from "../admin-route-guards";
import type {
  BlocklistConfig,
  EvidenceVaultConfig,
  GuildAuditLogConfig,
  ImageRulesConfig,
  LfgConfig,
  MarketplaceConfig,
  NewMemberTimedRoleConfig,
  ManualAssignmentTimedRoleConfig,
  MentionProtectionConfig,
  ReactionLimitConfig,
  TicketPanelConfig,
  TimedRoleAssignment,
  WebhookProxyConfig,
  GuildEntitlementTier,
  ManagedMessage,
  ManagedMessageDraft,
  EventRecord,
  BotDefenseConfig,
  MemberVerificationConfig,
  BanCaseConfig,
  BanCaseSource,
  WhiteLabelBot,
} from "../../types";
import type { PlayerCountServer } from "../../types/player-count";
import type { PlatformLinkConfig, PlatformLinkPlatform } from "../contracts/platform-link-store";
import type {
  AdminGuildOverviewCard,
  AdminGuildOverviewCardStatus,
  AdminGuildOverviewResponse,
  RecommendedNextStep,
} from "../admin-types";
import type { RuntimeStores } from "../app-types";
import type { ClanManagementConfig } from "../../clans";
import type { FeatureReadiness, SetupRun } from "../../feature-setup";
import type { SuggestionsConfig } from "../../suggestions";
import { bindAdminContract } from "../admin-contract-route";
import { getGuildOverview } from "../../contracts/admin/cross-cutting";
import { toIncidentView, type OperationalIncident } from "../../operations/incidents";
import type { CommerceAdminServices } from "./commerce";
import type { ConfiguredGameServer, ServerLevelConfig } from "../../server-levels/model";
import type { WardogsService } from "../../wardogs/service";

export interface GuildOverviewAdminRoutesOptions {
  communityTools?: import("../../community-tools/service").CommunityToolsService;
  reputationServiceForGuild?: (
    guildId: string,
  ) => Promise<import("../../reputation/service").ReputationService>;
  stores: RuntimeStores;
  commerce?: CommerceAdminServices;
  wardogs?: WardogsService;
}

export interface GuildOverviewSummaryInput {
  communityTools?: Partial<
    Record<
      "automation" | "chat-moderation" | "content-feeds" | "reputation",
      { enabled: boolean; configured: boolean }
    >
  >;
  reactionRoles?: import("../../reaction-roles").ReactionRolePanel | null;
  guildId: string;
  tier: GuildEntitlementTier;
  blocklist: BlocklistConfig;
  reactionLimits: ReactionLimitConfig | null;
  timedRoles: {
    assignments: TimedRoleAssignment[];
    newMemberConfig: NewMemberTimedRoleConfig | null;
    manualConfig: ManualAssignmentTimedRoleConfig | null;
  };
  tickets: TicketPanelConfig[];
  lfg: LfgConfig | null;
  clans?: ClanManagementConfig | null;
  suggestions?: SuggestionsConfig | null;
  clanSetupReadiness?: FeatureReadiness;
  marketplace: MarketplaceConfig | null;
  platformLinks: Partial<Record<PlatformLinkPlatform, PlatformLinkConfig | null>>;
  evidenceVault: EvidenceVaultConfig | null;
  imageRules: ImageRulesConfig | null;
  playerCount: PlayerCountServer[];
  wardogs?: {
    networkEnabled: boolean;
    targets: Awaited<ReturnType<WardogsService["list"]>>;
  } | null;
  serverLevels?: { config: ServerLevelConfig | null; servers: ConfiguredGameServer[] };
  webhooks: WebhookProxyConfig[];
  whiteLabelBot: WhiteLabelBot | null;
  guildAuditLog: GuildAuditLogConfig | null;
  mentionProtection?: MentionProtectionConfig | null;
  managedMessages?: { messages: ManagedMessage[]; drafts: ManagedMessageDraft[] };
  events?: EventRecord[];
  botDefense?: BotDefenseConfig | null;
  memberVerification?: MemberVerificationConfig | null;
  banCases?: { config: BanCaseConfig | null; sources: BanCaseSource[] };
  incidents?: OperationalIncident[];
  commerce?: { connected: boolean; publishedOfferings: number };
}

interface GuildOverviewCardDefinition {
  id: string;
  label: string;
  path: string;
  premiumGated: boolean;
  summarize: (input: GuildOverviewSummaryInput) => {
    status: AdminGuildOverviewCardStatus;
    detail: string | null;
    readiness?: FeatureReadiness;
  };
}

const GUILD_OVERVIEW_CARD_ORDER: string[] = [
  "automation",
  "chat-moderation",
  "content-feeds",
  "reputation",
  "reaction-roles",
  "reaction-rules",
  "mention-protection",
  "timed-roles",
  "tickets",
  "managed-messages",
  "commerce",
  "lfg",
  "clans",
  "suggestions",
  "marketplace",
  "events",
  "evidence-vault",
  "player-link",
  "server-levels",
  "image-rules",
  "bot-defense",
  "member-verification",
  "player-count",
  "wardogs",
  "webhooks",
  "ban-cases",
  "white-label-bot",
  "guild-audit-log",
];

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function blocklistEmojiCount(blocklist: BlocklistConfig, guildId: string): number {
  return blocklist.guilds[guildId]?.emojis.length ?? 0;
}

function countTimedRoleRules(input: GuildOverviewSummaryInput): number {
  const newMemberRules =
    input.timedRoles.newMemberConfig?.roles.filter((rule) => rule.enabled !== false).length ?? 0;
  const manualRules =
    input.timedRoles.manualConfig?.roles.filter((rule) => rule.enabled !== false).length ?? 0;
  return newMemberRules + manualRules;
}

function hasPublishedPanel(panels: TicketPanelConfig[]): boolean {
  return panels.some((panel) => panel.panelMessageId);
}

function hasConfiguredPanel(panels: TicketPanelConfig[]): boolean {
  return panels.some((panel) => panel.panelChannelId.trim().length > 0);
}

function hasReadyPanelResources(panels: TicketPanelConfig[]): boolean {
  return panels.some(
    (panel) =>
      panel.panelChannelId.trim().length > 0 &&
      panel.categoryChannelId.trim().length > 0 &&
      panel.transcriptChannelId.trim().length > 0,
  );
}

function hasPublishedLink(input: GuildOverviewSummaryInput): boolean {
  return Object.values(input.platformLinks).some(
    (config) => config?.panelMessageId && config.enabled !== false,
  );
}

function hasConfiguredLink(input: GuildOverviewSummaryInput): boolean {
  return Object.values(input.platformLinks).some(
    (config) => config?.panelChannelId && config.panelChannelId.trim().length > 0,
  );
}

function publishedNoticeDetail(label: string): string {
  return `${label} published`;
}

function configuredNoticeDetail(label: string): string {
  return label === "Noticeboard" ? "Configured" : `${label} configured`;
}

const GUILD_OVERVIEW_CARD_DEFINITIONS: GuildOverviewCardDefinition[] = [
  ...(
    [
      ["automation", "Custom Replies and Schedules"],
      ["chat-moderation", "Chat Moderation"],
      ["content-feeds", "Content Feeds"],
      ["reputation", "Reputation"],
    ] as const
  ).map(([id, label]): GuildOverviewCardDefinition => ({
    id,
    label,
    path: `/admin/${id}`,
    premiumGated: false,
    summarize: (input) => {
      const settings = input.communityTools?.[id];
      return settings?.configured
        ? { status: "configured", detail: settings.enabled ? "Enabled" : "Paused / draft" }
        : { status: "not-set-up", detail: null };
    },
  })),
  {
    id: "reaction-roles",
    label: "Reaction Roles",
    path: "/admin/reaction-roles",
    premiumGated: false,
    summarize: (input) => ({
      status: input.reactionRoles ? "configured" : "not-set-up",
      detail: input.reactionRoles
        ? `${input.reactionRoles.options.length} choices · ${input.reactionRoles.enabled ? "Active" : "Paused / draft"}`
        : null,
    }),
  },
  {
    id: "reaction-rules",
    label: "Reaction Rules",
    path: "/admin/blocklist",
    premiumGated: false,
    summarize: (input) => {
      const emojiCount = blocklistEmojiCount(input.blocklist, input.guildId);
      const limitsEnabled = input.reactionLimits?.limitsEnabled ?? false;
      if (emojiCount > 0) {
        return {
          status: "configured",
          detail: pluralize(emojiCount, "blocked emoji", "blocked emoji"),
        };
      }
      if (limitsEnabled) {
        return { status: "configured", detail: "Limits enabled" };
      }
      return { status: "not-set-up", detail: null };
    },
  },
  {
    id: "mention-protection",
    label: "Mention Protection",
    path: "/admin/mention-protection",
    premiumGated: false,
    summarize: (input) => {
      const config = input.mentionProtection;
      if (!config?.adminEnabled && !config?.spamEnabled) {
        return { status: "not-set-up", detail: null };
      }
      const enabled = [
        config.adminEnabled && "Admin",
        input.tier !== "free" && config.spamEnabled && "Spam",
      ].filter(Boolean);
      if (enabled.length === 0 && config.spamEnabled) {
        return { status: "configured", detail: "Spam dormant on Free" };
      }
      return { status: "configured", detail: `${enabled.join(" + ")} enabled` };
    },
  },
  {
    id: "timed-roles",
    label: "Timed Roles",
    path: "/admin/timed-roles",
    premiumGated: false,
    summarize: (input) => {
      const assignments = input.timedRoles.assignments.length;
      const rules = countTimedRoleRules(input);
      if (assignments > 0) {
        return {
          status: "configured",
          detail: pluralize(assignments, "active assignment", "active assignments"),
        };
      }
      if (rules > 0) {
        return {
          status: "configured",
          detail: pluralize(rules, "automation rule", "automation rules"),
        };
      }
      return { status: "not-set-up", detail: null };
    },
  },
  {
    id: "managed-messages",
    label: "Managed Messages",
    path: "/admin/managed-messages",
    premiumGated: false,
    summarize: (input) => {
      const messages = input.managedMessages?.messages ?? [];
      const drafts = input.managedMessages?.drafts ?? [];
      if (messages.length === 0 && drafts.length === 0) {
        return { status: "not-set-up", detail: null };
      }
      return {
        status: "configured",
        detail: `${pluralize(messages.length, "published message", "published messages")}, ${pluralize(drafts.length, "draft", "drafts")}`,
      };
    },
  },
  {
    id: "tickets",
    label: "Tickets",
    path: "/admin/tickets",
    premiumGated: false,
    summarize: (input) => {
      if (!hasConfiguredPanel(input.tickets)) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      if (!hasReadyPanelResources(input.tickets)) {
        return {
          status: "configured",
          detail: "Setup needs attention",
          readiness: "needs_attention",
        };
      }
      return {
        status: "configured",
        detail: hasPublishedPanel(input.tickets) ? "Panel published" : "Panel configured",
        readiness: hasPublishedPanel(input.tickets) ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "lfg",
    label: "LFG",
    path: "/admin/lfg",
    premiumGated: false,
    summarize: (input) => {
      if (!input.lfg?.noticeChannelId) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return {
        status: "configured",
        detail: input.lfg.noticeMessageId
          ? publishedNoticeDetail("Noticeboard")
          : configuredNoticeDetail("Noticeboard"),
        readiness: input.lfg.noticeMessageId ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "clans",
    label: "Clan Management",
    path: "/admin/clans",
    premiumGated: false,
    summarize: (input) => {
      const readiness = input.clanSetupReadiness;
      if (!readiness || readiness === "not_setup") {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return {
        status: "configured",
        detail: clanReadinessDetail(readiness),
        readiness,
      };
    },
  },
  {
    id: "suggestions",
    label: "Suggestions",
    path: "/admin/suggestions",
    premiumGated: false,
    summarize: (input) => {
      const config = input.suggestions;
      if (!config?.forumChannelId || !config.panelChannelId) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      if (!config.panelMessageId) {
        return {
          status: "configured",
          detail: "Panel needs publishing",
          readiness: "needs_attention",
        };
      }
      return {
        status: "configured",
        detail: config.enabled ? "Panel published" : "Ready but disabled",
        readiness: config.enabled ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "marketplace",
    label: "Marketplace",
    path: "/admin/marketplace",
    premiumGated: false,
    summarize: (input) => {
      if (!input.marketplace?.noticeChannelId) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return {
        status: "configured",
        detail: input.marketplace.noticeMessageId
          ? publishedNoticeDetail("Noticeboard")
          : configuredNoticeDetail("Noticeboard"),
        readiness: input.marketplace.noticeMessageId ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "commerce",
    label: "Commerce",
    path: "/admin/commerce",
    premiumGated: true,
    summarize: (input) => {
      if (!input.commerce?.connected) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return input.commerce.publishedOfferings > 0
        ? {
            status: "configured",
            detail: pluralize(
              input.commerce.publishedOfferings,
              "published offering",
              "published offerings",
            ),
            readiness: "enabled",
          }
        : {
            status: "configured",
            detail: "Seller connected; no published offerings",
            readiness: "ready_disabled",
          };
    },
  },
  {
    id: "events",
    label: "Events",
    path: "/admin/events",
    premiumGated: true,
    summarize: (input) => {
      const events = input.events ?? [];
      return events.length
        ? { status: "configured", detail: pluralize(events.length, "event", "events") }
        : { status: "not-set-up", detail: null };
    },
  },
  {
    id: "evidence-vault",
    label: "Evidence Vault",
    path: "/admin/evidence-vault",
    premiumGated: false,
    summarize: (input) => {
      if (!input.evidenceVault?.auditChannelId.trim()) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return { status: "configured", detail: "Audit channel set", readiness: "enabled" };
    },
  },
  {
    id: "player-link",
    label: "Player Link",
    path: "/admin/player-link",
    premiumGated: false,
    summarize: (input) => {
      if (!hasConfiguredLink(input)) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return {
        status: "configured",
        detail: hasPublishedLink(input) ? "Link panel published" : "Link panel configured",
        readiness: hasPublishedLink(input) ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "server-levels",
    label: "Server Levels (Beta)",
    path: "/admin/server-levels",
    premiumGated: true,
    summarize: (input) => {
      const serverLevels = input.serverLevels;
      if (!serverLevels || (!serverLevels.config && serverLevels.servers.length === 0)) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      const steamLinkConfigured = Boolean(input.platformLinks.steam);
      const allVerified =
        Boolean(serverLevels?.servers.length) &&
        serverLevels!.servers.every((server) => server.webhookVerifiedAtMs !== null);
      if (!steamLinkConfigured || !serverLevels?.servers.length || !allVerified) {
        return {
          status: "configured",
          detail: "Setup needs attention",
          readiness: "needs_attention",
        };
      }
      return {
        status: "configured",
        detail: pluralize(serverLevels.servers.length, "server", "servers"),
        readiness: serverLevels.config?.enabled ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "bot-defense",
    label: "Bot Defense",
    path: "/admin/bot-defense",
    premiumGated: false,
    summarize: (input) => {
      const config = input.botDefense;
      if (!config?.honeypotEnabled && !config?.rateEnabled) {
        const ready = Boolean(
          config?.modQueueChannelId ||
          config?.honeypotChannelIds.length ||
          config?.modRoleIds.length,
        );
        return {
          status: ready ? "configured" : "not-set-up",
          detail: ready ? "Ready but disabled" : null,
          readiness: ready ? "ready_disabled" : "not_setup",
        };
      }
      if (config.honeypotEnabled && config.honeypotChannelIds.length === 0) {
        return {
          status: "configured",
          detail: "Setup needs attention",
          readiness: "needs_attention",
        };
      }
      if (input.tier === "free" && config.rateEnabled && !config.honeypotEnabled) {
        return {
          status: "configured",
          detail: "Rate Detector dormant; Honeypot available",
          readiness: "dormant",
        };
      }
      return {
        status: "configured",
        detail:
          config.honeypotEnabled && config.rateEnabled
            ? "Honeypot + Rate enabled"
            : "Detector enabled",
        readiness: "enabled",
      };
    },
  },
  {
    id: "member-verification",
    label: "Member Verification",
    path: "/admin/member-verification",
    premiumGated: false,
    summarize: (input) => {
      const config = input.memberVerification;
      const resourcesReady = Boolean(
        config?.verifiedRoleId && (config.deliveryMode === "dm" || config.welcomeChannelId),
      );
      if (!config?.enabled) {
        return {
          status: resourcesReady ? "configured" : "not-set-up",
          detail: resourcesReady ? "Ready but disabled" : null,
          readiness: resourcesReady ? "ready_disabled" : "not_setup",
        };
      }
      if (!resourcesReady) {
        return {
          status: "configured",
          detail: "Setup needs attention",
          readiness: "needs_attention",
        };
      }
      const enhanced = config.verificationMethod !== "discord-button";
      return {
        status: "configured",
        detail:
          input.tier === "free" && enhanced
            ? "Basic Discord-button verification available"
            : "Enabled",
        readiness: input.tier === "free" && enhanced ? "dormant" : "enabled",
      };
    },
  },
  {
    id: "ban-cases",
    label: "Ban Cases",
    path: "/admin/ban-cases",
    premiumGated: true,
    summarize: (input) => {
      const config = input.banCases?.config;
      const sources = input.banCases?.sources ?? [];
      if (!config?.forumChannelId && sources.length === 0) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      if (!config?.forumChannelId) {
        return {
          status: "configured",
          detail: "Setup needs attention",
          readiness: "needs_attention",
        };
      }
      return {
        status: "configured",
        detail: pluralize(sources.length, "source", "sources"),
        readiness: config?.enabled ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "image-rules",
    label: "Image Rules",
    path: "/admin/image-rules",
    premiumGated: true,
    summarize: (input) => {
      if (!input.imageRules?.enabled || input.imageRules.targetChannelIds.length === 0) {
        if (input.imageRules?.targetChannelIds.length) {
          return {
            status: "configured",
            detail: "Ready but disabled",
            readiness: "ready_disabled",
          };
        }
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return { status: "configured", detail: "Enabled", readiness: "enabled" };
    },
  },
  {
    id: "player-count",
    label: "Player Count",
    path: "/admin/playercount",
    premiumGated: true,
    summarize: (input) => {
      if (input.playerCount.length === 0) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return {
        status: "configured",
        detail: pluralize(input.playerCount.length, "server", "servers"),
        readiness: "enabled",
      };
    },
  },
  {
    id: "wardogs",
    label: "WARDOGS targets",
    path: "/admin/wardogs",
    premiumGated: false,
    summarize: (input) => {
      const targets = input.wardogs?.targets ?? [];
      if (targets.length === 0) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      const readable =
        input.wardogs?.networkEnabled === true &&
        targets.some(
          (target) =>
            target.credentialConfigured &&
            target.enabled &&
            !target.stale &&
            target.verifiedGeneration === target.generation,
        );
      return {
        status: "configured",
        detail: `${pluralize(targets.length, "target", "targets")} ${
          readable ? "verified" : "prepared; network reads disabled or unverified"
        }`,
        readiness: readable ? "enabled" : "ready_disabled",
      };
    },
  },
  {
    id: "webhooks",
    label: "Webhooks",
    path: "/admin/webhooks",
    premiumGated: true,
    summarize: (input) => {
      if (input.webhooks.length === 0) {
        return { status: "not-set-up", detail: null };
      }
      return { status: "configured", detail: pluralize(input.webhooks.length, "proxy", "proxies") };
    },
  },
  {
    id: "white-label-bot",
    label: "White-Label Bot",
    path: "",
    premiumGated: false,
    summarize: (input) => {
      if (!input.whiteLabelBot) {
        return { status: "not-set-up", detail: "No White-Label Bot" };
      }
      return {
        status: "configured",
        detail: formatWhiteLabelBotStatus(input.whiteLabelBot.status),
      };
    },
  },
  {
    id: "guild-audit-log",
    label: "Guild Audit Log",
    path: "/admin/audit-log",
    premiumGated: false,
    summarize: (input) => {
      if (!input.guildAuditLog?.auditChannelId.trim()) {
        return { status: "not-set-up", detail: null, readiness: "not_setup" };
      }
      return { status: "configured", detail: "Audit channel set", readiness: "enabled" };
    },
  },
];

export const GUILD_OVERVIEW_DEPLOYED_FEATURES = GUILD_OVERVIEW_CARD_DEFINITIONS.filter(
  (definition) => definition.path,
).map(({ id, label, path }) => ({ id, label, path }));

function formatWhiteLabelBotStatus(status: WhiteLabelBot["status"]): string {
  switch (status) {
    case "pending_install":
      return "Pending install";
    case "active":
      return "Active";
    case "suspended":
      return "Suspended";
    case "decommissioning":
      return "Decommissioning";
    case "decommissioned":
      return "Decommissioned";
  }
}

const CARD_DEFINITION_BY_ID = new Map(GUILD_OVERVIEW_CARD_DEFINITIONS.map((def) => [def.id, def]));

const RECOMMENDED_NEXT_STEP_DESCRIPTIONS: Record<string, string> = {
  "reaction-roles": "Let members choose game roles by reacting to a welcome message.",
  "mention-protection": "Protect administrators and members from unwanted mention abuse.",
  "reaction-rules": "Block problematic emoji reactions and set per-message reaction limits.",
  tickets: "Publish a support panel so members can reach the right staff team.",
  "timed-roles": "Assign roles automatically for a fixed duration when members join or on demand.",
  lfg: "Set up a noticeboard channel so members can post looking-for-group requests.",
  clans: "Create the HAF-managed Clan category and configure the request review workflow.",
  suggestions: "Publish a structured community Suggestions Panel and Forum workflow.",
  marketplace: "Set up a marketplace noticeboard so members can post and browse listings.",
  "managed-messages": "Draft and publish reusable Discord announcements.",
  events: "Create a scheduled community event with Discord-native signups.",
  commerce: "Connect an approved Stripe seller and publish a paid Discord role offering.",
  "evidence-vault": "Configure an audit channel for evidence vault submissions.",
  "player-link": "Set up a platform link panel so members can link their gaming accounts.",
  "server-levels": "Award Server XP from verified DayZ attendance.",
  "image-rules": "Enable automated image classification for off-topic moderation.",
  "player-count": "Track and display live player counts from your game servers.",
  "bot-defense": "Enable the Honeypot Detector and staff review workflow.",
  "member-verification": "Welcome new members with a Verify button and Verified Role.",
  "ban-cases": "Connect ban feeds to staff-worked Ban Case threads.",
  webhooks: "Set up webhook proxies to forward messages to external services.",
  "white-label-bot": "Configure a white-label Discord bot for this guild.",
  "guild-audit-log": "Configure a channel to receive the guild audit log.",
};

const RECOMMENDED_NEXT_STEP_PRIORITY = [
  "mention-protection",
  "bot-defense",
  "member-verification",
  "guild-audit-log",
  "tickets",
  "reaction-rules",
  "evidence-vault",
  "timed-roles",
  "lfg",
  "clans",
  "suggestions",
  "marketplace",
  "managed-messages",
  "commerce",
  "events",
  "player-link",
  "server-levels",
  "player-count",
  "webhooks",
  "ban-cases",
];

export function buildRecommendedNextStep(
  cards: AdminGuildOverviewCard[],
  guildId: string,
): RecommendedNextStep | null {
  const candidates = cards.filter(
    (card) => !card.locked && card.status === "not-set-up" && card.path,
  );
  const next = candidates.sort(
    (left, right) => recommendationPriority(left.id) - recommendationPriority(right.id),
  )[0];
  if (!next) return null;

  const description = RECOMMENDED_NEXT_STEP_DESCRIPTIONS[next.id] ?? `Set up ${next.label}.`;

  return {
    featureId: next.id,
    title: `Set up ${next.label}`,
    description,
    ctaHref: buildSetupCtaHref(next.id, next.path, guildId),
  };
}

function recommendationPriority(featureId: string) {
  const index = RECOMMENDED_NEXT_STEP_PRIORITY.indexOf(featureId);
  return index === -1 ? RECOMMENDED_NEXT_STEP_PRIORITY.length : index;
}

function buildSetupCtaHref(featureId: string, path: string, guildId: string): string {
  const scopedPath = `/admin/${encodeURIComponent(guildId)}${path.slice("/admin".length)}`;
  const params = new URLSearchParams();
  if (featureId === "reaction-rules") params.set("tab", "blocklist");
  if (featureId === "tickets") {
    params.set("tab", "panel");
    params.set("wizard", "1");
  }
  if (featureId === "player-link") params.set("platform", "steam");
  const query = params.toString();
  return query ? `${scopedPath}?${query}` : scopedPath;
}

export function buildGuildOverviewCards(
  input: GuildOverviewSummaryInput,
): AdminGuildOverviewCard[] {
  return GUILD_OVERVIEW_CARD_ORDER.map((id) => {
    const definition = CARD_DEFINITION_BY_ID.get(id);
    if (!definition) {
      throw new Error(`Unknown guild overview card: ${id}`);
    }

    const locked = definition.premiumGated && input.tier === "free";
    const summary = definition.summarize(input);
    const featureIncidents = (input.incidents ?? []).filter(
      (incident) => incident.status === "open" && incident.feature === definition.id,
    );
    if (featureIncidents.length > 0) {
      const views = featureIncidents.map(toIncidentView);
      const highestSeverity = views.reduce<"warning" | "error" | "critical">(
        (highest, incident) =>
          severityRank(incident.severity) > severityRank(highest) ? incident.severity : highest,
        "warning",
      );
      return {
        id: definition.id,
        label: definition.label,
        path: definition.path,
        status: "attention",
        detail: views[0]?.summary ?? summary.detail,
        locked: false,
        ...(summary.readiness ? { readiness: summary.readiness } : {}),
        attentionCount: featureIncidents.length,
        highestSeverity,
        attentionSummary: views[0]?.impact ?? null,
      };
    }
    if (locked) {
      return {
        id: definition.id,
        label: definition.label,
        path: definition.path,
        status: "requires-paid-plan",
        detail: `Premium or Premium Plus unlocks ${definition.label}.`,
        locked: true,
        ...(summary.status === "configured" ? { readiness: "dormant" as const } : {}),
      };
    }

    const { status, detail, readiness } = summary;
    return {
      id: definition.id,
      label: definition.label,
      path: definition.path,
      status,
      detail,
      locked: false,
      ...(readiness ? { readiness } : {}),
    };
  });
}

function severityRank(severity: "warning" | "error" | "critical"): number {
  return severity === "critical" ? 3 : severity === "error" ? 2 : 1;
}

export function createGuildOverviewAdminRoutes(
  options: GuildOverviewAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...bindAdminContract(getGuildOverview),
      method: "GET",
      path: "/admin/api/guild-overview",
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const entitlement = await options.stores.guildEntitlements.readGuildEntitlement(guildId);
        const tier = entitlement.tier;

        const [
          blocklist,
          reactionLimits,
          timedRoleAssignments,
          newMemberTimedRoleConfig,
          manualAssignmentTimedRoleConfig,
          ticketPanels,
          lfgConfig,
          clansConfig,
          suggestionsConfig,
          marketplaceConfig,
          steamLinkConfig,
          xboxLinkConfig,
          playstationLinkConfig,
          evidenceVaultConfig,
          imageRulesConfig,
          playerCountServers,
          wardogs,
          serverLevelConfig,
          serverLevelServers,
          webhookProxyConfigs,
          whiteLabelBot,
          guildAuditLogConfig,
          mentionProtectionConfig,
          managedMessages,
          managedMessageDrafts,
          events,
          botDefenseConfig,
          memberVerificationConfig,
          banCaseConfig,
          banCaseSources,
        ] = await Promise.all([
          options.stores.blocklist.readConfig(),
          options.stores.reactionLimits.readReactionLimitConfig(guildId),
          options.stores.timedRoles.listTimedRolesByGuild(guildId),
          options.stores.timedRoles
            .readTimedRoleConfigRules(guildId, "new-member")
            .then((roles) => ({ guildId, roles })),
          options.stores.timedRoles
            .readTimedRoleConfigRules(guildId, "manual-assignment")
            .then((roles) => ({ guildId, roles })),
          options.stores.tickets.listTicketPanelConfigs
            ? options.stores.tickets.listTicketPanelConfigs(guildId)
            : options.stores.tickets
                .readTicketPanelConfig(guildId)
                .then((panel) => (panel ? [panel] : [])),
          options.stores.lfg.readLfgConfig(guildId),
          options.stores.clans?.readConfig(guildId) ?? Promise.resolve(null),
          options.stores.suggestions?.readConfig(guildId) ?? Promise.resolve(null),
          options.stores.marketplace.readMarketplaceConfig(guildId),
          options.stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
          options.stores.platformLink.readPlatformLinkConfig(guildId, "xbox"),
          options.stores.platformLink.readPlatformLinkConfig(guildId, "playstation"),
          options.stores.evidenceVault.readConfig(guildId),
          options.stores.imageRules.readConfig(guildId),
          options.stores.playerCount.listPlayerCountServers(guildId),
          options.wardogs
            ? Promise.all([options.wardogs.setup(), options.wardogs.list(guildId)]).then(
                ([setup, targets]) => ({ networkEnabled: setup.networkEnabled, targets }),
              )
            : Promise.resolve(null),
          options.stores.serverLevels?.readConfig(guildId) ?? Promise.resolve(null),
          options.stores.serverLevels?.listConfiguredGameServers(guildId) ?? Promise.resolve([]),
          options.stores.webhookProxy.listWebhookProxyConfigs(guildId),
          options.stores.whiteLabelBots.readWhiteLabelBot(guildId),
          options.stores.guildAuditLog.readConfig(guildId),
          options.stores.mentionProtection.readConfig(guildId),
          options.stores.managedMessages?.listByGuild(guildId) ?? Promise.resolve([]),
          options.stores.managedMessages?.listDraftsByGuild(guildId) ?? Promise.resolve([]),
          options.stores.events?.listEvents(guildId) ?? Promise.resolve([]),
          options.stores.botDefense?.readConfig(guildId) ?? Promise.resolve(null),
          options.stores.memberVerification?.readConfig(guildId) ?? Promise.resolve(null),
          options.stores.banCases?.readConfig(guildId) ?? Promise.resolve(null),
          options.stores.banCases?.listBanCaseSources(guildId) ?? Promise.resolve([]),
        ]);

        const [activeClanSetupRun, latestClanSetupRun] = options.stores.featureSetup
          ? await Promise.all([
              options.stores.featureSetup.readActiveRun(guildId, "clan_management"),
              options.stores.featureSetup.readLatestRun(guildId, "clan_management"),
            ])
          : [null, null];

        const openIncidents = options.stores.operationalIncidents
          ? await options.stores.operationalIncidents.listByGuild({
              guildId,
              status: "open",
              limit: 100,
            })
          : [];
        const commerceAccount =
          (await options.commerce?.store.readConnectedAccountByGuild(guildId)) ?? null;
        const commerceOfferingsForGuild = commerceAccount
          ? await options.commerce!.catalog.listOfferings(commerceAccount.id)
          : [];

        const communityTools: NonNullable<GuildOverviewSummaryInput["communityTools"]> = {};
        if (options.communityTools) {
          const [automation, moderation, feeds] = await Promise.all([
            options.communityTools.read(guildId, "automation"),
            options.communityTools.read(guildId, "moderation"),
            options.communityTools.read(guildId, "feeds"),
          ]);
          communityTools.automation = {
            enabled: automation.config.enabled,
            configured: automation.revision > 0,
          };
          communityTools["chat-moderation"] = {
            enabled: moderation.config.enabled,
            configured: moderation.revision > 0,
          };
          communityTools["content-feeds"] = {
            enabled: feeds.config.enabled,
            configured: feeds.revision > 0,
          };
        }
        if (options.reputationServiceForGuild) {
          const config = await (
            await options.reputationServiceForGuild(guildId)
          ).getConfig(guildId);
          communityTools.reputation = { enabled: config.enabled, configured: config.revision > 0 };
        }
        const cards = buildGuildOverviewCards({
          communityTools,
          reactionRoles: (await options.stores.reactionRoles?.readPanel(guildId)) ?? null,
          guildId,
          tier,
          blocklist,
          reactionLimits,
          timedRoles: {
            assignments: timedRoleAssignments,
            newMemberConfig: newMemberTimedRoleConfig,
            manualConfig: manualAssignmentTimedRoleConfig,
          },
          tickets: ticketPanels,
          lfg: lfgConfig,
          clans: clansConfig,
          suggestions: suggestionsConfig,
          clanSetupReadiness: resolveClanSetupReadiness(
            clansConfig,
            activeClanSetupRun,
            latestClanSetupRun,
          ),
          marketplace: marketplaceConfig,
          platformLinks: {
            steam: steamLinkConfig,
            xbox: xboxLinkConfig,
            playstation: playstationLinkConfig,
          },
          evidenceVault: evidenceVaultConfig,
          imageRules: imageRulesConfig,
          playerCount: playerCountServers,
          wardogs,
          serverLevels: { config: serverLevelConfig, servers: serverLevelServers },
          webhooks: webhookProxyConfigs,
          whiteLabelBot,
          guildAuditLog: guildAuditLogConfig,
          mentionProtection: mentionProtectionConfig,
          managedMessages: { messages: managedMessages, drafts: managedMessageDrafts },
          events,
          botDefense: botDefenseConfig,
          memberVerification: memberVerificationConfig,
          banCases: { config: banCaseConfig, sources: banCaseSources },
          incidents: openIncidents,
          commerce: {
            connected: commerceAccount !== null,
            publishedOfferings: commerceOfferingsForGuild.filter(
              (offering) => offering.state === "published",
            ).length,
          },
        });

        const response: AdminGuildOverviewResponse = {
          guildId,
          tier,
          cards,
          recommendedNextStep: buildRecommendedNextStep(cards, guildId),
          operations: { openIncidents: openIncidents.map(toIncidentView) },
        };
        return Response.json(response);
      },
    }),
  ];
}

export function resolveClanSetupReadiness(
  config: ClanManagementConfig | null,
  activeRun: SetupRun | null,
  latestRun: SetupRun | null,
): FeatureReadiness {
  if (activeRun) return "setup_incomplete";
  const ready = Boolean(
    config?.categoryId &&
    config.requestPanelChannelId &&
    config.requestReviewCategoryId &&
    config.reviewerRoleIds.length > 0,
  );
  if (ready) return config?.enabled ? "enabled" : "ready_disabled";
  return latestRun?.status === "completed" ? "needs_attention" : "not_setup";
}

function clanReadinessDetail(readiness: FeatureReadiness): string {
  switch (readiness) {
    case "setup_incomplete":
      return "Setup incomplete";
    case "ready_disabled":
      return "Ready but disabled";
    case "enabled":
      return "Enabled";
    case "needs_attention":
      return "Setup needs attention";
    case "dormant":
      return "Dormant";
    default:
      return "Not set up";
  }
}
