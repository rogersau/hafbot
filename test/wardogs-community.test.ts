import assert from "node:assert/strict";
import test from "node:test";
import { getSlashCommandDefinitions } from "../src/discord-commands";
import {
  handleApplicationCommand,
  type ApplicationCommandHandlerOptions,
} from "../src/runtime/application-command-handler";
import type { RuntimeAppOptions, RuntimeStores } from "../src/runtime/app-types";
import type { PlatformLink } from "../src/runtime/contracts/platform-link-store";
import { ALL_FEATURES_ENABLED, parseFeatureFlags } from "../src/runtime/features";
import { handleInteractionRequest } from "../src/runtime/interaction-handler";
import { createPlatformLinkIdentityReader } from "../src/services/platform-link-identity-reader";
import { createWardogsCommunityData } from "../src/wardogs/community-data";
import { createWardogsTrackerConnect } from "../src/wardogs/tracker-connect";
import { WARDOGS_LINK_STEAM_BUTTON, WARDOGS_SYNC_STATS_BUTTON } from "../src/wardogs/link-panel";
import { applicationCommandServices, interactionServices } from "./support/handler-services";

const guildId = "111111111111111111";
const userId = "222222222222222222";
const otherUser = "333333333333333333";
const steamId = "76561198000000001";
const otherSteamId = "76561198000000002";
const publicUrl = "https://haf.example";
const priceDay = Date.parse("2026-11-21T00:00:00Z");

function fixture(links: PlatformLink[]) {
  return {
    platformLink: {
      async listPlatformLinksByUser(guild: string, user: string) {
        return links.filter((link) => link.guildId === guild && link.userId === user);
      },
      async readPlatformLinkEntry(guild: string, user: string, platform: string, account: string) {
        return (
          links.find(
            (link) =>
              link.guildId === guild &&
              link.userId === user &&
              link.platform === platform &&
              link.platformId === account,
          ) ?? null
        );
      },
    },
  } as RuntimeStores;
}

const link = (overrides: Partial<PlatformLink> = {}): PlatformLink => ({
  guildId,
  userId,
  platform: "steam",
  platformId: steamId,
  active: true,
  manual: false,
  linkedAtMs: 0,
  actionedByUserId: null,
  metadataJson: null,
  ...overrides,
});

async function runCommand(
  subcommand: string,
  stores: RuntimeStores,
  wardogsCommunity: NonNullable<RuntimeAppOptions["wardogsCommunity"]>,
  subOptions: Array<{ type: number; name: string; value: string | boolean }> = [],
  settings: {
    permissions?: string;
    communityTools?: ApplicationCommandHandlerOptions["communityTools"];
  } = {},
) {
  const response = await handleApplicationCommand(
    {
      type: 2,
      guild_id: guildId,
      member: { user: { id: userId }, permissions: settings.permissions },
      data: { name: "wardogs", options: [{ type: 1, name: subcommand, options: subOptions }] },
    },
    stores,
    "bot-token",
    ALL_FEATURES_ENABLED,
    {
      wardogsCommunity,
      communityTools: settings.communityTools,
      services: applicationCommandServices({}),
    },
  );
  return ((await response.json()) as { data: { content: string; flags: number } }).data;
}

test("WARDOGS stats dispatch uses the guild's authenticated link and honors hidden fields", async () => {
  const stores = fixture([
    link(),
    link({ userId: otherUser, platformId: otherSteamId, manual: true }),
  ]);
  const requests: string[] = [];
  const data = createWardogsCommunityData({
    fetcher: async (url) => {
      requests.push(String(url));
      return Response.json({
        player: {
          steamId,
          stats: {
            wardogLevel: 37,
            careerXp: 92_500,
            unlocks: 3,
            cash: null,
            gold: null,
            roles: { medic: { level: 12, xp: 18_000 } },
            syncedAt: "2026-11-21T11:34:23Z",
          },
        },
      });
    },
  });
  const result = await runCommand("stats", stores, { data });
  assert.equal(result.flags, 64);
  assert.match(result.content, /Level \*\*37\*\*.*92,500/);
  assert.match(result.content, /Medic 12/);
  assert.match(result.content, /Synced <t:\d+:R>/);
  assert.match(result.content, /Data from WARDOGS Tracker/);
  assert.doesNotMatch(result.content, /cash|gold bars/);
  const manual = await runCommand("stats", stores, { data }, [
    { type: 6, name: "user", value: otherUser },
  ]);
  assert.match(manual.content, /no active Steam Player Link/);
  assert.deepEqual(requests, [`https://wardogstracker.gg/api/v1/players/${steamId}`]);
});

