import { testWebhookCredential } from "./support/webhook-credentials";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  buildGuildOverviewCards,
  buildRecommendedNextStep,
  GUILD_OVERVIEW_DEPLOYED_FEATURES,
} from "../src/runtime/admin-routes/guild-overview";
import { ADMIN_GUILD_FEATURE_ROUTES } from "../src/admin/dashboard-routes";
import { createAdminRoutes } from "../src/runtime/admin-routes";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { allowAllAdminAccess } from "./helpers/admin-api";
import { createDefaultMentionProtectionConfig } from "../src/services/mention-protection/message-handler";
import type { RuntimeStores } from "../src/runtime/app-types";
import type { PlatformLinkConfig } from "../src/runtime/contracts/platform-link-store";
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
  WhiteLabelBot,
} from "../src/types";
import type { PlayerCountServer } from "../src/types/player-count";
import type { PlatformLinkPlatform } from "../src/runtime/contracts/platform-link-store";

const guildId = "guild-1";

test("Guild Overview inventory stays aligned with deployed dashboard feature routes", () => {
  assert.deepEqual(
    GUILD_OVERVIEW_DEPLOYED_FEATURES.map(({ id, label, path }) => ({ id, label, path })).sort(
      (a, b) => a.id.localeCompare(b.id),
    ),
    [...ADMIN_GUILD_FEATURE_ROUTES].sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("Guild Overview distinguishes enabled community tools from saved disabled settings", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      communityTools: {
        automation: { configured: true, enabled: true },
        "chat-moderation": { configured: true, enabled: false },
        "content-feeds": { configured: false, enabled: false },
        reputation: { configured: true, enabled: true },
      },
    }),
  );
  assert.deepEqual(
    cards.slice(0, 4).map(({ id, status, detail, locked }) => ({ id, status, detail, locked })),
    [
      { id: "automation", status: "configured", detail: "Enabled", locked: false },
      { id: "chat-moderation", status: "configured", detail: "Paused / draft", locked: false },
      { id: "content-feeds", status: "not-set-up", detail: null, locked: false },
      { id: "reputation", status: "configured", detail: "Enabled", locked: false },
    ],
  );
});

function emptyBlocklist(): BlocklistConfig {
  return { guilds: {}, botUserId: "bot-1" };
}

function configuredBlocklist(): BlocklistConfig {
  return {
    guilds: {
      [guildId]: {
        enabled: true,
        emojis: ["🔥", "🎉"],
        channelMode: "include",
        channelIds: ["channel-1"],
      },
    },
    botUserId: "bot-1",
  };
}

function emptyReactionLimits(): ReactionLimitConfig | null {
  return null;
}

function configuredReactionLimits(): ReactionLimitConfig {
  return {
    guildId,
    limitsEnabled: true,
    maxReactionsPerMessage: 5,
    maxReactionsPerUserPerMessage: 2,
    breachThreshold: 3,
    breachRoleId: null,
    breachRoleDurationMs: null,
    breachDmText: null,
    channelMode: "include",
    channelIds: [],
  };
}

function emptyTimedRoles(): {
  assignments: TimedRoleAssignment[];
  newMemberConfig: NewMemberTimedRoleConfig | null;
  manualConfig: ManualAssignmentTimedRoleConfig | null;
} {
  return { assignments: [], newMemberConfig: null, manualConfig: null };
}

function configuredTimedRoles(): ReturnType<typeof emptyTimedRoles> {
  return {
    assignments: [
      {
        guildId,
        userId: "user-1",
        roleId: "role-1",
        durationInput: "1h",
        expiresAtMs: Date.now() + 3600_000,
      },
    ],
    newMemberConfig: null,
    manualConfig: null,
  };
}

function emptyTickets(): TicketPanelConfig[] {
  return [];
}

function configuredTickets(published = false): TicketPanelConfig[] {
  return [
    {
      guildId,
      panelId: "main",
      panelChannelId: "panel-channel-1",
      categoryChannelId: "category-1",
      transcriptChannelId: "transcript-1",
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
      panelMessageId: published ? "panel-message-1" : null,
      ticketCreationLimit: null,
      ticketLimitRejectionMessage: null,
      enableTicketClaiming: false,
      ticketTypes: [],
    },
  ];
}

