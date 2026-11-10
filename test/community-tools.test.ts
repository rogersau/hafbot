import assert from "node:assert/strict";
import test from "node:test";
import { createCommunityDiscord } from "../src/community-tools/discord";
import {
  ContentFeedReader,
  contentFeedUrl,
  feedUrl,
  isPublicFeedAddress,
  parseSyndication,
} from "../src/community-tools/feeds";
import {
  automationConfigSchema,
  matchesReply,
  moderationMatches,
  moderationRuleSchema,
  parseCommunityConfig,
  recurringOccurrence,
} from "../src/community-tools/config";

test("staff purge and bot delivery respect a thread parent's channel overwrites", async (t) => {
  let deny = 1n << 13n;
  const parent = () => ({
    id: "200",
    guild_id: "100",
    type: 0,
    parent_id: null,
    permission_overwrites: [{ id: "100", type: 0, allow: "0", deny: deny.toString() }],
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    ).pathname.replace("/api/v10", "");
    let value: unknown;
    if (path === "/channels/201")
      value = { id: "201", guild_id: "100", type: 11, parent_id: "200" };
    else if (path === "/channels/200") value = parent();
    else if (path === "/guilds/100/channels") value = [parent()];
    else if (path === "/guilds/100/roles")
      value = [
        {
          id: "100",
          position: 0,
          permissions: ((1n << 10n) | (1n << 13n) | (1n << 38n)).toString(),
        },
      ];
    else if (path === "/guilds/100/members/101" || path === "/guilds/100/members/102")
      value = { roles: [] };
    else if (path === "/guilds/100") value = { id: "100", owner_id: "999" };
    else throw new Error(`Unexpected Discord request: ${path}`);
    return Response.json(value);
  });
  const discord = createCommunityDiscord("100", "test-token", "102");
  await assert.rejects(
    () => discord.assertStaffTarget("101", "101", 1n << 13n, "201"),
    /permission/,
  );
  deny = 1n << 10n;
  await assert.rejects(
    () => discord.assertStaffTarget("101", "101", 1n << 13n, "201"),
    /permission/,
  );
  await assert.rejects(() => discord.validateChannel("201"), /View Channel/);
  deny = 0n;
  await discord.assertStaffTarget("101", "101", 1n << 13n, "201");
  await discord.validateChannel("201");
});

test("custom replies match normalized messages and config prevents duplicate command identities", () => {
  assert.equal(matchesReply(" ！ＣＯＮＮＥＣＴ ", "!connect", "exact"), true);
  assert.equal(matchesReply("!connect now", "!connect", "prefix"), true);
  assert.equal(matchesReply("!connecting", "!connect", "exact"), false);
  const config = automationConfigSchema.parse({
    enabled: true,
    commands: [{ id: "connect", trigger: "!connect", response: "Join our game" }],
  });
  assert.throws(
    () =>
      parseCommunityConfig("automation", {
        ...config,
        commands: [...config.commands, ...config.commands],
      }),
    /different ID/,
  );
  assert.throws(
    () =>
      parseCommunityConfig("automation", {
        ...config,
        commands: [{ ...config.commands[0], response: "x".repeat(2001) }],
      }),
    /Check the settings/,
  );
});
test("recurring schedules use UTC instants, wait for first occurrence and skip stale intervals", () => {
  const start = Date.UTC(2026, 10, 10, 8);
  assert.equal(recurringOccurrence(start - 1, start, 1440), null);
  assert.equal(recurringOccurrence(start + 60000, start, 1440), start);
  assert.equal(recurringOccurrence(start + 10 * 60000, start, 1440), null);
  assert.equal(recurringOccurrence(start + 86400000 + 1000, start, 1440), start + 86400000);
});
test("chat rules handle invites and domain boundaries without interpreting user regex", () => {
  const rule = moderationRuleSchema.parse({
    id: "invites",
    name: "No invites",
    trigger: "invites",
  });
  assert.equal(moderationMatches(rule, "https://discord.gg/example"), true);
  assert.equal(
    moderationMatches(
      { ...rule, trigger: "domains", values: ["bad.example"] },
      "https://sub.bad.example/a",
    ),
    true,
  );
  assert.equal(
    moderationMatches(
      { ...rule, trigger: "domains", values: ["bad.example"] },
      "https://notbad.example/a",
    ),
    false,
  );
  assert.equal(moderationMatches({ ...rule, trigger: "words", values: ["a+b"] }, "a+b"), true);
  assert.equal(moderationMatches({ ...rule, trigger: "words", values: ["a+b"] }, "ab"), false);
});
test("feed targets reject private, reserved and credential-bearing URLs", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPublicFeedAddress(address), false, address);
  assert.equal(isPublicFeedAddress("8.8.8.8"), true);
  for (const value of [
    "http://example.com/rss",
    "https://127.0.0.1/rss",
    "https://u:p@example.com/rss",
    "https://feed.internal/rss",
    "https://example.com:8443/rss",
  ])
    assert.throws(() => feedUrl(value));
});
test("RSS and Atom parsing bounds payloads and extracts links without executing XML", () => {
  const rss = `<rss><channel><item><guid>one</guid><title><![CDATA[Patch &amp; update]]></title><link>https://game.example/patch</link></item></channel></rss>`;
  assert.deepEqual(parseSyndication(rss), [
    { id: "one", title: "Patch & update", url: "https://game.example/patch" },
  ]);
  const atom = `<feed><entry><id>two</id><title>New video</title><link rel="self" href="https://feed.example/item"/><link rel="alternate" href="https://video.example/watch?a=1&amp;b=2"/></entry></feed>`;
  assert.deepEqual(parseSyndication(atom), [
    { id: "two", title: "New video", url: "https://video.example/watch?a=1&b=2" },
  ]);
  assert.throws(
    () => parseSyndication('<!DOCTYPE rss [<!ENTITY test SYSTEM "file:///etc/passwd">]><rss/>'),
    /unsupported/,
  );
  assert.throws(() => parseSyndication("<rss>" + "x".repeat(512 * 1024)), /unsupported/);
  assert.deepEqual(
    parseSyndication(
      "<rss><item><title>Unsafe</title><link>https://localhost/private</link></item></rss>",
    ),
    [],
  );
});
test("Twitch fails closed without complete valid credentials and never calls its API", async () => {
  let calls = 0;
  const reader = new ContentFeedReader({
    fetch: async () => {
      calls++;
      throw new Error("unexpected request");
    },
  });
  const feed = {
    id: "stream",
    enabled: true,
    name: "Stream",
    provider: "twitch" as const,
    source: "player",
    channelId: "100",
    notifyRoleIds: [],
  };
  await assert.rejects(() => reader.read(feed), /unavailable/);
  assert.equal(calls, 0);
  assert.throws(() => new ContentFeedReader({ clientId: "a".repeat(30) }), /Both/);
  assert.throws(
    () => new ContentFeedReader({ clientId: " invalid ", clientSecret: "b".repeat(30) }),
    /credentials/,
  );
  assert.equal(new ContentFeedReader({ clientId: "", clientSecret: "" }).twitchAvailable, false);
  assert.match(
    contentFeedUrl({ ...feed, provider: "youtube", source: "UC" + "a".repeat(22) }),
    /youtube\.com\/feeds\/videos\.xml/,
  );
});
