/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test, { type TestContext } from "node:test";
import { DiscordApiError, isDiscordRateLimitError } from "../src/discord/client";
import { createPlatformLinkRoutes } from "../src/routes/platform-link-routes";
import { createServiceFactory } from "../src/runtime/service-factory";
import { createCloudflareSteamLinkStore } from "../src/runtime/cloudflare-steam-link-store";
import { handleSteamManualLinkCommand } from "../src/runtime/steam-link-interaction-handler";
import { ServerLevelProcessor } from "../src/server-levels/processor";
import { PlatformLinkFinalizationError } from "../src/services/platform-link-service";
import { createSteamPlatformConfig } from "../src/services/steam-platform-config";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

const original = {
  guildId: "guild-1",
  userId: "user-1",
  platform: "steam" as const,
  platformId: "76561198000000001",
  linkedAtMs: 0,
  manual: true,
  actionedByUserId: "admin-1",
  metadataJson: null,
  active: true,
};
const replacement = { ...original, platformId: "76561198000000002", linkedAtMs: 61_000 };

async function setup(t: TestContext) {
  const fixture = createProductionRuntimeStores();
  t.after(() => fixture.close());
  t.mock.method(Date, "now", () => 61_000);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/guilds\/guild-1\/members\/user-1$/);
    return Response.json({ user: { id: "user-1" } });
  });
  const links = fixture.stores.platformLink;
  const store = fixture.stores.serverLevels!;
  const legacy = createCloudflareSteamLinkStore(fixture.database.d1);
  await fixture.database.d1
    .prepare(
      "INSERT INTO guild_entitlements (guild_id, tier, plan, updated_at_ms) VALUES (?, ?, ?, ?)",
    )
    .bind("guild-1", "premium", "premium", 1)
    .run();
  await links.upsertPlatformLink(original);
  await legacy.upsertSteamLink({
    guildId: original.guildId,
    userId: original.userId,
    steamId64: original.platformId,
    linkedAtMs: original.linkedAtMs,
    manual: original.manual,
    actionedByUserId: original.actionedByUserId,
    gameOwnership: [],
  });
  await store.upsertConfig({
    guildId: "guild-1",
    enabled: true,
    announcementChannelId: null,
    removedAtMs: null,
    updatedAtMs: 1,
  });
  // Deliberately reverse creation order to exercise acquisition across multiple servers.
  const servers = ["server-2", "server-1"];
  for (const id of servers) {
    await store.createConfiguredGameServer({
      id,
      guildId: "guild-1",
      displayName: id,
      providerServerId: id,
      maxSlots: 4,
      endpointId: `endpoint-${id}`,
      webhookCredentialId: `credential-${id}`,
      webhookVerifiedAtMs: 1,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
  }
  const services = createServiceFactory({ stores: fixture.stores, discordBotToken: "test-token" });
  for (const id of servers) {
    assert.equal(
      await services.serverLevelProcessor!.reconcileCurrentRoster({
        configuredGameServerId: id,
        steamIds: [original.platformId],
        population: 1,
        queueSize: 0,
        maxSlots: 4,
        observedAtMs: 1_000,
        checkCapacity: false,
      }),
      "completed",
    );
  }
  const worker = new ServerLevelProcessor({
    store,
    platformLinks: links,
    readEntitlementTier: async () => "premium",
    isCurrentGuildMember: async () => true,
    now: () => 61_000,
  });
  return { ...fixture, links, store, legacy, services, worker, servers };
}

test("Steam replacement holds every processing lease through commit and finalization", async (t) => {
  const f = await setup(t);
  const replaceLinks = f.links.replacePlatformLinks;
  let competed = false;
  f.links.replacePlatformLinks = async (link) => {
    assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [original]);
    await replaceLinks(link);
    assert.equal(
      await f.links.readPlatformLinkByPlatformId("guild-1", "steam", original.platformId),
      null,
    );
    // Force a real provider checkpoint into the old commit-to-finalization gap.
    for (const id of f.servers) {
      await f.worker.checkpointAvailableForServer(id, 661_000);
      assert.equal(
        (await f.store.readOpenEarningSession(id, original.platformId))?.checkpointAtMs,
        61_000,
      );
    }
    competed = true;
  };
  await f.services.platformLinkService.saveLink(replacement, true);
  assert.equal(competed, true);
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  for (const id of f.servers) {
    assert.equal(await f.store.readOpenEarningSession(id, original.platformId), null);
    assert.equal(await f.store.readCurrentPresence(id, original.platformId), null);
    await f.worker.checkpointAvailableForServer(id, 661_000);
  }
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [replacement]);
  assert.deepEqual(await f.legacy.listSteamLinks("guild-1"), []);
});