function emptyLfg(): LfgConfig | null {
  return null;
}

function configuredLfg(published = false): LfgConfig {
  return {
    guildId,
    noticeChannelId: "notice-channel-1",
    noticeMessageId: published ? "notice-message-1" : null,
    notificationRoleId: null,
    counterVoiceChannelId: null,
    counterDisplayFormat: "LFG ({count})",
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close",
    expiryDurationHours: 24,
    serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
    updatedAtMs: Date.now(),
  };
}

function emptyMarketplace(): MarketplaceConfig | null {
  return null;
}

function configuredMarketplace(published = false): MarketplaceConfig {
  return {
    guildId,
    noticeChannelId: "notice-channel-1",
    noticeMessageId: published ? "notice-message-1" : null,
    logChannelId: null,
    serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
    updatedAtMs: Date.now(),
  };
}

function emptyPlatformLinks(): Partial<Record<PlatformLinkPlatform, PlatformLinkConfig | null>> {
  return { steam: null, xbox: null, playstation: null };
}

function configuredPlatformLinks(published = false): ReturnType<typeof emptyPlatformLinks> {
  return {
    steam: {
      guildId,
      platform: "steam",
      linkedRoleId: null,
      logChannelId: null,
      gameAppIds: [],
      panelTitle: "Link your Steam",
      panelDescription: "Click to link",
      panelButtonLabel: "Link Steam",
      panelButtonStyle: "Primary",
      allowRelink: false,
      allowMultipleLinks: false,
      requireRelinkOnRejoin: false,
      whoisFields: [],
      customLinks: [],
      panelChannelId: "panel-channel-1",
      panelMessageId: published ? "panel-message-1" : null,
      updatedAtMs: Date.now(),
    },
    xbox: null,
    playstation: null,
  };
}

function emptyEvidenceVault(): EvidenceVaultConfig | null {
  return null;
}

function configuredEvidenceVault(): EvidenceVaultConfig {
  return {
    guildId,
    auditChannelId: "audit-channel-1",
    accessRoleIds: [],
    subjectsEnabled: false,
    updatedAtMs: Date.now(),
  };
}

function emptyImageRules(): ImageRulesConfig | null {
  return null;
}

