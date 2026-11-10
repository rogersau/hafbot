/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import { handleImageRulesComponentInteraction } from "../src/runtime/image-rules-interaction-handler";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";
import type { ImageRulesModQueueItem } from "../src/types";

test("Approve Deletion sends one white-label outcome DM and retries are idempotent", async () => {
  const item = buildItem();
  const stores = buildStores(item, "Guild Helper");
  const requests: Array<{ url: string; body: any }> = [];

  await withMockedFetch(
    async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
      return Response.json({ id: "dm-message-1" });
    },
    async () => {
      const first = await handleImageRulesComponentInteraction(
        buildInteraction("approve"),
        stores,
        "token",
      );
      const second = await handleImageRulesComponentInteraction(
        buildInteraction("approve"),
        stores,
        "token",
      );
      assert.match(JSON.stringify(await first.json()), /deletion approved/i);
      assert.match(JSON.stringify(await second.json()), /already been handled/i);
    },
  );

  const dmBodies = requests.filter((request) => request.url.includes("/channels/dm-1/messages"));
  assert.equal(dmBodies.length, 1);
  assert.match(dmBodies[0].body.content, /^Guild Helper:/);
  assert.match(dmBodies[0].body.content, /will remain deleted/);
});

test("Restore Message includes the restored Discord message link in the outcome DM", async () => {
  const item = buildItem();
  const stores = buildStores(item);
  const bodies: any[] = [];
  await withMockedFetch(
    async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      bodies.push(body);
      if (isRestoreHistoryRequest(url)) return Response.json([]);
      if (url.endsWith("/channels/channel-1/messages"))
        return Response.json({ id: "restored-1", channel_id: "channel-1", content: "" });
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
      return Response.json({ id: "dm-message-1" });
    },
    async () => {
      const response = await handleImageRulesComponentInteraction(
        buildInteraction("restore"),
        stores,
        "token",
      );
      assert.match(JSON.stringify(await response.json()), /message restored/i);
    },
  );
  const dm = bodies.find((body) => body?.content?.includes("reviewed and restored"));
  assert.match(dm.content, /https:\/\/discord\.com\/channels\/guild-1\/channel-1\/restored-1/);
});

test("Concurrent Restore Message clicks create one repost and one set of winner side effects", async () => {
  const item = buildItem();
  item.queueChannelId = "queue-channel-1";
  item.queueMessageId = "queue-message-1";
  const stores = buildStores(item, "HAF Bot", true);
  let repostCalls = 0;
  let dmMessages = 0;
  let queueEdits = 0;
  let auditMessages = 0;
  let repostBody: any;
  let releaseRepost!: () => void;
  let signalRepostStarted!: () => void;
  const repostReleased = new Promise<void>((resolve) => {
    releaseRepost = resolve;
  });
  const repostStarted = new Promise<void>((resolve) => {
    signalRepostStarted = resolve;
  });

  await withMockedFetch(
    async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (isRestoreHistoryRequest(url)) return Response.json([]);
      if (url.endsWith("/channels/channel-1/messages")) {
        repostCalls += 1;
        repostBody = body;
        signalRepostStarted();
        await repostReleased;
        return Response.json({ id: "restored-1", channel_id: "channel-1", content: "" });
      }
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
      if (url.endsWith("/channels/dm-1/messages")) {
        dmMessages += 1;
        return Response.json({ id: "dm-message-1" });
      }
      if (url.endsWith("/channels/queue-channel-1/messages/queue-message-1")) {
        queueEdits += 1;
        return Response.json({ id: "queue-message-1" });
      }
      if (url.endsWith("/channels/audit-channel/messages")) {
        auditMessages += 1;
        return Response.json({ id: "audit-message-1" });
      }
      return Response.json({ id: "unexpected" });
    },
    async () => {
      const responses = Promise.all([
        handleImageRulesComponentInteraction(buildInteraction("restore"), stores, "token"),
        handleImageRulesComponentInteraction(buildInteraction("restore"), stores, "token"),
      ]);
      await repostStarted;
      assert.equal(repostCalls, 1);
      releaseRepost();
      const payloads = await Promise.all((await responses).map((response) => response.json()));
      assert.equal(
        payloads.filter((payload) => JSON.stringify(payload).match(/message restored/i)).length,
        1,
      );
      assert.equal(
        payloads.filter((payload) => JSON.stringify(payload).match(/currently being restored/i))
          .length,
        1,
      );
    },
  );

  assert.equal(repostCalls, 1);
  assert.equal(dmMessages, 1);
  assert.equal(queueEdits, 1);
  assert.equal(auditMessages, 1);
  assert.match(repostBody.nonce, /^ir:r:[a-f0-9]{20}$/);
  assert.ok(repostBody.nonce.length <= 25);
  assert.equal(repostBody.enforce_nonce, true);
  assert.equal(item.status, "restored");
});

