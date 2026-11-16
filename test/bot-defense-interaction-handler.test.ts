/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test, { after } from "node:test";

import type { BotDefenseConfig, BotFlag } from "../src/types";
import { buildBotDefenseComponentId } from "../src/bot-defense-component-id";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";
import {
  handleBotDefenseComponentInteraction,
  isBotDefenseComponentInteraction,
} from "../src/runtime/bot-defense-interaction-handler";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";

const config: BotDefenseConfig = {
  guildId: "guild-1",
  honeypotEnabled: true,
  honeypotWarnUser: false,
  honeypotDeleteMessage: false,
  rateEnabled: true,
  rateWarnUser: false,
  rateDeleteMessage: false,
  honeypotChannelIds: ["channel-1"],
  rateChannelThreshold: 5,
  rateWindowSeconds: 60,
  excludedRoleIds: [],
  modRoleIds: ["mod-role-1"],
  modQueueChannelId: "queue-channel-1",
  pingOnQueuePost: false,
  createdAtMs: 100,
  updatedAtMs: 100,
};

const flag: BotFlag = {
  guildId: "guild-1",
  userId: "user-1",
  status: "open",
  detectorType: "honeypot",
  evidence: { kind: "honeypot", channelId: "channel-1", messageId: "msg-1" },
  queueMessageId: "queue-message-1",
  resolvedByDiscordUserId: null,
  resolvedAtMs: null,
  createdAtMs: 100,
  updatedAtMs: 100,
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ id: "queue-message-1" }), { status: 200 });
after(() => {
  globalThis.fetch = originalFetch;
});

function createStores(
  options: {
    config?: BotDefenseConfig;
    openFlag?: boolean;
  } = {},
): RuntimeStores {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.botDefense;
  const ready = (async () => {
    await rawStore.upsertConfig(options.config ?? config);
    if (options.openFlag !== false) {
      const opened = await rawStore.openBotFlag(
        flag.guildId,
        flag.userId,
        flag.detectorType,
        flag.evidence,
      );
      if (!opened) throw new Error("Expected the Bot Defense test flag to open.");
      await rawStore.setBotFlagQueueMessage(
        flag.guildId,
        flag.userId,
        opened.createdAtMs,
        flag.queueMessageId!,
        flag.updatedAtMs,
      );
    }
  })();
  return { ...fixture.stores, botDefense: afterStoreSeed(rawStore, ready) };
}

function buildInteractionForGeneration(
  createdAtMs: number,
  overrides: Partial<DiscordInteraction> = {},
): DiscordInteraction {
  return {
    type: 3,
    guild_id: "guild-1",
    member: {
      permissions: "0",
      roles: ["mod-role-1"],
      user: { id: "mod-1", username: "Mod", global_name: "Mod" },
    },
    data: { custom_id: buildBotDefenseComponentId("confirm", "guild-1", "user-1", createdAtMs) },
    ...overrides,
  };
}

async function currentFlagGeneration(stores: RuntimeStores): Promise<number> {
  return (
    (await stores.botDefense.readOpenBotFlag("guild-1", "user-1"))?.createdAtMs ?? flag.createdAtMs
  );
}

async function buildCurrentInteraction(
  stores: RuntimeStores,
  overrides: Partial<DiscordInteraction> = {},
): Promise<DiscordInteraction> {
  return buildInteractionForGeneration(await currentFlagGeneration(stores), overrides);
}

test("isBotDefenseComponentInteraction recognises Bot Defense buttons", () => {
  assert.equal(
    isBotDefenseComponentInteraction(buildInteractionForGeneration(flag.createdAtMs)),
    true,
  );
  assert.equal(
    isBotDefenseComponentInteraction(
      buildInteractionForGeneration(flag.createdAtMs, {
        data: { custom_id: "image-rules:approve:1" },
      }),
    ),
    false,
  );
});

test("handleBotDefenseComponentInteraction allows a configured mod role to confirm", async () => {
  let editBody: unknown = null;
  globalThis.fetch = async (_input, init) => {
    editBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ id: "queue-message-1" }), { status: 200 });
  };
  const stores = createStores();
  const response = await handleBotDefenseComponentInteraction(
    await buildCurrentInteraction(stores),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /No automatic action/);
  const components = (
    editBody as { components?: Array<{ components?: Array<{ disabled?: boolean }> }> }
  ).components;
  assert.equal(
    components?.[0]?.components?.every((component) => component.disabled === true),
    true,
  );
});

test("handleBotDefenseComponentInteraction allows a configured mod role to dismiss", async () => {
  const stores = createStores();
  const generation = await currentFlagGeneration(stores);
  const response = await handleBotDefenseComponentInteraction(
    buildInteractionForGeneration(generation, {
      data: {
        custom_id: buildBotDefenseComponentId("dismiss", "guild-1", "user-1", generation),
      },
    }),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /Flag dismissed/);
});

