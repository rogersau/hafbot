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
import { createGatewayEventOperationRunner } from "../src/runtime/gateway-event-idempotency";
import { createPostgresGatewayEventOperationStore } from "../src/runtime/postgres/postgres-gateway-event-operation-store";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { GOLD_DAY_MS } from "../src/wardogs/gold-status";

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
      await initializePostgresSchema(database);
      let now = Date.now();
      const store = new CommunityToolsStore(database, () => now);
      const receipts = createPostgresGatewayEventOperationStore(database);
      let suspended = false;
      let botUserId = "199";
      let failDelivery = false;
      let goldDay = 0;
      let goldPrice = 651_250;
      const voiceNames = new Map<string, string>();
      const renames: Array<{ channelId: string; name: string }> = [];
      let feedBody =
        "<rss><item><guid>old</guid><title>Old post</title><link>https://game.example/old</link></item></rss>";
      const sends: Array<{
        channelId: string;
        content: string;
        roles: string[];
        nonce: string;
        attachment?: { filename: string; data: Blob };
      }> = [];
      const panelMessages: Array<{ messageId: string; channelId: string }> = [];
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
        send: async (channelId, content, roles, nonce, attachment) => {
          sends.push({ channelId, content, roles, nonce, attachment });
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
        validateVoiceChannel: async () => {},
        async renameVoiceChannel(channelId, name) {
          if (voiceNames.get(channelId) === name) return;
          voiceNames.set(channelId, name);
          renames.push({ channelId, name });
        },
        async publishPanel({ channelId, previous, body }) {
          const messageId =
            previous?.channelId === channelId
              ? previous.messageId
              : String(900 + panelMessages.length);
          assert.equal(body.embeds?.[0]?.title, "WARDOGS links");
          assert.match(JSON.stringify(body.components), /wardogs:link-steam.*wardogs:sync-stats/);
          panelMessages.push({ messageId, channelId });
          return { messageId, botUserId };
        },
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
        wardogsGold: {
          goldAvailable: true,
          async readGoldStatus() {
            return {
              latest: { ts: goldDay, price: goldPrice },
              history: [
                { ts: goldDay - GOLD_DAY_MS, price: 621_425 },
                { ts: goldDay, price: goldPrice },
              ],
            };
          },
        },
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

      suspended = false;
      const currentDay = (Math.floor(now / GOLD_DAY_MS) + 1) * GOLD_DAY_MS;
      now = currentDay + 60000;
      goldDay = currentDay - GOLD_DAY_MS;
      const goldPosts = () =>
        sends.filter((send) => send.content.includes("WARDOGS Gold Exchange"));
      await service.configureWardogsGold("100", "103", "106");
      await service.sweep();
      assert.equal(goldPosts().length, 0, "the scheduler waits for today's rate");
      assert.deepEqual(renames, []);

      goldDay = currentDay;
      await Promise.all([service.sweep(), service.sweep()]);
      await service.sweep();
      assert.equal(goldPosts().length, 1, "concurrent sweeps enqueue and send once per day");
      assert.equal(goldPosts()[0]?.channelId, "103");
      assert.deepEqual(goldPosts()[0]?.roles, []);
      assert.match(goldPosts()[0]!.content, /651,250 cash/);
      assert.match(goldPosts()[0]!.content, /Price history \(UTC\)/);
      assert.match(goldPosts()[0]!.content, /621,425/);
      assert.deepEqual(renames, [{ channelId: "106", name: "Gold: 651,250 cash" }]);

      await service.configureWardogsGold("100", "104");
      await service.configureWardogsGold("100", undefined, undefined, {
        voiceFormat: "Gold {price} ({change})",
        postFormat: "image",
      });
      const goldConfig = await service.read("100", "automation");
      await service.save("100", "automation", { enabled: false }, goldConfig.revision);
      await service.sweep();
      assert.equal(
        goldPosts().length,
        1,
        "changing the channel keeps today's delivery deduplicated",
      );
      assert.deepEqual(renames.at(-1), { channelId: "106", name: "Gold 651,250 (+4.8%)" });

      now += GOLD_DAY_MS;
      goldDay += GOLD_DAY_MS;
      await service.sweep();
      assert.deepEqual(
        goldPosts().map((post) => post.channelId),
        ["103", "104"],
      );
      assert.notEqual(goldPosts()[0]?.nonce, goldPosts()[1]?.nonce);
      const chartPost = goldPosts()[1]!;
      assert.match(chartPost.content, /Price history \(UTC\)/);
      assert.match(chartPost.content, /621,425/);
      assert.equal(chartPost.attachment?.filename, "wardogs-gold-price.png");
      assert.equal(chartPost.attachment.data.type, "image/png");
      const png = Buffer.from(await chartPost.attachment.data.arrayBuffer());
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

      await service.configureWardogsGold("100", null);
      now += GOLD_DAY_MS;
      goldDay += GOLD_DAY_MS;
      goldPrice = 670_000;
      await service.sweep();
      assert.equal(goldPosts().length, 2, "turning updates off stops later posts");
      assert.deepEqual(renames, [
        { channelId: "106", name: "Gold: 651,250 cash" },
        { channelId: "106", name: "Gold 651,250 (+4.8%)" },
        { channelId: "106", name: "Gold 670,000 (+7.8%)" },
      ]);
      await service.configureWardogsGold("100", null, "107");
      await service.sweep();
      assert.deepEqual(renames.at(-1), { channelId: "107", name: "Gold 670,000 (+7.8%)" });
      await service.configureWardogsGold("100", null, null);
      now += GOLD_DAY_MS;
      goldDay += GOLD_DAY_MS;
      goldPrice = 680_000;
      await service.sweep();
      assert.equal(renames.length, 4);

      const draft = { title: "WARDOGS links", channelId: "104", description: "Link here." };
      const published = await service.publishWardogsLinkPanel("100", draft);
      assert.deepEqual((await service.readWardogsSettings("100")).panel, published);
      const updated = await service.publishWardogsLinkPanel("100", {
        ...draft,
        description: "Updated.",
      });
      assert.equal(updated.messageId, published.messageId);
      const moved = await service.publishWardogsLinkPanel("100", { ...draft, channelId: "105" });
      assert.notEqual(moved.messageId, published.messageId);
      assert.deepEqual((await service.readWardogsSettings("200")).panel, null);
      const automation = await service.read("100", "automation");
      await service.save(
        "100",
        "automation",
        { ...automation.config, wardogsLinkPanel: published },
        automation.revision,
      );
      assert.deepEqual(
        (await service.readWardogsSettings("100")).panel,
        moved,
        "regular settings cannot replace the published message reference",
      );
    } finally {
      await database.close();
    }
  },
);
