/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  BanCaseService,
  extractBanDetails,
  buildStarterMessage,
  buildCompletedEmbed,
} from "../src/services/ban-case-service";
import type { BanCaseDiscordAdapter } from "../src/services/ban-case-service";
import type { BanCaseConfig, BanCaseSource } from "../src/types";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

const COLD_BODY = "KXWR.xyz 76561199304898090 got banned on COLDASFK: Cheater";

const source: BanCaseSource = {
  guildId: "guild-1",
  sourceId: "source-1",
  publicId: "pub-1",
  name: "COLDASFK bans",
  enabled: true,
  platform: "steam",
  pattern: "^(?<username>.+?) (?<subjectId>\\d{17}) got banned on .+?: (?<reason>.+)$",
  flags: "",
  subjectIdGroup: "subjectId",
  nameGroup: "username",
  reasonGroup: "reason",
  createdAtMs: 100,
  updatedAtMs: 100,
};

const config: BanCaseConfig = {
  guildId: "guild-1",
  enabled: true,
  forumChannelId: "forum-1",
  modRoleIds: [],
  updatedAtMs: 100,
};

function createBanCaseFixture(options: { premium?: boolean } = {}) {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.banCases;
  if (options.premium !== false) {
    fixture.database.execRaw(
      "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 0)",
    );
  }
  const store = afterStoreSeed(
    rawStore,
    Promise.all([rawStore.upsertConfig(config), rawStore.upsertBanCaseSource(source)]),
  );
  return {
    database: fixture.database,
    store,
    guildEntitlements: fixture.stores.guildEntitlements,
    guildAuditLog: fixture.stores.guildAuditLog,
  };
}

function createMockDiscord(): BanCaseDiscordAdapter & {
  threadCreates: { channelId: string; name: string }[];
  messages: { channelId: string }[];
  edits: { channelId: string; messageId: string; components: unknown[] }[];
  tagSwaps: { threadId: string; tags: string[] }[];
  audits: { eventId: string }[];
} {
  const threadCreates: { channelId: string; name: string }[] = [];
  const messages: { channelId: string }[] = [];
  const edits: { channelId: string; messageId: string; components: unknown[] }[] = [];
  const tagSwaps: { threadId: string; tags: string[] }[] = [];
  const audits: { eventId: string }[] = [];
  let threadCounter = 0;

  return {
    threadCreates,
    messages,
    edits,
    tagSwaps,
    audits,
    async createForumThread(input) {
      threadCounter += 1;
      const id = `thread-${threadCounter}`;
      threadCreates.push({ channelId: input.channelId, name: input.name });
      return { id, message: { id: `msg-${threadCounter}` } };
    },
    async createChannelMessage(channelId) {
      messages.push({ channelId });
    },
    async editChannelMessage(channelId, messageId, body) {
      edits.push({ channelId, messageId, components: body.components ?? [] });
    },
    async modifyThread(threadId, appliedTags) {
      tagSwaps.push({ threadId, tags: appliedTags });
    },
    async postAudit(eventId) {
      audits.push({ eventId });
    },
  };
}

function createLogger() {
  const warnings: unknown[][] = [];
  return {
    warnings,
    logger: {
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => {},
    },
  };
}

test("extractBanDetails parses the named groups from the body", () => {
  const details = extractBanDetails(source, COLD_BODY);
  assert.deepEqual(details?.subject, { platform: "steam", id: "76561199304898090" });
  assert.equal(details?.username, "KXWR.xyz");
  assert.equal(details?.reason, "Cheater");
});

test("extractBanDetails returns null when the pattern does not match", () => {
  assert.equal(extractBanDetails(source, "nothing relevant here"), null);
});

test("extractBanDetails returns null when the subject id group is empty", () => {
  const noSubjectSource: BanCaseSource = {
    ...source,
    pattern: "^(?<username>.+?) got banned on .+?: (?<reason>.+)$",
  };
  // No subjectId group present in this regex.
  assert.equal(
    extractBanDetails(noSubjectSource, "KXWR.xyz got banned on COLDASFK: Cheater"),
    null,
  );
});