function configuredImageRules(): ImageRulesConfig {
  return {
    guildId,
    enabled: true,
    topicDescription: "Stay on topic",
    autoDeleteThreshold: 0.85,
    modReviewThreshold: 0.65,
    targetChannelIds: ["channel-1"],
    excludedRoleIds: [],
    modQueueChannelId: null,
    modRoleIds: [],
    pingOnQueuePost: true,
    reactOnTopic: false,
    auditOnTopic: false,
    dryRun: false,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

function emptyPlayerCount(): PlayerCountServer[] {
  return [];
}

function configuredPlayerCount(): PlayerCountServer[] {
  return [
    {
      id: "server-1",
      guildId,
      name: "Main",
      provider: "steam-web",
      providerServerId: "1.2.3.4:27015",
      channelId: null,
      alertChannelId: null,
      refreshIntervalMinutes: 10,
      displayFormat: "Players: {count}/{max}",
      offlineFormat: "Players: Offline",
      failureThreshold: 3,
      renameOffsetMinutes: 0,
      lastRenamedAtMs: null,
      lastPlayerCount: null,
      lastMaxSlots: null,
      lastQueueSize: null,
      lastFetchedAtMs: null,
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      lastErrorAtMs: null,
      steamHost: "1.2.3.4",
      steamPort: 27015,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  ];
}

function emptyWebhooks(): WebhookProxyConfig[] {
  return [];
}

function configuredWebhooks(): WebhookProxyConfig[] {
  return [
    {
      guildId,
      publicId: "proxy-1",
      name: "Main proxy",
      enabled: true,
      banLookupEnabled: false,
      banLookupCredentialId: null,
      banLookupAppIds: [],
      destinations: [
        {
          id: "dest-1",
          label: "Discord",
          credentialId: testWebhookCredential("https://example.com/webhook"),
        },
      ],
      defaultDestinationIds: ["dest-1"],
      routingRules: [],
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  ];
}

function emptyGuildAuditLog(): GuildAuditLogConfig | null {
  return null;
}

function configuredGuildAuditLog(): GuildAuditLogConfig {
  return {
    guildId,
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: Date.now(),
  };
}

function configuredMentionProtection(): MentionProtectionConfig {
  const config = createDefaultMentionProtectionConfig(guildId, 100);
  config.spamEnabled = true;
  return config;
}

function whiteLabelBot(status: WhiteLabelBot["status"]): WhiteLabelBot {
  return {
    guildId,
    applicationId: "app-1",
    botUserId: "bot-user-1",
    displayName: "Guild Helper",
    brandFooterText: "Guild Helper",
    status,
    tokenSecretRef: "secrets-store:store-1:WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 200,
  };
}

function buildInput(
  overrides: {
    communityTools?: import("../src/runtime/admin-routes/guild-overview").GuildOverviewSummaryInput["communityTools"];
    tier?: "free" | "premium" | "premium_plus";
    blocklist?: BlocklistConfig;
    reactionLimits?: ReactionLimitConfig | null;
    timedRoles?: ReturnType<typeof emptyTimedRoles>;
    tickets?: TicketPanelConfig[];
    lfg?: LfgConfig | null;
    marketplace?: MarketplaceConfig | null;
    platformLinks?: Partial<Record<PlatformLinkPlatform, PlatformLinkConfig | null>>;
    evidenceVault?: EvidenceVaultConfig | null;
    imageRules?: ImageRulesConfig | null;
    playerCount?: PlayerCountServer[];
    webhooks?: WebhookProxyConfig[];
    guildAuditLog?: GuildAuditLogConfig | null;
    whiteLabelBot?: WhiteLabelBot | null;
    mentionProtection?: MentionProtectionConfig | null;
  } = {},
) {
  return {
    communityTools: overrides.communityTools,
    guildId,
    tier: overrides.tier ?? "free",
    blocklist: overrides.blocklist ?? emptyBlocklist(),
    reactionLimits: overrides.reactionLimits ?? emptyReactionLimits(),
    timedRoles: overrides.timedRoles ?? emptyTimedRoles(),
    tickets: overrides.tickets ?? emptyTickets(),
    lfg: overrides.lfg ?? emptyLfg(),
    marketplace: overrides.marketplace ?? emptyMarketplace(),
    platformLinks: overrides.platformLinks ?? emptyPlatformLinks(),
    evidenceVault: overrides.evidenceVault ?? emptyEvidenceVault(),
    imageRules: overrides.imageRules ?? emptyImageRules(),
    playerCount: overrides.playerCount ?? emptyPlayerCount(),
    webhooks: overrides.webhooks ?? emptyWebhooks(),
    guildAuditLog: overrides.guildAuditLog ?? emptyGuildAuditLog(),
    whiteLabelBot: overrides.whiteLabelBot ?? null,
    mentionProtection: overrides.mentionProtection ?? null,
  };
}

test("buildGuildOverviewCards surfaces all feature cards in the expected order", () => {
  const cards = buildGuildOverviewCards(buildInput({ tier: "premium" }));
  assert.deepEqual(
    cards.map((card) => card.id),
    [
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
    ],
  );
});

test("buildGuildOverviewCards reports White-Label Bot status without exposing secret details", () => {
  const cards = buildGuildOverviewCards(
    buildInput({ tier: "premium_plus", whiteLabelBot: whiteLabelBot("pending_install") }),
  );

  const card = cards.find((c) => c.id === "white-label-bot");
  assert.ok(card);
  assert.equal(card.label, "White-Label Bot");
  assert.equal(card.status, "configured");
  assert.equal(card.detail, "Pending install");
  assert.equal(card.locked, false);
  assert.equal(card.path, "");
  assert.doesNotMatch(JSON.stringify(card), /token|secret/i);
});

test("buildGuildOverviewCards reports no White-Label Bot and active or suspended states", () => {
  const noBot = buildGuildOverviewCards(buildInput({ tier: "premium_plus" })).find(
    (c) => c.id === "white-label-bot",
  );
  const active = buildGuildOverviewCards(
    buildInput({ tier: "premium_plus", whiteLabelBot: whiteLabelBot("active") }),
  ).find((c) => c.id === "white-label-bot");
  const suspended = buildGuildOverviewCards(
    buildInput({ tier: "premium_plus", whiteLabelBot: whiteLabelBot("suspended") }),
  ).find((c) => c.id === "white-label-bot");

  assert.equal(noBot?.status, "not-set-up");
  assert.equal(noBot?.detail, "No White-Label Bot");
  assert.equal(active?.detail, "Active");
  assert.equal(suspended?.detail, "Suspended");
});

test("buildGuildOverviewCards marks only fully paid features as unavailable on Free", () => {
  const mentionProtection = createDefaultMentionProtectionConfig("guild-1", 0);
  mentionProtection.adminEnabled = true;
  mentionProtection.spamEnabled = true;
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "free",
      tickets: configuredTickets(true),
      evidenceVault: configuredEvidenceVault(),
      imageRules: configuredImageRules(),
      webhooks: configuredWebhooks(),
      timedRoles: configuredTimedRoles(),
      mentionProtection,
    }),
  );

  for (const id of ["events", "image-rules", "player-count", "webhooks", "ban-cases"]) {
    const card = cards.find((c) => c.id === id);
    assert.ok(card, `expected ${id} card`);
    assert.equal(card.status, "requires-paid-plan", `${id} should require premium`);
    assert.equal(card.locked, true, `${id} should be locked`);
    assert.match(card.detail ?? "", /Premium/, `${id} should explain the required plan`);
  }

  const timedRoles = cards.find((card) => card.id === "timed-roles");
  assert.equal(timedRoles?.status, "configured");
  assert.equal(timedRoles?.locked, false);

  const evidenceVault = cards.find((card) => card.id === "evidence-vault");
  assert.equal(evidenceVault?.status, "configured");
  assert.equal(evidenceVault?.locked, false);
  assert.equal(evidenceVault?.detail, "Audit channel set");
  const tickets = cards.find((card) => card.id === "tickets");
  assert.equal(tickets?.status, "configured");
  assert.equal(tickets?.locked, false);
  assert.equal(tickets?.detail, "Panel published");
  const mentionProtectionCard = cards.find((card) => card.id === "mention-protection");
  assert.equal(mentionProtectionCard?.status, "configured");
  assert.equal(mentionProtectionCard?.locked, false);
  assert.equal(mentionProtectionCard?.detail, "Admin enabled");
});

test("buildGuildOverviewCards reports configured status and compact details for premium guilds", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      blocklist: configuredBlocklist(),
      reactionLimits: configuredReactionLimits(),
      timedRoles: configuredTimedRoles(),
      tickets: configuredTickets(true),
      lfg: configuredLfg(true),
      marketplace: configuredMarketplace(true),
      platformLinks: configuredPlatformLinks(true),
      evidenceVault: configuredEvidenceVault(),
      imageRules: configuredImageRules(),
      playerCount: configuredPlayerCount(),
      webhooks: configuredWebhooks(),
      guildAuditLog: configuredGuildAuditLog(),
    }),
  );

  const assertCard = (id: string, expectedStatus: string, expectedDetail: string | null) => {
    const card = cards.find((c) => c.id === id);
    assert.ok(card, `expected ${id} card`);
    assert.equal(card.status, expectedStatus, `${id} status`);
    assert.equal(card.detail, expectedDetail, `${id} detail`);
    assert.equal(card.locked, false, `${id} should not be locked`);
  };

  assertCard("reaction-rules", "configured", "2 blocked emoji");
  assertCard("timed-roles", "configured", "1 active assignment");
  assertCard("tickets", "configured", "Panel published");
  assertCard("lfg", "configured", "Noticeboard published");
  assertCard("marketplace", "configured", "Noticeboard published");
  assertCard("evidence-vault", "configured", "Audit channel set");
  assertCard("player-link", "configured", "Link panel published");
  assertCard("image-rules", "configured", "Enabled");
  assertCard("player-count", "configured", "1 server");
  assertCard("webhooks", "configured", "1 proxy");
  assertCard("guild-audit-log", "configured", "Audit channel set");
});