test("Expired Restore claim finalizes an existing Discord receipt without reposting", async () => {
  const item = buildItem();
  item.queueChannelId = "queue-channel-1";
  item.queueMessageId = "queue-message-1";
  item.restoreClaimToken = "interrupted-worker";
  item.restoreClaimExpiresAtMs = Date.now() - 1;
  item.decidedByUserId = "moderator-original";
  item.decidedAtMs = Date.now() - 30_000;
  const stores = buildStores(item, "HAF Bot", true);
  let repostCalls = 0;
  let queueBody: any;
  let auditBody: any;

  await withMockedFetch(
    async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (isRestoreHistoryRequest(url)) {
        return Response.json([
          {
            id: "restored-existing",
            channel_id: "channel-1",
            content:
              "Restored by Image Rules moderator <@moderator-original>.\n" +
              "Original author: <@author-1>\n" +
              "Original message ID: original-1",
            timestamp: new Date().toISOString(),
            author: { bot: true },
          },
        ]);
      }
      if (url.endsWith("/channels/channel-1/messages")) {
        repostCalls += 1;
        return Response.json({ id: "unexpected-repost" });
      }
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
      if (url.endsWith("/channels/dm-1/messages")) return Response.json({ id: "dm-message-1" });
      if (url.endsWith("/channels/queue-channel-1/messages/queue-message-1")) {
        queueBody = body;
        return Response.json({ id: "queue-message-1" });
      }
      if (url.endsWith("/channels/audit-channel/messages")) {
        auditBody = body;
        return Response.json({ id: "audit-message-1" });
      }
      return Response.json({ id: "unexpected" });
    },
    async () => {
      const response = await handleImageRulesComponentInteraction(
        buildInteraction("restore", "moderator-recovery"),
        stores,
        "token",
      );
      assert.match(JSON.stringify(await response.json()), /message restored/i);
    },
  );

  assert.equal(repostCalls, 0);
  assert.equal(item.status, "restored");
  assert.equal(item.restoredMessageId, "restored-existing");
  assert.equal(item.decidedByUserId, "moderator-original");
  assert.match(JSON.stringify(queueBody), /moderator-original/);
  assert.ok(auditBody);
  assert.doesNotMatch(JSON.stringify(queueBody), /moderator-recovery/);
});

test("Active Restore claims still enforce Image Rules authorization", async () => {
  const item = buildItem();
  item.restoreClaimToken = "active-worker";
  item.restoreClaimExpiresAtMs = Date.now() + 60_000;
  item.decidedByUserId = "moderator-1";
  item.decidedAtMs = Date.now();
  const stores = buildStores(item);

  await withMockedFetch(
    async () => Response.json({ id: "unexpected" }),
    async () => {
      const response = await handleImageRulesComponentInteraction(
        {
          ...buildInteraction("restore"),
          member: { roles: [], user: { id: "member-1" } },
        },
        stores,
        "token",
      );
      assert.match(JSON.stringify(await response.json()), /Only Image Rules moderators/i);
    },
  );

  assert.equal(item.status, "pending");
  assert.equal(item.restoreClaimToken, "active-worker");
});