test("failed Steam replacement transaction retains current and legacy identity and earning", async (t) => {
  const f = await setup(t);
  f.database.execRaw(`CREATE TRIGGER fail_replacement BEFORE INSERT ON platform_links
    WHEN NEW.platform_id = '${replacement.platformId}'
    BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END`);
  await assert.rejects(
    f.services.platformLinkService.saveLink(replacement, true),
    /injected replacement failure/,
  );
  assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [original]);
  assert.equal((await f.legacy.listSteamLinks("guild-1")).length, 1);
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  for (const id of f.servers) {
    assert.equal(
      (await f.store.readOpenEarningSession(id, original.platformId))?.checkpointAtMs,
      61_000,
    );
    assert.ok(await f.store.readCurrentPresence(id, original.platformId));
    await f.worker.checkpointAvailableForServer(id, 721_000);
    assert.ok(await f.store.readOpenEarningSession(id, original.platformId));
  }
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 480);
});

test("busy later server lease aborts Steam replacement and releases earlier leases before retry", async (t) => {
  const f = await setup(t);
  assert.equal(
    await f.store.acquireProcessingLease!("server-2", "provider-worker", 61_000, 361_000),
    true,
  );
  await assert.rejects(
    f.services.platformLinkService.saveLink(replacement, true),
    /processing lease is busy/,
  );
  assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [original]);
  for (const id of f.servers)
    assert.ok(await f.store.readOpenEarningSession(id, original.platformId));
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 0);
  assert.equal(await f.store.acquireProcessingLease!("server-1", "probe", 61_000, 361_000), true);
  await f.store.releaseProcessingLease!("server-1", "probe");
  await f.store.releaseProcessingLease!("server-2", "provider-worker");
  await f.services.platformLinkService.saveLink(replacement, true);
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
});

for (const failure of ["award", "checkpoint"] as const) {
  test(`Steam replacement retains all identities after partial ${failure} failure and retries without stacking`, async (t) => {
    const f = await setup(t);
    const additional = { ...original, platformId: "76561198000000003" };
    await f.links.upsertPlatformLink(additional);
    await f.worker.reconcileCurrentRoster({
      configuredGameServerId: "server-2",
      steamIds: [additional.platformId],
      population: 1,
      queueSize: 0,
      maxSlots: 4,
      observedAtMs: 1_000,
      checkCapacity: false,
    });
    // The first server durably awards 3x; the later identity needs a 4x delta.
    const cursor = (await f.store.readProcessingCursor("server-1"))!;
    await f.store.upsertProcessingCursor({ ...cursor, population: 2 });
    if (failure === "award") {
      f.database.execRaw(`CREATE TRIGGER fail_final_checkpoint BEFORE INSERT ON server_level_awards
        WHEN NEW.configured_game_server_id = 'server-2'
        BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`);
    } else {
      f.database
        .execRaw(`CREATE TRIGGER fail_final_checkpoint BEFORE UPDATE ON server_level_earning_sessions
        WHEN NEW.configured_game_server_id = 'server-2' AND NEW.checkpoint_at_ms = 61000
        BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`);
    }
    await assert.rejects(
      f.services.platformLinkService.saveLink(replacement, true),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.cause instanceof Error ? error.cause.message : error.message,
          /injected checkpoint failure/,
        );
        return true;
      },
    );
    assert.deepEqual(
      (await f.links.listPlatformLinksByUser("guild-1", "user-1"))
        .map((link) => link.platformId)
        .sort(),
      [original.platformId, additional.platformId],
    );
    assert.equal((await f.legacy.listSteamLinks("guild-1")).length, 1);
    assert.equal(
      (await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits,
      failure === "award" ? 180 : 240,
    );
    for (const [serverId, steamId] of [
      ["server-1", original.platformId],
      ["server-2", additional.platformId],
    ]) {
      assert.ok(await f.store.readOpenEarningSession(serverId, steamId));
      assert.ok(await f.store.readCurrentPresence(serverId, steamId));
    }
    f.database.execRaw("DROP TRIGGER fail_final_checkpoint");
    // Recovery through ordinary processing uses a different award source ID.
    for (const id of f.servers) await f.worker.checkpointAvailableForServer(id, 661_000);
    assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    await f.services.platformLinkService.saveLink(replacement, true);
    assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [replacement]);
    for (const id of f.servers) {
      assert.deepEqual(await f.store.listOpenEarningSessions(id), []);
      assert.deepEqual(await f.store.listCurrentPresence(id), []);
      await f.worker.checkpointAvailableForServer(id, 721_000);
    }
    assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  });
}