test("extractBanDetails tolerates missing username/reason groups with defaults", () => {
  const minimalSource: BanCaseSource = {
    ...source,
    pattern: "(?<subjectId>\\d{17})",
    nameGroup: "username",
    reasonGroup: "reason",
  };
  const details = extractBanDetails(minimalSource, "76561199304898090");
  assert.equal(details?.username, "Unknown");
  assert.equal(details?.reason, "No reason provided");
});

test("handleInboundBanWebhook creates a new case for a new subject", async () => {
  const mocks = createBanCaseFixture();
  const discord = createMockDiscord();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 500,
    resolveForumTags: async () => ({ new: "tag-new", completed: "tag-completed" }),
  });

  const result = await service.handleInboundBanWebhook("pub-1", COLD_BODY);
  assert.deepEqual(result, { accepted: true });
  assert.equal((await mocks.store.listBanCases("guild-1")).length, 1);
  assert.equal(discord.threadCreates.length, 1);
  assert.equal(discord.threadCreates[0]?.channelId, "forum-1");
  assert.equal(discord.audits[0]?.eventId, "ban-case.create");
});

test("handleInboundBanWebhook appends to an existing case without changing status", async () => {
  const mocks = createBanCaseFixture();
  const discord = createMockDiscord();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 500,
    resolveForumTags: async () => ({ new: "tag-new", completed: "tag-completed" }),
  });

  // First webhook creates a case.
  await service.handleInboundBanWebhook("pub-1", COLD_BODY);
  assert.equal(discord.threadCreates.length, 1);
  assert.equal(discord.messages.length, 0);

  // Second webhook for the same subject appends and does not create a thread.
  await service.handleInboundBanWebhook("pub-1", COLD_BODY);
  assert.equal(discord.threadCreates.length, 1);
  assert.equal(discord.messages.length, 1);
  assert.equal((await mocks.store.listBanCases("guild-1")).length, 1);
});

test("handleInboundBanWebhook drops the webhook with no-extract when the pattern misses", async () => {
  const mocks = createBanCaseFixture();
  const discord = createMockDiscord();
  const { logger, warnings } = createLogger();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 500,
    logger,
  });

  const result = await service.handleInboundBanWebhook("pub-1", "irrelevant body");
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "no-extract");
  assert.equal((await mocks.store.listBanCases("guild-1")).length, 0);
  assert.match(String(warnings[0]?.[0]), /extraction rule/);
});

test("handleInboundBanWebhook goes dormant for a non-premium guild", async () => {
  const mocks = createBanCaseFixture({ premium: false });
  const discord = createMockDiscord();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 500,
  });

  const result = await service.handleInboundBanWebhook("pub-1", COLD_BODY);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "not-premium");
  assert.equal((await mocks.store.listBanCases("guild-1")).length, 0);
});

test("handleInboundBanWebhook returns source-not-found for an unknown public id", async () => {
  const mocks = createBanCaseFixture();
  const discord = createMockDiscord();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 500,
  });

  const result = await service.handleInboundBanWebhook("unknown-pub", COLD_BODY);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "source-not-found");
});

test("BanCaseService exposes source existence only after a guarded cache fill", async () => {
  const mocks = createBanCaseFixture();
  const service = new BanCaseService(mocks.store, {
    discord: createMockDiscord(),
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
  });

  assert.equal(await service.readCachedInboundBanCaseSource(source.publicId), null);
  assert.equal(await service.hasInboundBanCaseSource(source.publicId), true);
  assert.equal(await service.readCachedInboundBanCaseSource(source.publicId), true);
});

test("BanCaseService shares a supplied source cache across request-scoped instances", async () => {
  let readCount = 0;
  const sourceCache = new Map();
  const mocks = createBanCaseFixture();
  const store = Object.assign(Object.create(mocks.store) as typeof mocks.store, {
    async readBanCaseSourceByPublicId(publicId: string) {
      readCount += 1;
      return publicId === source.publicId ? source : null;
    },
  });
  const options = {
    discord: createMockDiscord(),
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    sourceCache,
  };
  const first = new BanCaseService(store, options);
  const second = new BanCaseService(store, options);

  assert.equal(await first.hasInboundBanCaseSource(source.publicId), true);
  assert.equal(await second.readCachedInboundBanCaseSource(source.publicId), true);
  assert.equal(readCount, 1);
});