test("a stale Bot Defense button cannot resolve a dismissed generation after re-flagging", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: "queue-message-2" }), { status: 200 });
  };

  const stores = createStores();
  const first = await stores.botDefense.readOpenBotFlag("guild-1", "user-1");
  assert.ok(first);
  const dismissed = await stores.botDefense.resolveBotFlag(
    "guild-1",
    "user-1",
    first.createdAtMs,
    "dismissed",
    "mod-1",
  );
  assert.equal(dismissed?.status, "dismissed");

  const second = await stores.botDefense.openBotFlag("guild-1", "user-1", "rate", {
    kind: "rate",
    channelIds: ["channel-2"],
    channelCount: 5,
    windowSeconds: 60,
  });
  assert.ok(second);
  await stores.botDefense.setBotFlagQueueMessage(
    "guild-1",
    "user-1",
    second.createdAtMs,
    "queue-message-2",
    second.updatedAtMs,
  );

  const response = await handleBotDefenseComponentInteraction(
    buildInteractionForGeneration(first.createdAtMs),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /stale/);
  assert.equal(fetchCalls, 0);
  const current = await stores.botDefense.readOpenBotFlag("guild-1", "user-1", second.createdAtMs);
  assert.equal(current?.status, "open");
  assert.equal(current?.queueMessageId, "queue-message-2");
});

test("already-issued Bot Defense controls are explicitly rejected", async () => {
  const stores = createStores();
  const response = await handleBotDefenseComponentInteraction(
    buildInteractionForGeneration(flag.createdAtMs, {
      data: { custom_id: "bot-defense:confirm:guild-1:user-1" },
    }),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /Unsupported Bot Defense action/);
});

test("concurrent Confirm and Dismiss interactions produce one matching outcome", async () => {
  const fixture = createProductionRuntimeStores();
  const previousFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

  try {
    await fixture.stores.botDefense.upsertConfig(config);
    const opened = await fixture.stores.botDefense.openBotFlag(
      flag.guildId,
      flag.userId,
      flag.detectorType,
      flag.evidence,
    );
    assert.ok(opened);
    await fixture.stores.botDefense.setBotFlagQueueMessage(
      flag.guildId,
      flag.userId,
      opened.createdAtMs,
      flag.queueMessageId!,
      flag.updatedAtMs,
    );
    await fixture.stores.guildAuditLog.upsertConfig({
      guildId: flag.guildId,
      auditChannelId: "audit-channel-1",
      groupChannelIds: { "bot-defense": "audit-channel-1" },
      eventStates: { groups: {}, overrides: {} },
      updatedAtMs: 0,
    });

    globalThis.fetch = async (input, init) => {
      fetchCalls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(
        JSON.stringify({ id: "response-message-1", channel_id: "audit-channel-1" }),
        { status: 200 },
      );
    };

    let readCount = 0;
    let releaseReads = () => {};
    const bothReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const botDefense = {
      ...fixture.stores.botDefense,
      readOpenBotFlag: async (guildId: string, userId: string, expectedCreatedAtMs?: number) => {
        const openFlag = await fixture.stores.botDefense.readOpenBotFlag(
          guildId,
          userId,
          expectedCreatedAtMs,
        );
        readCount += 1;
        if (readCount === 2) releaseReads();
        await bothReads;
        return openFlag;
      },
    };
    const stores = { ...fixture.stores, botDefense } as RuntimeStores;

    const [confirmResponse, dismissResponse] = await Promise.all([
      handleBotDefenseComponentInteraction(
        buildInteractionForGeneration(opened.createdAtMs, {
          member: { permissions: "0", roles: ["mod-role-1"], user: { id: "mod-confirm" } },
        }),
        stores,
        "bot-token",
      ),
      handleBotDefenseComponentInteraction(
        buildInteractionForGeneration(opened.createdAtMs, {
          member: { permissions: "0", roles: ["mod-role-1"], user: { id: "mod-dismiss" } },
          data: {
            custom_id: buildBotDefenseComponentId(
              "dismiss",
              "guild-1",
              "user-1",
              opened.createdAtMs,
            ),
          },
        }),
        stores,
        "bot-token",
      ),
    ]);
    const responseBodies = (await Promise.all([
      confirmResponse.json(),
      dismissResponse.json(),
    ])) as Array<{ data: { content?: string } }>;
    const responseContents = responseBodies.map((body) => body.data.content ?? "");
    const confirmed = "Flag confirmed. No automatic action was taken.";
    const dismissed = "Flag dismissed.";
    const handled = "This Bot Defense flag has already been handled.";
    const successfulResponses = responseContents.filter(
      (content) => content === confirmed || content === dismissed,
    );
    assert.equal(successfulResponses.length, 1);
    assert.equal(responseContents.filter((content) => content === handled).length, 1);

    const winnerStatus = successfulResponses[0] === confirmed ? "confirmed" : "dismissed";
    const winnerActorId = winnerStatus === "confirmed" ? "mod-confirm" : "mod-dismiss";
    const queueEdits = fetchCalls.filter(
      (call) => call.method === "PATCH" && call.url.includes("/channels/queue-channel-1/"),
    );
    const auditPosts = fetchCalls.filter(
      (call) => call.method === "POST" && call.url.includes("/channels/audit-channel-1/"),
    );
    assert.equal(queueEdits.length, 1);
    assert.equal(auditPosts.length, 1);

    const queueEmbed = (
      queueEdits[0]?.body.embeds as Array<Record<string, unknown>> | undefined
    )?.[0];
    const expectedQueueTitle =
      winnerStatus === "confirmed" ? "Bot Defense: Confirmed" : "Bot Defense: Dismissed";
    assert.equal(queueEmbed?.title, expectedQueueTitle);
    assert.match(String(queueEmbed?.description), new RegExp(`<@${winnerActorId}>`));

    const auditEmbed = (
      auditPosts[0]?.body.embeds as Array<Record<string, unknown>> | undefined
    )?.[0];
    const expectedAuditTitle =
      winnerStatus === "confirmed" ? "Bot Defense Confirmed" : "Bot Defense Dismissed";
    assert.equal(auditEmbed?.title, expectedAuditTitle);
    const auditFields = auditEmbed?.fields as Array<{ name: string; value: string }>;
    assert.equal(
      auditFields.find((field) => field.name === "Author")?.value,
      "<@user-1>\nID: user-1",
    );

    const [row] = fixture.database.query<{
      status: string;
      resolvedByDiscordUserId: string | null;
    }>(
      "SELECT status, resolved_by_discord_user_id AS resolvedByDiscordUserId FROM bot_flags WHERE guild_id = ? AND user_id = ?",
      "guild-1",
      "user-1",
    );
    assert.equal(row?.status, winnerStatus);
    assert.equal(row?.resolvedByDiscordUserId, winnerActorId);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.close();
  }
});

