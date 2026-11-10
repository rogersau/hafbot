/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createPlatformLinkService } from "../src/services/platform-link-service";
import { createSteamIdentityAdapter } from "../src/services/platform-identity-adapter";
import type { ProductAnalyticsEvent } from "../src/product-analytics";
import type {
  PlatformLink,
  PlatformLinkConfig,
  PlatformLinkPlatform,
} from "../src/runtime/contracts/platform-link-store";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

test("PlatformLinkService rejects a new 101st free-tier link across all platforms combined", async () => {
  const fixture = createPlatformLinkFixture(createPlatformLinks(100));
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    guildEntitlementStore: fixture.entitlements,
  });

  await assert.rejects(
    service.saveLink(createPlatformLink("guild-1", "user-101", "steam", "76561198000000101")),
    /plan limit of 100 Platform Links/,
  );
});

test("PlatformLinkService rejects when combined Steam + Xbox links reach free limit", async () => {
  const links = [
    ...createPlatformLinksForPlatform(60, "steam"),
    ...createPlatformLinksForPlatform(40, "xbox"),
  ];
  const fixture = createPlatformLinkFixture(links);
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    guildEntitlementStore: fixture.entitlements,
  });

  await assert.rejects(
    service.saveLink(createPlatformLink("guild-1", "user-101", "xbox", "xuid-101")),
    /plan limit of 100 Platform Links/,
  );
});

test("PlatformLinkService allows updating an existing user+platform entry at the free limit", async () => {
  const fixture = createPlatformLinkFixture(createPlatformLinks(100));
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    guildEntitlementStore: fixture.entitlements,
  });

  await service.saveLink(createPlatformLink("guild-1", "user-10", "steam", "76561198000000010"));

  assert.equal((await service.listLinks("guild-1")).length, 100);
});

test("PlatformLinkService allows premium guilds past the free link limit", async () => {
  const fixture = createPlatformLinkFixture(createPlatformLinks(10), [], "premium");
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    guildEntitlementStore: fixture.entitlements,
  });

  await service.saveLink(createPlatformLink("guild-1", "user-11", "xbox", "xuid-11"));

  assert.equal((await service.listLinks("guild-1")).length, 11);
});

test("PlatformLinkService reports a completed link without user or account identifiers", async () => {
  const fixture = createPlatformLinkFixture([]);
  const events: ProductAnalyticsEvent[] = [];
  const deliveries: Promise<unknown>[] = [];
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    productAnalytics: { report: async (event) => void events.push(event) },
    waitUntil: (promise) => void deliveries.push(promise),
  });

  await service.saveLink(createPlatformLink("guild-1", "user-1", "steam", "steam-account-1"));
  await Promise.all(deliveries);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    name: "feature_outcome",
    insertionId: events[0]!.insertionId,
    guildId: "guild-1",
    feature: "player_link",
    action: "player_link_completed",
    status: "success",
    provider: "steam",
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /user-1|steam-account-1/);
});

test("PlatformLinkService deduplicates replayed completions with a deterministic insertion ID", async () => {
  const fixture = createPlatformLinkFixture([]);
  const events: ProductAnalyticsEvent[] = [];
  const deliveries: Promise<unknown>[] = [];
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    productAnalytics: { report: async (event) => void events.push(event) },
    waitUntil: (promise) => void deliveries.push(promise),
  });
  const link = createPlatformLink("guild-1", "user-1", "steam", "steam-account-1");

  await service.saveLink(link);
  await service.saveLink(link);
  await Promise.all(deliveries);

  assert.equal(events.length, 2);
  assert.equal(events[0]!.insertionId, events[1]!.insertionId);
});

test("PlatformLinkService reports coded persistence failures and preserves the error", async () => {
  const fixture = createPlatformLinkFixture([]);
  const events: ProductAnalyticsEvent[] = [];
  const deliveries: Promise<unknown>[] = [];
  const failure = new Error("database unavailable");
  const service = createPlatformLinkService({
    platformLinkStore: {
      ...fixture.store,
      upsertPlatformLink: async () => {
        throw failure;
      },
    },
    discordBotToken: "token",
    productAnalytics: { report: async (event) => void events.push(event) },
    waitUntil: (promise) => void deliveries.push(promise),
  });

  await assert.rejects(
    service.saveLink(createPlatformLink("guild-1", "user-1", "xbox", "xuid-1")),
    (error) => error === failure,
  );
  await Promise.all(deliveries);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, "feature_outcome");
  assert.equal(
    (events[0] as Extract<ProductAnalyticsEvent, { name: "feature_outcome" }>).status,
    "failure",
  );
  assert.equal(
    (events[0] as Extract<ProductAnalyticsEvent, { name: "feature_outcome" }>).reasonCode,
    "storage_unavailable",
  );
});