test("buildGuildOverviewCards reports not-set-up for unconfigured free features", () => {
  const cards = buildGuildOverviewCards(buildInput({ tier: "free" }));

  const assertNotSetUp = (id: string) => {
    const card = cards.find((c) => c.id === id);
    assert.ok(card, `expected ${id} card`);
    assert.equal(card.status, "not-set-up", `${id} status`);
    assert.equal(card.detail, null, `${id} detail`);
    assert.equal(card.locked, false, `${id} should not be locked`);
  };

  assertNotSetUp("reaction-rules");
  assertNotSetUp("lfg");
  assertNotSetUp("marketplace");
  assertNotSetUp("player-link");
  assertNotSetUp("guild-audit-log");
});

test("buildGuildOverviewCards exposes correct dashboard paths for click-through", () => {
  const cards = buildGuildOverviewCards(buildInput({ tier: "premium" }));

  const paths: Record<string, string> = {
    "reaction-rules": "/admin/blocklist",
    "mention-protection": "/admin/mention-protection",
    "timed-roles": "/admin/timed-roles",
    tickets: "/admin/tickets",
    "managed-messages": "/admin/managed-messages",
    commerce: "/admin/commerce",
    lfg: "/admin/lfg",
    clans: "/admin/clans",
    marketplace: "/admin/marketplace",
    events: "/admin/events",
    "evidence-vault": "/admin/evidence-vault",
    "player-link": "/admin/player-link",
    "image-rules": "/admin/image-rules",
    "bot-defense": "/admin/bot-defense",
    "member-verification": "/admin/member-verification",
    "player-count": "/admin/playercount",
    wardogs: "/admin/wardogs",
    webhooks: "/admin/webhooks",
    "ban-cases": "/admin/ban-cases",
    suggestions: "/admin/suggestions",
    "guild-audit-log": "/admin/audit-log",
  };

  for (const [id, expectedPath] of Object.entries(paths)) {
    const card = cards.find((c) => c.id === id);
    assert.ok(card, `expected ${id} card`);
    assert.equal(card.path, expectedPath, `${id} path`);
  }
});