for (const action of ["confirm", "dismiss"] as const) {
  test(`handleBotDefenseComponentInteraction denies a cross-guild ${action} without mutation`, async () => {
    const stores = createStores();
    const generation = await currentFlagGeneration(stores);
    const response = await handleBotDefenseComponentInteraction(
      await buildCurrentInteraction(stores, {
        guild_id: "guild-2",
        member: { permissions: "8", roles: ["mod-role-1"], user: { id: "admin-2" } },
        data: {
          custom_id: buildBotDefenseComponentId(action, "guild-1", "user-1", generation),
        },
      }),
      stores,
      "bot-token",
    );
    const body = (await response.json()) as { data: { content?: string } };

    assert.match(body.data.content ?? "", /not available in this server/);
    assert.equal((await stores.botDefense.readOpenBotFlag("guild-1", "user-1"))?.status, "open");
  });
}

test("handleBotDefenseComponentInteraction denies a non-mod member when mod roles are configured", async () => {
  const stores = createStores();
  const response = await handleBotDefenseComponentInteraction(
    await buildCurrentInteraction(stores, {
      member: { permissions: "0", roles: ["other-role"], user: { id: "user-2" } },
    }),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /Only Bot Defense moderators/);
});

test("handleBotDefenseComponentInteraction falls back to guild admin when zero mod roles configured", async () => {
  const stores = createStores({ config: { ...config, modRoleIds: [] } });
  const response = await handleBotDefenseComponentInteraction(
    await buildCurrentInteraction(stores, {
      member: { permissions: "8", roles: [], user: { id: "admin-1" } },
    }),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /No automatic action/);
});

test("handleBotDefenseComponentInteraction reports already handled for a resolved flag", async () => {
  const stores = createStores({ openFlag: false });
  const response = await handleBotDefenseComponentInteraction(
    await buildCurrentInteraction(stores),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /already resolved/);
});

test("handleBotDefenseComponentInteraction rejects a malformed custom id", async () => {
  const stores = createStores();
  const response = await handleBotDefenseComponentInteraction(
    buildInteractionForGeneration(flag.createdAtMs, {
      data: { custom_id: "bot-defense:confirm:guild-1" },
    }),
    stores,
    "bot-token",
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /Unsupported Bot Defense action/);
});