test("PlatformLinkService lists all platform links for a user across platforms", async () => {
  const links: PlatformLink[] = [
    createPlatformLink("guild-1", "user-1", "steam", "76561198000000001"),
    createPlatformLink("guild-1", "user-1", "xbox", "xuid-12345"),
  ];
  const service = createPlatformLinkService({
    platformLinkStore: createPlatformLinkFixture(links).store,
    discordBotToken: "token",
  });

  const userLinks = await service.getLinksByUser("guild-1", "user-1");

  assert.equal(userLinks.length, 2);
  assert.ok(userLinks.some((l) => l.platform === "steam"));
  assert.ok(userLinks.some((l) => l.platform === "xbox"));
});

test("PlatformLinkService retains but deactivates configured links when a member leaves", async () => {
  const links = [
    createPlatformLink("guild-1", "user-1", "steam", "steam-1"),
    createPlatformLink("guild-1", "user-1", "xbox", "xbox-1"),
  ];
  const configs = [
    createConfig({ platform: "steam", requireRelinkOnRejoin: true }),
    createConfig({ platform: "xbox", requireRelinkOnRejoin: false }),
  ];
  const fixture = createPlatformLinkFixture(links, configs);
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
  });

  await service.deactivateLinksOnMemberLeave("guild-1", "user-1");

  const retained = await service.getLinksByUser("guild-1", "user-1");
  assert.equal(retained.find((link) => link.platform === "steam")?.active, false);
  assert.equal(retained.find((link) => link.platform === "xbox")?.active, true);
});

test("PlatformLinkService assigns linked role per platform config", async () => {
  const roles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const links: PlatformLink[] = [
    createPlatformLink("guild-1", "user-1", "steam", "76561198000000001"),
  ];
  const configs: PlatformLinkConfig[] = [
    createConfig({ guildId: "guild-1", platform: "steam", linkedRoleId: "role-steam" }),
  ];
  const service = createPlatformLinkService({
    platformLinkStore: createPlatformLinkFixture(links, configs).store,
    discordBotToken: "token",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (
      typeof url === "string" &&
      url.includes("discord.com") &&
      (init as RequestInit)?.method === "PUT"
    ) {
      const match = url.match(/guilds\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)/);
      if (match) {
        roles.push({ guildId: match[1], userId: match[2], roleId: match[3] });
      }
    }
    return new Response("{}", { status: 200 });
  };

  try {
    await service.assignLinkedRole("guild-1", "user-1", "steam");
    assert.equal(roles.length, 1);
    assert.deepEqual(roles[0], { guildId: "guild-1", userId: "user-1", roleId: "role-steam" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PlatformLinkService enriches Steam through its identity adapter without changing other providers", async () => {
  const links: PlatformLink[] = [];
  const configs = [createConfig({ platform: "steam", gameAppIds: [730] })];
  const fixture = createPlatformLinkFixture(links, configs);
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    identityAdapters: {
      steam: {
        platform: "steam",
        enrichMetadata: async (platformId, config) =>
          JSON.stringify({ platformId, gameAppIds: config.gameAppIds }),
        describe: () => ({ accountLines: [], detailFields: [], whoisLines: [] }),
      },
    },
  });

  await service.saveLink(createPlatformLink("guild-1", "steam-user", "steam", "steam-id"));
  await service.saveLink(createPlatformLink("guild-1", "xbox-user", "xbox", "xuid"));
  await service.saveLink(
    createPlatformLink("guild-1", "playstation-user", "playstation", "psn-id"),
  );

  const saved = await service.listLinks("guild-1");
  assert.equal(
    saved.find((link) => link.platform === "steam")?.metadataJson,
    '{"platformId":"steam-id","gameAppIds":[730]}',
  );
  assert.equal(saved.find((link) => link.platform === "xbox")?.metadataJson, null);
  assert.equal(saved.find((link) => link.platform === "playstation")?.metadataJson, null);
});

test("PlatformLinkService preserves Steam custom links in an unlink audit after deletion", async () => {
  const link = createPlatformLink("guild-1", "user-1", "steam", "76561198000000001");
  const links = [link];
  const configs = [
    createConfig({
      logChannelId: "log-channel",
      customLinks: [{ label: "CFTools", url: "https://example.test/{steamId64}" }],
    }),
  ];
  const fixture = createPlatformLinkFixture(links, configs);
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    identityAdapters: { steam: createSteamIdentityAdapter({}) },
  });
  const messages: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    messages.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  };

  try {
    await service.deleteLink("guild-1", "user-1", "steam", link.platformId);
    await service.sendLogEmbed("guild-1", "unlinked", {
      linkSnapshot: link,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal((await service.listLinks("guild-1")).length, 0);
  const message = messages[0] as {
    embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
  };
  const accountField = message.embeds[0].fields.find((field) => field.name === "Steam Account");
  assert.match(accountField?.value ?? "", /CFTools: https:\/\/example\.test\/76561198000000001/);
});

test("PlatformLinkService runs unlink finalization while the link is still recoverable", async () => {
  const link = createPlatformLink("guild-1", "user-1", "steam", "76561198000000001");
  const fixture = createPlatformLinkFixture([link]);
  let visibleDuringFinalization = false;
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    onLinksRemoving: async () => {
      visibleDuringFinalization =
        (await fixture.store.readPlatformLink("guild-1", "user-1", "steam")) !== null;
    },
  });

  await service.deleteLink("guild-1", "user-1", "steam", link.platformId);

  assert.equal(visibleDuringFinalization, true);
  assert.equal(await fixture.store.readPlatformLink("guild-1", "user-1", "steam"), null);
});