test("WARDOGS stats offer a sync for missing snapshots and keep failures distinct", async () => {
  let status = 404;
  const data = createWardogsCommunityData({ fetcher: async () => new Response(null, { status }) });
  const options = [{ name: "steamid", type: 3, value: steamId }];
  const missing = await runCommand("stats", fixture([]), { data }, options);
  assert.match(missing.content, /no public stats/);
  assert.match(missing.content, /wardogstracker\.gg\/stats/);
  status = 429;
  const unavailable = await runCommand("stats", fixture([]), { data }, options);
  assert.match(unavailable.content, /temporarily unavailable/);
  assert.doesNotMatch(unavailable.content, /no public stats/);
  assert.ok(
    !getSlashCommandDefinitions(parseFeatureFlags({ DISABLE_WARDOGS_COMMUNITY: "true" })).some(
      (command) => command.name === "wardogs",
    ),
  );
});

test("WARDOGS gold shares a keyed lookup and refreshes its cache across midnight UTC", async () => {
  let now = priceDay - 1000;
  let calls = 0;
  const data = createWardogsCommunityData({
    now: () => now,
    goldApiKey: "test-gold-key",
    fetcher: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://wardogserverlist.com/api/gold-bars");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-gold-key");
      assert.equal(init?.redirect, "error");
      return Response.json({
        latest:
          now < priceDay
            ? { ts: priceDay - 86_400_000, price: 621_425 }
            : { ts: priceDay, price: 651_250 },
        points: [
          [priceDay - 7 * 86_400_000, 1_100_001],
          [priceDay - 86_400_000, 621_425],
          [priceDay, 650_000],
        ],
      });
    },
  });
  const stores = fixture([]);
  const first = await Promise.all([
    runCommand("gold", stores, { data }),
    runCommand("gold", stores, { data }),
  ]);
  assert.equal(calls, 1);
  assert.match(first[0].content, /621,425 cash.*\nPrice for 20 Nov 2026 UTC/);
  assert.deepEqual(first[0], first[1]);
  now += 2000;
  const today = await runCommand("gold", stores, { data });
  assert.equal(calls, 2);
  assert.match(today.content, /651,250 cash.*\nPrice for 21 Nov 2026 UTC/);
  assert.match(today.content, /\+4\.8% vs\. yesterday/);
  assert.match(today.content, /20 Nov 2026 · 621,425\n21 Nov 2026 · 651,250/);
  assert.doesNotMatch(today.content, /1,100,001|650,000/);
  assert.match(today.content, /WARDOGS Server List/);
});

test("WARDOGS daily gold settings require HAF admin access and are scoped to the invoking Guild", async () => {
  const stores = fixture([]);
  stores.guildRbac = {
    async readGuildAdminRoleId() {
      return null;
    },
    async readManageServerAdminEnabled() {
      return false;
    },
    async listGuildAdminRoleAssignments() {
      return [];
    },
    async setManageServerAdminEnabled() {},
    async upsertGuildAdminRoleId() {},
  };
  const calls: Array<{ guildId: string; channel: string | null | undefined }> = [];
  const communityTools = {
    async handleInteraction() {
      return null;
    },
    async configureWardogsGold(guildId: string, channel: string | null | undefined) {
      calls.push({ guildId, channel });
      return "Daily settings";
    },
  } satisfies NonNullable<ApplicationCommandHandlerOptions["communityTools"]>;
  const data = createWardogsCommunityData();
  const target = [{ type: 7, name: "channel", value: "1234" }];
  const off = [{ type: 5, name: "off", value: true }];
  const denied = await runCommand("gold-daily", stores, { data }, target, { communityTools });
  assert.match(denied.content, /Administrator/);
  assert.deepEqual(calls, []);
  const admin = { communityTools, permissions: "8" };
  assert.match(
    (await runCommand("gold-daily", stores, { data }, [...target, ...off], admin)).content,
    /Choose a channel or turn/,
  );
  await runCommand("gold-daily", stores, { data }, target, admin);
  await runCommand("gold-daily", stores, { data }, off, admin);
  assert.deepEqual(calls, [
    { guildId, channel: "1234" },
    { guildId, channel: null },
  ]);
});