test("buildGuildOverviewCards includes Suggestions now that it has a deployed route", () => {
  const cards = buildGuildOverviewCards(buildInput({ tier: "premium" }));
  assert.equal(
    cards.some((card) => card.id === "suggestions"),
    true,
  );
});

test("buildGuildOverviewCards uses configured details when published message exists", () => {
  const unpublished = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      tickets: configuredTickets(false),
      lfg: configuredLfg(false),
      marketplace: configuredMarketplace(false),
      platformLinks: configuredPlatformLinks(false),
    }),
  );

  assert.equal(unpublished.find((c) => c.id === "tickets")?.detail, "Panel configured");
  assert.equal(unpublished.find((c) => c.id === "lfg")?.detail, "Configured");
  assert.equal(unpublished.find((c) => c.id === "marketplace")?.detail, "Configured");
  assert.equal(unpublished.find((c) => c.id === "player-link")?.detail, "Link panel configured");
});

test("buildGuildOverviewCards exposes setup readiness across resource-backed surfaces", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      tickets: configuredTickets(false),
      lfg: configuredLfg(true),
      marketplace: configuredMarketplace(false),
      platformLinks: configuredPlatformLinks(true),
      evidenceVault: configuredEvidenceVault(),
      imageRules: configuredImageRules(),
      playerCount: configuredPlayerCount(),
      guildAuditLog: configuredGuildAuditLog(),
    }),
  );

  assert.equal(cards.find((card) => card.id === "tickets")?.readiness, "ready_disabled");
  assert.equal(cards.find((card) => card.id === "lfg")?.readiness, "enabled");
  assert.equal(cards.find((card) => card.id === "marketplace")?.readiness, "ready_disabled");
  assert.equal(cards.find((card) => card.id === "player-link")?.readiness, "enabled");
  assert.equal(cards.find((card) => card.id === "evidence-vault")?.readiness, "enabled");
  assert.equal(cards.find((card) => card.id === "image-rules")?.readiness, "enabled");
  assert.equal(cards.find((card) => card.id === "player-count")?.readiness, "enabled");
  assert.equal(cards.find((card) => card.id === "guild-audit-log")?.readiness, "enabled");
});