function createPlatformLinks(count: number): PlatformLink[] {
  return Array.from({ length: count }, (_, index) =>
    createPlatformLink(
      "guild-1",
      `user-${index + 1}`,
      "steam",
      `765611980000000${String(index + 1).padStart(2, "0")}`,
    ),
  );
}

function createPlatformLinksForPlatform(
  count: number,
  platform: PlatformLinkPlatform,
): PlatformLink[] {
  return Array.from({ length: count }, (_, index) =>
    createPlatformLink(
      "guild-1",
      `${platform}-user-${index + 1}`,
      platform,
      platform === "steam"
        ? `765611980000000${String(index + 1).padStart(2, "0")}`
        : `xuid-${index + 1}`,
    ),
  );
}

function createPlatformLink(
  guildId: string,
  userId: string,
  platform: PlatformLinkPlatform,
  platformId: string,
): PlatformLink {
  return {
    guildId,
    userId,
    platform,
    platformId,
    linkedAtMs: 1,
    manual: false,
    actionedByUserId: null,
    metadataJson: null,
    active: true,
  };
}

function createConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your account",
    panelDescription: "Link your account",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    updatedAtMs: 1,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    ...overrides,
  };
}

function createPlatformLinkFixture(
  links: PlatformLink[] = [],
  configs: PlatformLinkConfig[] = [],
  tier: "free" | "premium" = "free",
) {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.platformLink;
  const ready = (async () => {
    if (tier !== "free") {
      await fixture.database.d1
        .prepare(
          "INSERT INTO guild_entitlements (guild_id, tier, plan, updated_at_ms) VALUES (?, ?, ?, ?)",
        )
        .bind("guild-1", tier, tier, 1)
        .run();
    }
    for (const config of configs) await rawStore.upsertPlatformLinkConfig(config);
    for (const link of links) await rawStore.upsertPlatformLink(link);
  })();
  return {
    store: afterStoreSeed(rawStore, ready),
    entitlements: afterStoreSeed(fixture.stores.guildEntitlements, ready),
  };
}

test("PlatformLinkService replaces a link at the pooled plan cap and finalizes only after commit", async () => {
  const fixture = createPlatformLinkFixture(createPlatformLinks(100), [createConfig()]);
  const original = await fixture.store.readPlatformLink("guild-1", "user-1", "steam");
  assert.ok(original);
  const replacement = createPlatformLink("guild-1", "user-1", "steam", "replacement");
  const removed: PlatformLink[] = [];
  let prepared = false;
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    guildEntitlementStore: fixture.entitlements,
    identityAdapters: {
      steam: {
        platform: "steam",
        describe: () => ({ accountLines: [], detailFields: [], whoisLines: [] }),
        enrichMetadata: async () => {
          assert.deepEqual(
            await fixture.store.readPlatformLink("guild-1", "user-1", "steam"),
            original,
          );
          assert.equal(removed.length, 0);
          prepared = true;
          return '{"enriched":true}';
        },
      },
    },
    onLinksReplacing: async (_link, replaceLinks) => {
      assert.equal(prepared, true);
      await replaceLinks();
      assert.equal(
        await fixture.store.readPlatformLinkEntry(
          "guild-1",
          "user-1",
          "steam",
          original.platformId,
        ),
        null,
      );
      assert.equal(
        (await fixture.store.readPlatformLink("guild-1", "user-1", "steam"))?.metadataJson,
        '{"enriched":true}',
      );
      removed.push(original);
    },
  });
  await service.saveLink(replacement, true);
  assert.equal((await service.listLinks("guild-1")).length, 100);
  assert.deepEqual(removed, [original]);
});