test("Restore Failed is terminal and failure side effects cannot race a retry", async () => {
  const item = buildItem();
  item.queueChannelId = "queue-channel-1";
  item.queueMessageId = "queue-message-1";
  const stores = buildStores(item, "HAF Bot", true);
  const bodies: any[] = [];
  let repostCalls = 0;
  let queueEdits = 0;
  let auditMessages = 0;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withMockedFetch(
      async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        bodies.push(body);
        if (isRestoreHistoryRequest(url)) return Response.json([]);
        if (url.endsWith("/channels/channel-1/messages")) {
          repostCalls += 1;
          return new Response("missing access", { status: 403 });
        }
        if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
        if (url.endsWith("/channels/dm-1/messages"))
          return new Response("DMs closed", { status: 403 });
        if (url.endsWith("/channels/queue-channel-1/messages/queue-message-1")) {
          queueEdits += 1;
          return Response.json({ id: "queue-message-1" });
        }
        if (url.endsWith("/channels/audit-channel/messages")) {
          auditMessages += 1;
          return Response.json({ id: "audit-message-1" });
        }
        return Response.json({ id: "unexpected" });
      },
      async () => {
        const first = await handleImageRulesComponentInteraction(
          buildInteraction("restore"),
          stores,
          "token",
        );
        const second = await handleImageRulesComponentInteraction(
          buildInteraction("restore", "moderator-2"),
          stores,
          "token",
        );
        assert.match(JSON.stringify(await first.json()), /Failed to restore/i);
        assert.match(JSON.stringify(await second.json()), /already been handled/i);
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  const dm = bodies.find((body) => body?.content?.includes("could not be restored automatically"));
  assert.ok(dm);
  assert.doesNotMatch(dm.content, /missing access|403|moderator/i);
  assert.equal(repostCalls, 1);
  assert.equal(queueEdits, 1);
  assert.equal(auditMessages, 1);
  assert.equal(item.status, "restore_failed");
});

test("Ambiguous Discord failure keeps the claim recoverable without failure projections", async () => {
  const item = buildItem();
  item.queueChannelId = "queue-channel-1";
  item.queueMessageId = "queue-message-1";
  const stores = buildStores(item, "HAF Bot", true);
  let dmMessages = 0;
  let queueEdits = 0;
  let auditMessages = 0;

  await withMockedFetch(
    async (input) => {
      const url = String(input);
      if (isRestoreHistoryRequest(url)) return Response.json([]);
      if (url.endsWith("/channels/channel-1/messages"))
        return new Response("upstream uncertain", { status: 500 });
      if (url.endsWith("/users/@me/channels") || url.includes("/channels/dm-")) {
        dmMessages += 1;
      }
      if (url.endsWith("/channels/queue-channel-1/messages/queue-message-1")) queueEdits += 1;
      if (url.endsWith("/channels/audit-channel/messages")) auditMessages += 1;
      return Response.json({ id: "unexpected" });
    },
    async () => {
      const response = await handleImageRulesComponentInteraction(
        buildInteraction("restore"),
        stores,
        "token",
      );
      assert.match(JSON.stringify(await response.json()), /currently being restored/i);
    },
  );

  assert.equal(item.status, "pending");
  assert.ok(item.restoreClaimToken);
  assert.equal(item.failureReason, null);
  assert.equal(dmMessages, 0);
  assert.equal(queueEdits, 0);
  assert.equal(auditMessages, 0);
});

for (const action of ["approve", "restore"] as const) {
  test(`${action} denies a cross-guild interaction without mutation`, async () => {
    const item = buildItem();
    const stores = buildStores(item);
    let requests = 0;

    await withMockedFetch(
      async () => {
        requests += 1;
        return Response.json({ id: "unexpected" });
      },
      async () => {
        const response = await handleImageRulesComponentInteraction(
          {
            ...buildInteraction(action),
            guild_id: "guild-2",
            member: {
              permissions: "8",
              roles: ["mod-role"],
              user: { id: "admin-2" },
            },
          },
          stores,
          "token",
        );
        assert.match(JSON.stringify(await response.json()), /not available in this server/i);
      },
    );

    assert.equal(item.status, "pending");
    assert.equal(requests, 0);
  });
}

function buildItem(): ImageRulesModQueueItem {
  return {
    id: "item-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "original-1",
    authorId: "author-1",
    imageUrl: "https://cdn.example/image.png",
    topicDescription: "Game screenshots",
    offTopicConfidence: 0.5,
    onTopicConfidence: 0.5,
    status: "pending",
    queueChannelId: null,
    queueMessageId: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    decidedByUserId: null,
    decidedAtMs: null,
    failureReason: null,
    restoreClaimToken: null,
    restoreClaimExpiresAtMs: null,
    restoredMessageId: null,
  };
}

function buildStores(
  item: ImageRulesModQueueItem,
  displayName = "HAF Bot",
  withAudit = false,
): RuntimeStores {
  const transition = (
    status: ImageRulesModQueueItem["status"],
    actorUserId: string,
    nowMs: number,
    failureReason: string | null = null,
  ) => {
    if (item.status !== "pending") return null;
    item.status = status;
    item.decidedByUserId = actorUserId;
    item.decidedAtMs = nowMs;
    item.updatedAtMs = nowMs;
    item.failureReason = failureReason;
    item.restoreClaimToken = null;
    item.restoreClaimExpiresAtMs = null;
    return { ...item };
  };
  return {
    imageRules: {
      readModQueueItem: async () => ({ ...item }),
      readConfig: async () => ({ modRoleIds: ["mod-role"] }),
      claimModQueueItemRestore: async (
        _id: string,
        claimToken: string,
        actorUserId: string,
        nowMs: number,
        leaseMs: number,
      ) => {
        const canClaim =
          item.status === "pending" &&
          (item.restoreClaimToken === null ||
            item.restoreClaimExpiresAtMs === null ||
            item.restoreClaimExpiresAtMs <= nowMs);
        if (!canClaim) return null;
        item.restoreClaimToken = claimToken;
        item.restoreClaimExpiresAtMs = nowMs + leaseMs;
        item.failureReason = null;
        item.updatedAtMs = nowMs;
        item.decidedByUserId ??= actorUserId;
        item.decidedAtMs ??= nowMs;
        return { ...item };
      },
      markModQueueItemApproved: async (_id: string, actorUserId: string, nowMs: number) => {
        if (item.restoreClaimToken !== null) return null;
        return transition("approved", actorUserId, nowMs);
      },
      markModQueueItemRestored: async (
        _id: string,
        claimToken: string,
        actorUserId: string,
        restoredMessageId: string,
        nowMs: number,
      ) => {
        if (item.status !== "pending" || item.restoreClaimToken !== claimToken) return null;
        item.restoredMessageId = restoredMessageId;
        return transition("restored", actorUserId, nowMs);
      },
      markModQueueItemRestoreFailed: async (
        _id: string,
        claimToken: string,
        actorUserId: string,
        reason: string,
        nowMs: number,
      ) => {
        if (item.status !== "pending" || item.restoreClaimToken !== claimToken) return null;
        return transition("restore_failed", actorUserId, nowMs, reason);
      },
    },
    whiteLabelBots: {
      readWhiteLabelBot: async () => ({ status: "active", displayName }),
    },
    guildAuditLog: {
      readConfig: async () =>
        withAudit
          ? {
              guildId: "guild-1",
              auditChannelId: "audit-channel",
              groupChannelIds: {},
              eventStates: { groups: {}, overrides: {} },
              updatedAtMs: 1,
            }
          : null,
    },
  } as unknown as RuntimeStores;
}

function buildInteraction(
  action: "approve" | "restore",
  actorUserId = "moderator-1",
): DiscordInteraction {
  return {
    guild_id: "guild-1",
    member: { roles: ["mod-role"], user: { id: actorUserId } },
    data: { custom_id: `image-rules:${action}:item-1` },
  } as DiscordInteraction;
}

function isRestoreHistoryRequest(url: string): boolean {
  return url.includes("/channels/channel-1/messages?");
}

async function withMockedFetch<T>(handler: typeof fetch, callback: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}