test("buildGuildOverviewCards reports configured paid features as dormant after downgrade", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "free",
      imageRules: configuredImageRules(),
      playerCount: configuredPlayerCount(),
    }),
  );

  assert.equal(cards.find((card) => card.id === "image-rules")?.readiness, "dormant");
  assert.equal(cards.find((card) => card.id === "player-count")?.readiness, "dormant");
});

test("buildGuildOverviewCards treats reaction limits as a detail on the reaction rules card", () => {
  const noBlocklist = buildGuildOverviewCards(
    buildInput({ tier: "premium", reactionLimits: configuredReactionLimits() }),
  );
  const withBlocklist = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      blocklist: configuredBlocklist(),
      reactionLimits: configuredReactionLimits(),
    }),
  );

  assert.equal(noBlocklist.find((c) => c.id === "reaction-rules")?.status, "configured");
  assert.equal(noBlocklist.find((c) => c.id === "reaction-rules")?.detail, "Limits enabled");
  assert.equal(withBlocklist.find((c) => c.id === "reaction-rules")?.detail, "2 blocked emoji");
});

test("buildGuildOverviewCards counts timed role automation rules when no active assignments", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      timedRoles: {
        assignments: [],
        newMemberConfig: { guildId, roles: [{ roleId: "role-1", durationInput: "1d" }] },
        manualConfig: { guildId, roles: [{ roleId: "role-2", durationInput: "1h" }] },
      },
    }),
  );

  const card = cards.find((c) => c.id === "timed-roles");
  assert.ok(card);
  assert.equal(card.status, "configured");
  assert.equal(card.detail, "2 automation rules");
});

function createStubStores(tier: "free" | "premium" = "free"): RuntimeStores {
  return {
    blocklist: {
      readConfig: async () => ({ guilds: {}, botUserId: "bot-1" }),
    },
    reactionLimits: {
      readReactionLimitConfig: async () => null,
    },
    timedRoles: {
      listTimedRolesByGuild: async () => [],
      readNewMemberTimedRoleConfig: async () => ({ guildId, roles: [] }),
      readManualAssignmentTimedRoleConfig: async () => ({ guildId, roles: [] }),
    },
    tickets: {
      listTicketPanelConfigs: async () => [],
    },
    lfg: {
      readLfgConfig: async () => null,
    },
    marketplace: {
      readMarketplaceConfig: async () => null,
    },
    platformLink: {
      readPlatformLinkConfig: async () => null,
    },
    evidenceVault: {
      readConfig: async () => null,
    },
    imageRules: {
      readConfig: async () => null,
    },
    playerCount: {
      listPlayerCountServers: async () => [],
    },
    webhookProxy: {
      listWebhookProxyConfigs: async () => [],
    },
    whiteLabelBots: {
      readWhiteLabelBot: async () => null,
      listActiveWhiteLabelBots: async () => [],
    },
    guildAuditLog: {
      readConfig: async () => null,
    },
    mentionProtection: {
      readConfig: async () => null,
    },
    guildEntitlements: {
      readGuildEntitlement: async () => ({ guildId, tier, updatedAtMs: Date.now() }),
    },
    memberVerification: {
      readConfig: async () => null,
    },
  } as unknown as RuntimeStores;
}

const enabledFeatures = {
  lfg: true,
  marketplace: true,
  tickets: true,
  blocklist: true,
  timedRoles: true,
  webhookProxy: true,
  adminUi: true,
  playerCount: true,
  steamLink: true,
  xboxLink: true,
  playstationLink: true,
  evidenceVault: true,
  imageRules: true,
  banCases: true,
  botDefense: true,
  mentionProtection: true,
  guildAuditLog: true,
  memberVerification: true,
  events: true,
};