test("PlatformLinkService keeps an existing identity and skips removal finalization on enrichment failure", async () => {
  const original = createPlatformLink("guild-1", "user-1", "steam", "original");
  const fixture = createPlatformLinkFixture([original], [createConfig()]);
  let removalCalled = false;
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    identityAdapters: {
      steam: {
        platform: "steam",
        describe: () => ({ accountLines: [], detailFields: [], whoisLines: [] }),
        enrichMetadata: async () => {
          throw new Error("provider unavailable");
        },
      },
    },
    onLinksReplacing: async () => {
      removalCalled = true;
    },
  });
  await assert.rejects(
    service.saveLink(createPlatformLink("guild-1", "user-1", "steam", "replacement"), true),
    /provider unavailable/,
  );
  assert.deepEqual(await service.listLinks("guild-1"), [original]);
  assert.equal(removalCalled, false);
});

test("PlatformLinkService distinguishes post-commit cleanup failure from persistence failure", async () => {
  const fixture = createPlatformLinkFixture([
    createPlatformLink("guild-1", "user-1", "steam", "original"),
  ]);
  const events: ProductAnalyticsEvent[] = [];
  const deliveries: Promise<unknown>[] = [];
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    productAnalytics: { report: async (event) => void events.push(event) },
    waitUntil: (promise) => void deliveries.push(promise),
    onLinksReplacing: async (_link, replaceLinks) => {
      await replaceLinks();
      throw new Error("cleanup unavailable");
    },
  });
  await assert.rejects(
    service.saveLink(createPlatformLink("guild-1", "user-1", "steam", "replacement"), true),
    { name: "PlatformLinkFinalizationError" },
  );
  assert.equal((await service.listLinks("guild-1"))[0]?.platformId, "replacement");
  await Promise.all(deliveries);
  assert.equal(events.length, 1);
  assert.equal(
    (events[0] as Extract<ProductAnalyticsEvent, { name: "feature_outcome" }>).status,
    "success",
  );
});

for (const platform of ["steam", "xbox", "playstation"] as const) {
  test(`${platform} disable retains existing links and rejects new and pending links`, async () => {
    const config = createConfig({ platform, enabled: false });
    const link = createPlatformLink("guild-1", "user-1", platform, "account-1");
    const fixture = createPlatformLinkFixture([link], [config]);
    const service = createPlatformLinkService({
      platformLinkStore: fixture.store,
      discordBotToken: "token",
    });
    assert.equal((await service.readConfig("guild-1", platform))?.enabled, false);
    await assert.rejects(
      service.createPendingLink("state", "guild-1", "user-2", platform),
      /disabled/,
    );
    await assert.rejects(
      service.saveLink(createPlatformLink("guild-1", "user-2", platform, "account-2")),
      /disabled/,
    );
    assert.equal((await service.listLinks("guild-1", platform)).length, 1);
    await service.saveConfig({ ...config, enabled: true });
    await service.createPendingLink("state", "guild-1", "user-2", platform);
    assert.equal((await service.readPendingLink("state"))?.platform, platform);
  });
}

test("a link disabled during provider enrichment is rejected before persistence", async () => {
  const config = createConfig();
  const fixture = createPlatformLinkFixture([], [config]);
  const service = createPlatformLinkService({
    platformLinkStore: fixture.store,
    discordBotToken: "token",
    identityAdapters: {
      steam: {
        ...createSteamIdentityAdapter({ steamWebApiKey: "test" }),
        async enrichMetadata() {
          await fixture.store.setPlatformLinkEnabled?.("guild-1", "steam", false);
          return null;
        },
      },
    },
  });
  await assert.rejects(
    service.saveLink(createPlatformLink("guild-1", "user-1", "steam", "account-1")),
    /disabled/,
  );
  assert.deepEqual(await service.listLinks("guild-1"), []);
});
