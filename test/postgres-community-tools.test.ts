import assert from "node:assert/strict";
import test from "node:test";
import { CommunityToolsStore } from "../src/community-tools/store";
import { CommunityToolsService, type CommunityDiscord } from "../src/community-tools/service";
import { ContentFeedReader } from "../src/community-tools/feeds";
import {
  automationConfigSchema,
  feedConfigSchema,
  moderationConfigSchema,
} from "../src/community-tools/config";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import {
  createGatewayEventOperationRunner,
  createGatewayEventOperationStore,
} from "../src/runtime/gateway-event-idempotency";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";

const postgresUrl = process.env.TEST_POSTGRES_URL;
test(
  "community tools persist settings, suppress duplicate effects, isolate Guilds and revalidate queued deliveries",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test"));
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "4",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await applyPostgresMigrations(database, await readPostgresMigrations("migrations/postgres"));
      let now = Date.now();
      const store = new CommunityToolsStore(database, () => now);
      const d1 = createPostgresD1CompatibilityDatabase(database);
      const receipts = createGatewayEventOperationStore(d1);
      let suspended = false;
      let botUserId = "199";
      let failDelivery = false;
      let feedBody =
        "<rss><item><guid>old</guid><title>Old post</title><link>https://game.example/old</link></item></rss>";
      const sends: Array<{ channelId: string; content: string; roles: string[]; nonce: string }> =
        [];
      const deletes: string[] = [];
      const timeouts: number[] = [];
      let accountCalls = 0;
      let failAccountAction = true;
      const discord: CommunityDiscord = {
        resources: async () => ({
          guildId: "100",
          botUserId,
          channels: [],
          roles: [],
          member: { roles: [] },
        }),
        member: async () => ({ roles: [], bot: false }),
        send: async (channelId, content, roles, nonce) => {
          sends.push({ channelId, content, roles, nonce });
          if (failDelivery && content === "Identity-bound notice")
            throw new Error("Ambiguous send");
        },
        delete: async (_channel, id) => {
          deletes.push(id);
        },
        timeout: async (_user, until) => {
          timeouts.push(until);
        },
        validateChannel: async () => {},
        moderate: async () => {
          accountCalls++;
          if (failAccountAction) throw new Error("Discord response lost after mutation");
        },
        messages: async () => [],
        assertStaffTarget: async () => {},
      };
      const ops = (eventKey: string) =>
        createGatewayEventOperationRunner({ eventKey, store: receipts, nowMs: () => now });
      const service = new CommunityToolsService({
        store,
        discordForGuild: async () => discord,
        operationsFor: ops,
        isSuspended: async () => suspended,
        authorizeAdmin: async () => false,
        feedReader: new ContentFeedReader({ transport: async () => feedBody }),
        now: () => now,
      });
      const config = automationConfigSchema.parse({
        enabled: true,
        commands: [
          { id: "connect", enabled: true, trigger: "!connect", response: "Join the server" },
        ],
        schedules: [
          {
            id: "notice",
            enabled: true,
            channelId: "101",
            content: "Weekly game",
            intervalMinutes: 10080,
            startsAtMs: now,
          },
        ],
      });
      await service.save("100", "automation", config, 0);
      await assert.rejects(() => service.save("100", "automation", config, 0), /changed/);
      assert.equal((await service.read("200", "automation")).config.enabled, false);
      const message = {
        guildId: "100",
        channelId: "101",
        messageId: "300",
        userId: "102",
        content: "!connect",
        eventKey: "event-1",
        receivedAtMs: now,
      };
      await service.onMessage(message, ops("event-1"));
      await service.onMessage(message, ops("event-1"));
      assert.equal(sends.length, 1);
      await service.onMessage(
        { ...message, eventKey: "event-2", messageId: "301" },
        ops("event-2"),
      );
      assert.equal(sends.length, 1, "cooldown must apply to a different event");
      await Promise.all([service.sweep(), service.sweep()]);
      assert.equal(sends.filter((send) => send.content === "Weekly game").length, 1);
      const active = await service.read("100", "automation");
      await store.enqueue({
        id: "identity-change",
        guildId: "100",
        feature: "automation",
        itemId: "notice",
        channelId: "101",
        content: "Identity-bound notice",
        roleIds: [],
        createdAtMs: now,
        configRevision: active.revision,
      });
      failDelivery = true;
      await service.sweep();
      botUserId = "198";
      failDelivery = false;
      await service.sweep();
      assert.equal(
        sends.filter((send) => send.content === "Identity-bound notice").length,
        1,
        "an uncertain send must not be repeated through another bot identity",
      );
      await store.enqueue({
        id: "obsolete",
        guildId: "100",
        feature: "automation",
        itemId: "notice",
        channelId: "101",
        content: "Must not send",
        roleIds: [],
        createdAtMs: now,
        configRevision: active.revision,
      });
      await service.save("100", "automation", { ...config, enabled: false }, active.revision);
      await service.sweep();
      assert.ok(!sends.some((send) => send.content === "Must not send"));
      const moderation = moderationConfigSchema.parse({
        enabled: true,
        rules: [
          {
            id: "invite",
            name: "No invites",
            enabled: true,
            trigger: "invites",
            deleteMessage: true,
            warn: true,
            timeoutAfter: 1,
          },
        ],
      });
      await service.save("100", "moderation", moderation, 0);
      await service.onMessage(
        { ...message, eventKey: "event-3", content: "discord.gg/spam", messageId: "302" },
        ops("event-3"),
      );
      await service.onMessage(
        { ...message, eventKey: "event-3", content: "discord.gg/spam", messageId: "302" },
        ops("event-3"),
      );
      assert.deepEqual(deletes, ["302"]);
      assert.equal(timeouts.length, 1);
      assert.equal((await store.history("100", "102")).length, 1);
      const staffAction = {
        guildId: "100",
        actorId: "103",
        userId: "102",
        action: "unban",
        reason: "Staff decision",
        interactionId: "401",
        channelId: "101",
        adminAuthorized: true,
      };
      await assert.rejects(() => service.staffAction(staffAction), /unexpected_error/);
      now += 10 * 60000;
      failAccountAction = false;
      await assert.rejects(() => service.staffAction(staffAction), /result is uncertain/);
      assert.equal(accountCalls, 1, "a lost response must never remove a later ban on retry");
      assert.equal(
        (await store.history("100", "102")).filter((entry) => entry.action === "unban-requested")
          .length,
        1,
      );
      await service.staffAction({ ...staffAction, interactionId: "402" });
      await service.staffAction({ ...staffAction, interactionId: "402" });
      assert.equal(accountCalls, 2, "a completed explicit new action is not repeated either");
      const concurrent = await Promise.all([
        store.claim("concurrent", now + 60000, now),
        store.claim("concurrent", now + 60000, now),
      ]);
      assert.equal(concurrent.filter(Boolean).length, 1);
      await service.save(
        "100",
        "feeds",
        feedConfigSchema.parse({
          enabled: true,
          feeds: [
            {
              id: "patch",
              enabled: true,
              name: "Patch notes",
              provider: "rss",
              source: "https://game.example/feed",
              channelId: "101",
            },
          ],
        }),
        0,
      );
      await service.sweep();
      assert.ok(
        !sends.some((send) => send.content.includes("Old post")),
        "initial subscription must baseline historical content",
      );
      now += 5 * 60000;
      feedBody =
        "<rss><item><guid>new</guid><title>New patch</title><link>https://game.example/new</link></item><item><guid>old</guid><title>Old post</title><link>https://game.example/old</link></item></rss>";
      await service.sweep();
      await service.sweep();
      assert.equal(sends.filter((send) => send.content.includes("New patch")).length, 1);
      suspended = true;
      now += 5 * 60000;
      feedBody =
        "<rss><item><guid>another</guid><title>Suspended patch</title><link>https://game.example/suspended</link></item></rss>";
      await service.sweep();
      assert.ok(!sends.some((send) => send.content.includes("Suspended patch")));
    } finally {
      await database.close();
    }
  },
);