test("GET /admin/api/guild-overview returns a card summary for the requested guild", async () => {
  const routes = createAdminRoutes({
    stores: createStubStores("premium"),
    adminAccess: allowAllAdminAccess,
    discordBotToken: "test",
    features: enabledFeatures,
  });
  const request = new Request("https://example.com/admin/api/guild-overview?guildId=guild-1");
  const response = await dispatchAdminRoute(routes, request, {
    adminAccess: allowAllAdminAccess,
    features: enabledFeatures,
    stores: createStubStores("premium"),
  });

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as { guildId: string; tier: string; cards: unknown[] };
  assert.equal(body.guildId, "guild-1");
  assert.equal(body.tier, "premium");
  assert.ok(Array.isArray(body.cards));
  assert.ok(body.cards.length >= 10);
});

test("GET /admin/api/guild-overview requires guildId", async () => {
  const routes = createAdminRoutes({
    stores: createStubStores(),
    adminAccess: allowAllAdminAccess,
    discordBotToken: "test",
    features: enabledFeatures,
  });
  const request = new Request("https://example.com/admin/api/guild-overview");
  const response = await dispatchAdminRoute(routes, request, {
    adminAccess: allowAllAdminAccess,
    features: enabledFeatures,
    stores: createStubStores(),
  });

  assert.equal(response?.status, 400);
});

test("buildRecommendedNextStep prioritizes a high-impact unlocked feature", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      blocklist: configuredBlocklist(),
      reactionLimits: configuredReactionLimits(),
      timedRoles: configuredTimedRoles(),
      mentionProtection: configuredMentionProtection(),
    }),
  );

  const step = buildRecommendedNextStep(cards, guildId);
  assert.ok(step, "expected a recommended next step");
  assert.equal(step.featureId, "bot-defense");
  assert.equal(step.title, "Set up Bot Defense");
  assert.ok(step.description.length > 0);
  assert.ok(step.ctaHref.includes(guildId), "ctaHref should include the guildId");
  assert.ok(step.ctaHref.includes("bot-defense"));
});

test("buildRecommendedNextStep skips configured features and recommends the next gap", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      blocklist: configuredBlocklist(),
      reactionLimits: configuredReactionLimits(),
      tickets: configuredTickets(true),
      lfg: configuredLfg(true),
    }),
  );

  const step = buildRecommendedNextStep(cards, guildId);
  assert.ok(step);
  assert.notEqual(step.featureId, "reaction-rules");
  assert.notEqual(step.featureId, "tickets");
  assert.notEqual(step.featureId, "lfg");
});

test("buildRecommendedNextStep skips locked premium-gated features for free guilds", () => {
  const cards = buildGuildOverviewCards(buildInput({ tier: "free" }));

  const step = buildRecommendedNextStep(cards, guildId);
  assert.ok(step, "expected a recommended next step for a free guild");
  assert.notEqual(step.featureId, "tickets");
  assert.notEqual(step.featureId, "evidence-vault");
  assert.notEqual(step.featureId, "image-rules");
});

test("buildRecommendedNextStep ranks security fundamentals above lower-priority gaps", () => {
  const cards = buildGuildOverviewCards(
    buildInput({
      tier: "premium",
      blocklist: configuredBlocklist(),
      reactionLimits: configuredReactionLimits(),
      timedRoles: configuredTimedRoles(),
      tickets: configuredTickets(true),
      lfg: configuredLfg(true),
      marketplace: configuredMarketplace(true),
      platformLinks: configuredPlatformLinks(true),
      evidenceVault: configuredEvidenceVault(),
      imageRules: configuredImageRules(),
      playerCount: configuredPlayerCount(),
      webhooks: configuredWebhooks(),
      guildAuditLog: configuredGuildAuditLog(),
      mentionProtection: configuredMentionProtection(),
    }),
  );

  const step = buildRecommendedNextStep(cards, guildId);
  assert.equal(step?.featureId, "bot-defense");
});