test("markCompleted edits the embed, swaps the tag, and audits", async () => {
  const mocks = createBanCaseFixture();
  const discord = createMockDiscord();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 900,
    resolveForumTags: async () => ({ new: "tag-new", completed: "tag-completed" }),
  });

  await service.handleInboundBanWebhook("pub-1", COLD_BODY);
  const [created] = await mocks.store.listBanCases("guild-1");

  const updated = await service.markCompleted("guild-1", created!.caseId, "mod-1", config);
  assert.equal(updated?.status, "completed");

  assert.equal(discord.edits.length, 1);
  assert.deepEqual(discord.edits[0]?.components, [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Mark Completed",
          custom_id: `ban-case:complete:guild-1:${created!.caseId}`,
          disabled: true,
        },
        {
          type: 2,
          style: 2,
          label: "Server actions",
          custom_id: `ban-case:actions:guild-1:${created!.caseId}`,
        },
      ],
    },
  ]);
  assert.equal(discord.tagSwaps.length, 1);
  assert.deepEqual(discord.tagSwaps[0]?.tags, ["tag-completed"]);
  assert.equal(discord.audits.at(-1)?.eventId, "ban-case.status-change");
});

test("buildCompletedEmbed includes the terminal completion state", () => {
  const embed = buildCompletedEmbed(
    {
      guildId: "guild-1",
      caseId: "case-1",
      sourceId: "source-1",
      publicId: "pub-1",
      subject: { platform: "cftools", id: "abc" },
      username: "KXWR.xyz",
      status: "completed",
      threadChannelId: "thread-1",
      threadMessageId: "message-1",
      createdAtMs: 100,
      updatedAtMs: 900,
    },
    "mod-1",
    900_000,
  );

  assert.equal(embed.description, "\u2705 Completed by <@mod-1> at <t:900:F>.");
});

test("markCompleted returns null for an already-completed case", async () => {
  const mocks = createBanCaseFixture();
  const discord = createMockDiscord();
  const service = new BanCaseService(mocks.store, {
    discord,
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    now: () => 900,
  });

  await service.handleInboundBanWebhook("pub-1", COLD_BODY);
  const [created] = await mocks.store.listBanCases("guild-1");

  await service.markCompleted("guild-1", created!.caseId, "mod-1", config);
  const second = await service.markCompleted("guild-1", created!.caseId, "mod-1", config);
  assert.equal(second, null);
});

test("buildStarterMessage embeds the caseId in the Mark Completed button", () => {
  const message = buildStarterMessage(
    source,
    {
      subject: { platform: "steam", id: "1" },
      username: "x",
      reason: "y",
    },
    "case-abc",
  );
  const row = message.components[0] as { components: { custom_id: string }[] };
  assert.equal(row.components[0]?.custom_id, "ban-case:complete:guild-1:case-abc");
});

test("inbound reports, appends and Mark Completed never publish enforcement work", async () => {
  const mocks = createBanCaseFixture();
  const service = new BanCaseService(mocks.store, {
    discord: createMockDiscord(),
    guildEntitlements: mocks.guildEntitlements,
    guildAuditLog: mocks.guildAuditLog,
    resolveForumTags: async () => ({ new: "new", completed: "completed" }),
  });
  try {
    await service.handleInboundBanWebhook("pub-1", COLD_BODY);
    await service.handleInboundBanWebhook("pub-1", COLD_BODY);
    const [c] = await mocks.store.listBanCases("guild-1");
    assert.ok(c);
    await service.markCompleted("guild-1", c.caseId, "staff", config);
    assert.equal(
      mocks.database.query<{ n: number }>("SELECT COUNT(*) AS n FROM ban_case_operations")[0]?.n,
      0,
    );
  } finally {
    mocks.database.close();
  }
});