test("published WARDOGS panel starts Steam linking or sync only from the active guild message", async () => {
  const messageId = "555555555555555555";
  const channelId = "444444444444444444";
  const calls: unknown[] = [];
  const stores = fixture([link()]);
  const settings = {
    async readWardogsSettings(requestedGuild: string) {
      assert.equal(requestedGuild, guildId);
      return { goldChannelId: null, panel: { messageId, channelId } };
    },
  } as unknown as RuntimeAppOptions["communityTools"];
  const services = interactionServices({
    platformLinkService: {
      async readConfig() {
        return { enabled: true, allowMultipleLinks: false, allowRelink: false };
      },
      async getLinksByUser() {
        return [];
      },
      async clearExpiredPendingLinks() {},
      async createPendingLink(_state: string, guild: string, user: string, platform: string) {
        calls.push(["link", guild, user, platform]);
      },
    } as never,
  });
  const data = createWardogsCommunityData();
  const connect = {
    async createStartUrl(identity: { guildId: string; userId: string; steamId: string }) {
      calls.push(["sync", identity]);
      return `${publicUrl}/auth/wardogs/start?ticket=fixture`;
    },
  } as NonNullable<RuntimeAppOptions["wardogsCommunity"]>["connect"];
  async function click(customId: string, clickedMessageId: string) {
    const response = await handleInteractionRequest(
      new Request(`${publicUrl}/interactions`, {
        method: "POST",
        headers: {
          "x-signature-ed25519": "fixture",
          "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({
          type: 3,
          guild_id: guildId,
          channel_id: channelId,
          member: { user: { id: userId } },
          message: { id: clickedMessageId, channel_id: channelId },
          data: { custom_id: customId },
        }),
      }),
      {
        discordPublicKey: "fixture",
        discordBotToken: "fixture",
        stores,
        gateway: {} as never,
        services,
        wardogsCommunity: { data, connect },
        communityTools: settings,
        verifyDiscordRequest: async () => true,
      },
    );
    return ((await response.json()) as { data: { content: string; flags: number } }).data;
  }

  assert.match(
    (await click(WARDOGS_SYNC_STATS_BUTTON, "former-panel")).content,
    /latest WARDOGS link panel/,
  );
  assert.deepEqual(calls, []);
  const steam = await click(WARDOGS_LINK_STEAM_BUTTON, messageId);
  assert.equal(steam.flags, 64);
  assert.match(steam.content, /auth\/steam\/start/);
  const sync = await click(WARDOGS_SYNC_STATS_BUTTON, messageId);
  assert.equal(sync.flags, 64);
  assert.match(sync.content, /auth\/wardogs\/start/);
  assert.deepEqual(calls, [
    ["link", guildId, userId, "steam"],
    ["sync", { guildId, userId, steamId }],
  ]);
});

test("Tracker sync binds the callback to its browser, consumes state once, and discards returned stats", async () => {
  const links = [link()];
  const stores = fixture(links);
  const consumed = new Set<string>();
  const connectCalls: unknown[] = [];
  let returnedSteamId = steamId;
  const connect = createWardogsTrackerConnect({
    publicUrl,
    clientId: "test-client",
    apiKey: "test-connect-api-key",
    signingSecret: "test-signing-secret-not-shared-with-tracker",
    links: createPlatformLinkIdentityReader(stores.platformLink),
    oneTimeTokens: {
      async consume({ nonce }) {
        if (consumed.has(nonce)) return false;
        consumed.add(nonce);
        return true;
      },
    },
    fetcher: async (url, init) => {
      assert.equal(url, "https://wardogstracker.gg/api/v1/connect/token");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-connect-api-key");
      connectCalls.push(JSON.parse(String(init?.body)));
      return Response.json({
        steamId: returnedSteamId,
        synced: true,
        player: { stats: { cash: 789_000 } },
      });
    },
  });
  async function begin() {
    const result = await runCommand("sync", stores, {
      data: createWardogsCommunityData(),
      connect,
    });
    assert.equal(result.flags, 64);
    const startUrl = result.content.match(/\((https:\/\/haf\.example[^)]+)\)/)?.[1];
    assert.ok(startUrl);
    const start = await connect.start(new Request(startUrl));
    assert.equal(start.status, 302);
    const tracker = new URL(start.headers.get("location")!);
    assert.equal(tracker.origin, "https://wardogstracker.gg");
    assert.equal(tracker.searchParams.get("client_id"), "test-client");
    const callbackUrl = new URL(tracker.searchParams.get("redirect_uri")!);
    callbackUrl.searchParams.set("state", tracker.searchParams.get("state")!);
    callbackUrl.searchParams.set("code", "test-code");
    const setCookie = start.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
    return { callbackUrl, cookie: setCookie.split(";")[0]! };
  }

  const { callbackUrl, cookie } = await begin();
  assert.equal((await connect.callback(new Request(callbackUrl))).status, 400);
  assert.equal(connectCalls.length, 0);
  const callback = () => connect.callback(new Request(callbackUrl, { headers: { cookie } }));
  const synced = await callback();
  assert.equal(synced.status, 200);
  assert.match(synced.headers.get("set-cookie")!, /Max-Age=0/);
  const result = await synced.text();
  assert.match(result, /stats synced/);
  assert.doesNotMatch(result, /789.?000|test-code|test-connect-api-key/);
  assert.equal((await callback()).status, 400);
  assert.deepEqual(connectCalls, [
    { code: "test-code", redirect_uri: `${publicUrl}/auth/wardogs/callback` },
  ]);

  const wrongAccount = await begin();
  returnedSteamId = otherSteamId;
  const mismatch = await connect.callback(
    new Request(wrongAccount.callbackUrl, { headers: { cookie: wrongAccount.cookie } }),
  );
  assert.equal(mismatch.status, 403);

  const revoked = await begin();
  links[0]!.active = false;
  const rejected = await connect.callback(
    new Request(revoked.callbackUrl, { headers: { cookie: revoked.cookie } }),
  );
  assert.equal(rejected.status, 400);
  assert.equal(connectCalls.length, 2);
});