test("Steam replacement does not award a member confirmed absent", async (t) => {
  const f = await setup(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: "Unknown Member", code: 10007 }, { status: 404 }),
  );
  await f.services.platformLinkService.saveLink(replacement, true);
  assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [replacement]);
  for (const id of f.servers) {
    assert.deepEqual(await f.store.listOpenEarningSessions(id), []);
    await f.worker.checkpointAvailableForServer(id, 721_000);
  }
  assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 0);
});

for (const failure of ["close", "presence"] as const) {
  test(`Steam replacement preserves all XP after committed ${failure} cleanup failure`, async (t) => {
    const f = await setup(t);
    if (failure === "close") {
      f.database.execRaw(`CREATE TRIGGER fail_cleanup BEFORE UPDATE ON server_level_earning_sessions
        WHEN NEW.closed_at_ms IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END`);
    } else {
      f.database.execRaw(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON server_level_current_presence
        BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END`);
    }
    await assert.rejects(
      f.services.platformLinkService.saveLink(replacement, true),
      (error: unknown) => {
        assert.ok(error instanceof PlatformLinkFinalizationError);
        assert.ok(error.cause instanceof Error);
        assert.ok(error.cause.cause instanceof Error);
        assert.match(error.cause.cause.message, /injected cleanup failure/);
        return true;
      },
    );
    assert.deepEqual(await f.links.listPlatformLinksByUser("guild-1", "user-1"), [replacement]);
    assert.deepEqual(await f.legacy.listSteamLinks("guild-1"), []);
    assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    f.database.execRaw("DROP TRIGGER fail_cleanup");
    for (const id of f.servers) {
      await f.worker.checkpointAvailableForServer(id, 721_000);
      assert.deepEqual(await f.store.listOpenEarningSessions(id), []);
    }
    await f.services.platformLinkService.saveLink(replacement, true);
    assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  });
}

for (const entry of ["manual", "callback"] as const) {
  for (const status of [500, 429]) {
    test(`Steam ${entry} retains earning on membership ${status} and recovers before retry`, async (t) => {
      const f = await setup(t);
      await f.links.upsertPlatformLinkConfig({
        guildId: "guild-1",
        platform: "steam",
        linkedRoleId: null,
        logChannelId: null,
        gameAppIds: [],
        panelTitle: "Link",
        panelDescription: "Link",
        panelButtonLabel: "Link",
        panelButtonStyle: "Primary",
        allowRelink: true,
        allowMultipleLinks: false,
        requireRelinkOnRejoin: false,
        whoisFields: [],
        customLinks: [],
        panelChannelId: null,
        panelMessageId: null,
        updatedAtMs: 1,
      });
      let membershipChecks = 0;
      let membershipHealthy = false;
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
        if (String(input).startsWith("https://steamcommunity.com/openid/login"))
          return new Response("is_valid:true");
        assert.match(String(input), /\/guilds\/guild-1\/members\/user-1$/);
        membershipChecks += 1;
        if (membershipHealthy) return Response.json({ user: { id: "user-1" } });
        return Response.json({ message: "membership unavailable", retry_after: 10 }, { status });
      });
      const service = f.services.platformLinkService;
      const saveLink = service.saveLink;
      let saveError: unknown;
      t.mock.method(service, "saveLink", async (...args: Parameters<typeof saveLink>) => {
        try {
          return await saveLink(...args);
        } catch (error) {
          saveError = error;
          throw error;
        }
      });
      const effects: string[] = [];
      t.mock.method(service, "assignLinkedRole", async () => {
        effects.push("role");
      });
      t.mock.method(service, "sendLogEmbed", async () => {
        effects.push("audit");
      });
      const routes = createPlatformLinkRoutes({
        platformLinkService: service,
        platformConfig: createSteamPlatformConfig(),
      });
      const callback = (state: string) =>
        new Request(
          `https://runtime.example/auth/steam/callback?state=${state}&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/${replacement.platformId}`,
        );
      const invoke = async (state: string) => {
        if (entry === "callback") {
          await service.createPendingLink(state, "guild-1", "user-1", "steam");
          return routes(callback(state));
        }
        return handleSteamManualLinkCommand(
          {
            type: 2,
            guild_id: "guild-1",
            member: { user: { id: "admin-1" } },
            data: {
              options: [
                {
                  type: 1,
                  name: "manual-link",
                  options: [
                    { name: "user", value: "user-1" },
                    { name: "steamid", value: replacement.platformId },
                  ],
                },
              ],
            },
          },
          service,
        );
      };
      if (entry === "manual") {
        await assert.rejects(invoke("replacement-state"), (error: unknown) => error === saveError);
      } else {
        const response = await invoke("replacement-state");
        assert.equal(response?.status, 500);
        const html = await response!.text();
        assert.match(html, /Could not finish linking/);
        assert.match(html, /start a new request/);
        assert.doesNotMatch(html, /account was saved/);
        assert.equal(await service.readPendingLink("replacement-state"), null);
        assert.equal((await routes(callback("replacement-state")))?.status, 400);
      }
      assert.equal(membershipChecks, 1);
      assert.ok(saveError instanceof DiscordApiError);
      assert.equal(saveError.status, status);
      assert.equal(isDiscordRateLimitError(saveError), status === 429);
      assert.deepEqual(effects, []);
      assert.deepEqual(await service.listLinks("guild-1"), [original]);
      assert.equal((await f.legacy.listSteamLinks("guild-1")).length, 1);
      assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 0);
      for (const id of f.servers) {
        assert.equal(
          (await f.store.readOpenEarningSession(id, original.platformId))?.checkpointAtMs,
          1_000,
        );
        assert.ok(await f.store.readCurrentPresence(id, original.platformId));
      }
      membershipHealthy = true;
      for (const id of f.servers) await f.worker.checkpointAvailableForServer(id, 661_000);
      assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
      assert.equal((await invoke("fresh-state"))?.status, 200);
      assert.deepEqual(effects, ["role", "audit"]);
      const saved = await service.listLinks("guild-1");
      assert.equal(saved.length, 1);
      assert.equal(saved[0]?.platformId, replacement.platformId);
      assert.equal(saved[0]?.active, true);
      assert.deepEqual(await f.legacy.listSteamLinks("guild-1"), []);
      await service.saveLink(saved[0]!, true);
      for (const id of f.servers) {
        assert.equal(await f.store.readOpenEarningSession(id, original.platformId), null);
        await f.worker.checkpointAvailableForServer(id, 721_000);
      }
      assert.equal((await f.store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    });
  }
}
