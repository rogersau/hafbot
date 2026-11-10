import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createCloudflareWardogsStore } from "../src/runtime/cloudflare-wardogs-store";
import { WardogsService } from "../src/wardogs/service";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { createWardogsPlayerCountStatusProvider } from "../src/services/wardogs-player-count-status-provider";
import { createPlayerCountStatusProviderResolver } from "../src/services/player-count-status-provider";
import {
  PlayerCountService,
  applyPlayerCountTemplate,
  type PlayerCountAuditEventInput,
} from "../src/services/player-count-service";
import { createAdminApiHandler } from "./helpers/admin-api";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";
import type { NetworkPolicy } from "../src/wardogs/model";
const synthetic = JSON.parse(readFileSync("test/fixtures/wardogs/reads.json", "utf8"));
async function setup() {
  const fixture = createProductionRuntimeStores();
  await fixture.database.d1
    .prepare(
      "INSERT INTO guild_entitlements (guild_id, tier, plan, updated_at_ms) VALUES (?, ?, ?, ?)",
    )
    .bind("guild-1", "premium", "premium", 1)
    .run();
  const clock = { now: 2_000_000 };
  const calls: string[] = [];
  let respond: () => Promise<Response> = async () => Response.json(synthetic.status);
  const policy: NetworkPolicy = {
    enabled: true,
    origins: [
      {
        id: "synthetic",
        origin: "https://wardogs.example.com",
        runtime: "cloudflare",
        securePathEvidence: "Synthetic fixture recording only",
      },
    ],
    approvals: [],
  };
  const createWardogs = () =>
    new WardogsService({
      store: createCloudflareWardogsStore(fixture.database.d1),
      policy,
      runtime: "cloudflare",
      keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
      now: () => clock.now,
      wait: async (ms) => {
        clock.now += ms;
      },
      transport: async (url, init) => {
        assert.equal(init.method, "GET");
        calls.push(url);
        return url.endsWith("capabilities") ? Response.json(synthetic.capabilities) : respond();
      },
    });
  const wardogs = createWardogs();
  let target = await wardogs.create("guild-1", "Synthetic server", "synthetic");
  target = await wardogs.change({
    guildId: "guild-1",
    targetId: target.id,
    generation: target.generation,
    secret: "synthetic-password",
    enabled: true,
  });
  policy.approvals = [
    {
      targetId: target.id,
      generation: target.generation,
      originRef: "synthetic",
      origin: "https://wardogs.example.com",
    },
  ];
  await wardogs.verify({
    guildId: "guild-1",
    targetId: target.id,
    generation: target.generation,
    roster: false,
  });
  clock.now += 5000;
  calls.length = 0;
  const adapterOptions = { wardogs, enabled: true };
  const provider = createWardogsPlayerCountStatusProvider(adapterOptions);
  const renamed: string[] = [];
  const gates = { enabled: true, suspended: false };
  const reportedStreaks = new Set<string>();
  const alerts: PlayerCountAuditEventInput[] = [];
  const createService = (statusProvider = provider) =>
    new PlayerCountService(fixture.stores.playerCount, {
      now: () => clock.now,
      discordBotToken: "synthetic-discord",
      modifyChannel: async (_, body) => {
        renamed.push(body.name);
      },
      resolveStatusProvider: createPlayerCountStatusProviderResolver({
        "wardogs-rcon": statusProvider,
        "steam-web": {
          query: async () => ({ ok: true, snapshot: { count: 12, maxSlots: 60, queue: 3 } }),
        },
      }),
      streakReportedStore: {
        isStreakReported: async (key) => reportedStreaks.has(key),
        markStreakReported: async (key) => {
          reportedStreaks.add(key);
        },
        clearStreakReported: async (key) => {
          reportedStreaks.delete(key);
        },
      },
      postPlayerCountAuditEvent: async (event) => {
        alerts.push(event);
      },
      postPlayerCountDeletionAuditEvent: async () => {},
      guildEntitlements: fixture.stores.guildEntitlements,
      get enabled() {
        return gates.enabled;
      },
      isGuildSuspended: async () => gates.suspended,
    });
  const service = createService();
  const added = await service.addServer({
    guildId: "guild-1",
    name: "WARDOGS",
    provider: "wardogs-rcon",
    providerServerId: target.id,
    channelId: "voice-1",
    failureThreshold: 1,
  });
  assert.ok(added.ok);
  return {
    ...fixture,
    clock,
    calls,
    policy,
    wardogs,
    target,
    service,
    provider,
    renamed,
    gates,
    adapterOptions,
    reportedStreaks,
    alerts,
    restart: () =>
      createService(
        createWardogsPlayerCountStatusProvider({ wardogs: createWardogs(), enabled: true }),
      ),
    server: added.server,
    respond: (next: typeof respond) => {
      respond = next;
    },
  };
}

test("WARDOGS Player Count maps synthetic status only, actual capacity and unavailable queue", async () => {
  const f = await setup();
  try {
    for (const [count, maxSlots] of [
      [0, 60],
      [60, 60],
      [65, 60],
      [70, 80],
      [99, 100],
    ]) {
      f.respond(async () =>
        Response.json({
          players: { current: count, max: maxSlots },
          serverName: "Fixture",
          map: "Fixture map",
          queue: 50,
        }),
      );
      const result = await f.service.refreshServer("guild-1", f.server.id);
      assert.ok(result.ok);
      const stored = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
      assert.equal(stored.lastPlayerCount, count);
      assert.equal(stored.lastMaxSlots, maxSlots);
      assert.equal(stored.lastQueueSize, null);
      assert.equal(
        applyPlayerCountTemplate("{count}/{max} Q:{queue}{queue? +}", stored),
        `${count}/${maxSlots} Q:?`,
      );
      f.clock.now += 60_000;
    }
    const mapped = await f.provider.query(f.server);
    assert.ok(mapped.ok);
    if (mapped.ok) {
      assert.equal(mapped.snapshot.serverName, "Fixture");
      assert.equal(mapped.snapshot.map, "Fixture map");
    }
    assert.ok(f.calls.every((url) => url.endsWith("/v1/status")));
    assert.equal(f.server.steamHost, null);
    assert.equal(f.server.steamPort, null);
  } finally {
    f.close();
  }
});

test("WARDOGS Player Count preserves last success on failures and recovers without catch-up", async () => {
  const f = await setup();
  try {
    await f.service.refreshServer("guild-1", f.server.id);
    const previous = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    f.clock.now += 600_000;
    f.respond(async () => new Response("private provider details", { status: 500 }));
    await f.service.refreshAllServers();
    const failed = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(failed.lastFetchedAtMs, previous.lastFetchedAtMs);
    assert.equal(failed.lastPlayerCount, previous.lastPlayerCount);
    assert.equal(failed.consecutiveFailureCount, 1);
    assert.ok(!failed.lastErrorMessage?.includes("private"));
    await f.service.renameDueChannels();
    assert.equal(f.renamed.at(-1), failed.offlineFormat);
    f.clock.now += 600_000;
    f.respond(async () => Response.json(synthetic.status));
    const calls = f.calls.length;
    await f.service.refreshAllServers();
    assert.equal(f.calls.length, calls + 1);
    const recovered = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(recovered.consecutiveFailureCount, 0);
    assert.equal(recovered.lastErrorAtMs, null);
    assert.equal(recovered.lastFetchedAtMs, f.clock.now);
  } finally {
    f.close();
  }
});

test("WARDOGS Player Count suppresses polling for free, suspended, disabled and unapproved targets", async () => {
  const f = await setup();
  try {
    f.clock.now += 600_000;
    f.adapterOptions.enabled = false;
    assert.equal((await f.service.testServerReachability("guild-1", f.server.id)).ok, false);
    f.adapterOptions.enabled = true;
    f.policy.enabled = false;
    await f.service.refreshAllServers();
    f.policy.enabled = true;
    f.gates.suspended = true;
    await f.service.refreshServer("guild-1", f.server.id);
    f.gates.suspended = false;
    f.gates.enabled = false;
    await f.service.testServerReachability("guild-1", f.server.id);
    f.gates.enabled = true;
    await f.database.d1
      .prepare(
        "UPDATE guild_entitlements SET tier = 'free', plan = 'free' WHERE guild_id = 'guild-1'",
      )
      .run();
    await f.service.testServerReachability("guild-1", f.server.id);
    await f.service.refreshAllServers();
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.stores.playerCount.readPlayerCountServer(f.server.id))!.consecutiveFailureCount,
      0,
    );
  } finally {
    f.close();
  }
});

test("WARDOGS target replacement clears stored snapshots and requires renewed approval", async () => {
  const f = await setup();
  try {
    await f.service.refreshServer("guild-1", f.server.id);
    f.clock.now += 1;
    await f.wardogs.change({
      guildId: "guild-1",
      targetId: f.target.id,
      generation: f.target.generation,
      secret: "replacement-synthetic",
    });
    const beforeScheduledClear = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(beforeScheduledClear.lastPlayerCount, 1);
    assert.notEqual(beforeScheduledClear.lastFetchedAtMs, null);
    await f.service.refreshAllServers();
    const persisted = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(persisted.lastPlayerCount, null);
    assert.equal(persisted.lastMaxSlots, null);
    assert.equal(persisted.lastFetchedAtMs, null);
    const listed = (await f.service.listServers("guild-1"))[0]!;
    assert.equal(listed.lastPlayerCount, null);
    assert.equal(listed.lastFetchedAtMs, null);
    assert.equal(listed.readiness, "dormant");
    assert.equal(
      (await f.stores.playerCount.readPlayerCountServer(f.server.id))!.lastQueueSize,
      null,
    );
    const calls = f.calls.length;
    await f.service.refreshServer("guild-1", f.server.id);
    await f.service.renameDueChannels();
    assert.equal(f.calls.length, calls);
    assert.equal(f.renamed.length, 0);
  } finally {
    f.close();
  }
});

test("Player Count fences late WARDOGS results after provider changes, including change-away-and-back", async () => {
  const f = await setup();
  try {
    let finish!: (response: Response) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.respond(() => {
      began();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = f.service.refreshServer("guild-1", f.server.id);
    await started;
    await f.stores.playerCount.upsertPlayerCountServer({
      ...f.server,
      provider: "steam-web",
      providerServerId: "steam",
      steamHost: "1.2.3.4",
    });
    await f.stores.playerCount.upsertPlayerCountServer(f.server);
    finish(Response.json(synthetic.status));
    assert.equal((await pending).ok, false);
    assert.equal(
      (await f.stores.playerCount.readPlayerCountServer(f.server.id))!.lastFetchedAtMs,
      null,
    );
  } finally {
    f.close();
  }
});

test("Player Count WARDOGS admin saves enforce ownership, confirmation, nullable queue and write-only target references", async () => {
  const f = await setup();
  try {
    const handler = createAdminApiHandler({
      stores: f.stores,
      services: { playerCountService: f.service },
      wardogs: f.wardogs,
      wardogsPlayerCountEnabled: true,
      discordBotToken: "test",
      guildResources: createPermissiveGuildResourceValidator(),
    });
    async function request(path: string, body?: Record<string, unknown>) {
      const url = new URL(`https://admin.example/admin/api/player-count${path}`);
      const req = new Request(url, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const response = await handler(req, url);
      assert.ok(response);
      return response;
    }
    const foreign = await f.wardogs.create("guild-2", "Foreign", null);
    const base = {
      guildId: "guild-1",
      name: "Entry",
      provider: "wardogs-rcon",
      providerServerId: foreign.id,
    };
    assert.equal((await request("/server", base)).status, 400);
    assert.equal(
      (await request("/server", { ...base, providerServerId: f.target.id })).status,
      200,
    );
    const testResult = await request("/test", { guildId: "guild-1", serverId: f.server.id });
    assert.equal(testResult.status, 200);
    assert.equal(((await testResult.json()) as { snapshot: { queue: null } }).snapshot.queue, null);
    f.clock.now += 60_000;
    await f.service.refreshServer("guild-1", f.server.id);
    f.reportedStreaks.add(`player_count:streak_reported:guild-1:${f.server.id}`);
    const change = {
      guildId: "guild-1",
      id: f.server.id,
      name: f.server.name,
      provider: "steam-web",
      providerServerId: "1.2.3.4:27015",
      steamHost: "1.2.3.4",
      steamPort: 27015,
    };
    assert.equal((await request("/server", change)).status, 409);
    assert.equal((await request("/server", { ...change, confirmReplacement: true })).status, 200);
    const stored = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(stored.lastFetchedAtMs, null);
    assert.equal(stored.channelId, f.server.channelId);
    assert.equal(stored.displayFormat, f.server.displayFormat);
    assert.equal(f.reportedStreaks.size, 0);
    const listing = await request("?guildId=guild-1");
    const json = await listing.text();
    assert.ok(!json.includes("synthetic-password"));
    assert.ok(!json.includes("envelope"));
  } finally {
    f.close();
  }
});

test("WARDOGS malformed capacity fails instead of fabricating an observation", async () => {
  for (const players of [
    { current: 1, max: 0 },
    { current: -1, max: 60 },
    { current: 1.5, max: 60 },
    { current: 1 },
    { current: 1, max: "60" },
  ]) {
    const f = await setup();
    try {
      f.respond(async () => Response.json({ players }));
      assert.equal((await f.service.refreshServer("guild-1", f.server.id)).ok, false);
      const stored = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
      assert.equal(stored.lastFetchedAtMs, null);
      assert.equal(stored.lastPlayerCount, null);
    } finally {
      f.close();
    }
  }
});

test("A failing WARDOGS entry cannot abort Steam polling or turn cooldowns into outages", async () => {
  const f = await setup();
  try {
    const steam = await f.service.addServer({
      guildId: "guild-1",
      name: "Steam",
      provider: "steam-web",
      providerServerId: "steam",
      steamHost: "1.2.3.4",
    });
    assert.ok(steam.ok);
    f.clock.now += 600_000;
    f.respond(async () => new Response("", { status: 429, headers: { "Retry-After": "60" } }));
    await f.service.refreshAllServers();
    const servers = await f.service.listServers("guild-1");
    assert.equal(servers.find((server) => server.provider === "steam-web")!.lastQueueSize, 3);
    assert.equal(
      servers.find((server) => server.provider === "wardogs-rcon")!.consecutiveFailureCount,
      0,
    );
    assert.equal((await f.service.testServerReachability("guild-1", f.server.id)).ok, false);
  } finally {
    f.close();
  }
});

test("WARDOGS authentication failure stops further Player Count attempts until explicit target re-verification", async () => {
  const f = await setup();
  try {
    f.clock.now += 600_000;
    f.respond(async () => new Response("secret provider body", { status: 401 }));
    await f.service.refreshAllServers();
    f.clock.now += 600_000;
    await f.service.refreshAllServers();
    await f.service.testServerReachability("guild-1", f.server.id);
    assert.equal(f.calls.length, 1);
    assert.equal(
      (await f.stores.playerCount.readPlayerCountServer(f.server.id))!.consecutiveFailureCount,
      1,
    );
    assert.equal((await f.service.listServers("guild-1"))[0]!.readiness, "dormant");
  } finally {
    f.close();
  }
});

test("Re-verifying an operator origin replacement clears observations from the old endpoint", async () => {
  const f = await setup();
  try {
    await f.service.refreshServer("guild-1", f.server.id);
    f.clock.now += 5000;
    f.policy.origins = [{ ...f.policy.origins[0]!, origin: "https://replacement.example.com" }];
    f.policy.approvals = [{ ...f.policy.approvals[0]!, origin: "https://replacement.example.com" }];
    await f.wardogs.verify({
      guildId: "guild-1",
      targetId: f.target.id,
      generation: f.target.generation,
      roster: false,
    });
    const listed = (await f.service.listServers("guild-1"))[0]!;
    assert.equal(listed.lastFetchedAtMs, null);
    assert.equal(listed.lastPlayerCount, null);
    await f.service.renameDueChannels();
    assert.equal(f.renamed.length, 0);
  } finally {
    f.close();
  }
});

for (const replacement of [
  "credentials",
  "origin-away-and-back",
  "provider-away-and-back",
] as const) {
  test(`Review regression: held WARDOGS failures are discarded after ${replacement}`, async () => {
    const f = await setup();
    try {
      assert.ok((await f.service.refreshServer("guild-1", f.server.id)).ok);
      f.clock.now += 60_000;
      let finish!: (response: Response) => void;
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      f.respond(() => {
        began();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const pending = f.service.refreshServer("guild-1", f.server.id);
      await started;
      if (replacement === "provider-away-and-back") {
        const previous = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
        await f.stores.playerCount.upsertPlayerCountServer({ ...previous, provider: "steam-web" });
        await f.stores.playerCount.upsertPlayerCountServer(previous);
      } else {
        const changed = await f.wardogs.change({
          guildId: "guild-1",
          targetId: f.target.id,
          generation: f.target.generation,
          ...(replacement === "credentials"
            ? { secret: "replacement-synthetic" }
            : { originRef: null }),
        });
        if (replacement === "origin-away-and-back") {
          await f.wardogs.change({
            guildId: "guild-1",
            targetId: f.target.id,
            generation: changed.generation,
            originRef: "synthetic",
          });
        }
      }
      const before = await f.stores.playerCount.readPlayerCountServer(f.server.id);
      const targetBefore = await f.wardogs.list("guild-1");
      finish(new Response("private old response", { status: 500 }));
      assert.equal((await pending).ok, false);
      assert.deepEqual(await f.stores.playerCount.readPlayerCountServer(f.server.id), before);
      if (replacement !== "provider-away-and-back")
        assert.deepEqual(await f.wardogs.list("guild-1"), targetBefore);
      assert.equal(f.alerts.length, 0);
      assert.equal(f.reportedStreaks.size, 0);
      assert.equal(f.calls.length, 2);
    } finally {
      f.close();
    }
  });
}

for (const reconcile of ["list", "scheduled"] as const) {
  test(`Review regression: ${reconcile} clears failure-only history after target replacement`, async () => {
    const f = await setup();
    try {
      f.respond(async () => new Response("", { status: 500 }));
      await f.service.refreshServer("guild-1", f.server.id);
      const failed = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
      assert.equal(failed.lastFetchedAtMs, null);
      assert.equal(failed.consecutiveFailureCount, 1);
      assert.equal(f.reportedStreaks.size, 1);
      // Listing a current-source genuine error must not erase it.
      await f.service.listServers("guild-1");
      assert.deepEqual(await f.stores.playerCount.readPlayerCountServer(f.server.id), failed);
      f.clock.now += 1;
      await f.wardogs.change({
        guildId: "guild-1",
        targetId: f.target.id,
        generation: f.target.generation,
        secret: "replacement-synthetic",
      });
      if (reconcile === "list") await f.restart().listServers("guild-1");
      else await f.restart().refreshAllServers();
      const cleared = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
      assert.equal(cleared.consecutiveFailureCount, 0);
      assert.equal(cleared.lastErrorAtMs, null);
      assert.equal(cleared.lastErrorMessage, null);
      assert.equal(cleared.lastFetchedAtMs, null);
      assert.equal(f.reportedStreaks.size, 0);
      assert.equal(f.calls.length, 1);
      await f.service.renameDueChannels();
      assert.equal(f.renamed.length, 0);
      // Re-approval starts a new failure streak; it must survive listing and alert.
      f.clock.now += 60_000;
      const replacement = (await f.wardogs.list("guild-1"))[0]!;
      f.policy.approvals = [{ ...f.policy.approvals[0]!, generation: replacement.generation }];
      f.respond(async () => Response.json(synthetic.status));
      await f.wardogs.verify({
        guildId: "guild-1",
        targetId: f.target.id,
        generation: replacement.generation,
        roster: false,
      });
      f.clock.now += 5000;
      f.respond(async () => new Response("", { status: 500 }));
      await f.restart().refreshServer("guild-1", f.server.id);
      const currentFailure = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
      await f.service.listServers("guild-1");
      assert.deepEqual(
        await f.stores.playerCount.readPlayerCountServer(f.server.id),
        currentFailure,
      );
      assert.equal(currentFailure.consecutiveFailureCount, 1);
      assert.equal(f.alerts.length, 2);
    } finally {
      f.close();
    }
  });
}

test("Review regression: initial genuine failures rename an approved target offline at its threshold", async () => {
  const f = await setup();
  try {
    await f.stores.playerCount.upsertPlayerCountServer({ ...f.server, failureThreshold: 2 });
    await f.service.renameDueChannels();
    assert.equal(f.renamed.length, 0);
    f.respond(async () => new Response("", { status: 500 }));
    await f.service.refreshServer("guild-1", f.server.id);
    await f.service.renameDueChannels();
    assert.equal(f.renamed.length, 0);
    f.clock.now += 60_000;
    await f.service.refreshServer("guild-1", f.server.id);
    const failed = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(failed.lastFetchedAtMs, null);
    assert.equal(failed.consecutiveFailureCount, 2);
    assert.equal((await f.provider.readiness!(failed)).ready, true);
    await f.service.renameDueChannels();
    assert.deepEqual(f.renamed, [failed.offlineFormat]);
    assert.equal(f.alerts.length, 1);
    assert.equal(
      (await f.stores.playerCount.readPlayerCountServer(f.server.id))!.lastRenamedAtMs,
      f.clock.now,
    );
    f.clock.now += 600_000;
    const approvals = f.policy.approvals;
    f.policy.approvals = [];
    await f.service.renameDueChannels();
    assert.equal(f.renamed.length, 1);
    f.policy.approvals = approvals;
    f.respond(async () => Response.json(synthetic.status));
    await f.service.refreshAllServers();
    await f.service.renameDueChannels();
    assert.equal(
      f.renamed.at(-1),
      `🎮 Players: ${synthetic.status.players.current}/${synthetic.status.players.max}`,
    );
    assert.equal(f.reportedStreaks.size, 0);
  } finally {
    f.close();
  }
});

test("Review regression: one-minute polling limit covers tests, manual and scheduled polls across instances", async () => {
  const f = await setup();
  try {
    f.clock.now += 600_000; // A reachability test does not update the scheduled snapshot.
    const start = f.clock.now;
    assert.ok((await f.service.testServerReachability("guild-1", f.server.id)).ok);
    const second = f.restart();
    f.clock.now += 5000;
    assert.equal((await second.testServerReachability("guild-1", f.server.id)).ok, false);
    assert.equal((await second.refreshServer("guild-1", f.server.id)).ok, false);
    await second.refreshAllServers();
    assert.equal(f.calls.length, 1);
    const stored = (await f.stores.playerCount.readPlayerCountServer(f.server.id))!;
    assert.equal(stored.lastFetchedAtMs, null);
    assert.equal(stored.consecutiveFailureCount, 0);
    assert.equal(f.alerts.length, 0);
    f.clock.now = start + 59_999;
    assert.equal((await second.testServerReachability("guild-1", f.server.id)).ok, false);
    f.clock.now = start + 60_000;
    await second.refreshAllServers();
    assert.equal(f.calls.length, 2);
    assert.equal(
      (await f.stores.playerCount.readPlayerCountServer(f.server.id))!.lastFetchedAtMs,
      f.clock.now,
    );
    f.clock.now += 5000;
    assert.equal((await f.service.testServerReachability("guild-1", f.server.id)).ok, false);
    f.clock.now = start + 120_000;
    const results = await Promise.all([
      f.service.testServerReachability("guild-1", f.server.id),
      second.refreshServer("guild-1", f.server.id),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every((url) => url.endsWith("/v1/status")));
  } finally {
    f.close();
  }
});

test("Player Count minute budgets preserve setup verification, other reads and independent entries", async () => {
  const f = await setup();
  try {
    assert.ok((await f.service.testServerReachability("guild-1", f.server.id)).ok);
    const input = { guildId: "guild-1", targetId: f.target.id, generation: f.target.generation };
    f.clock.now += 5000;
    await f.wardogs.verify({ ...input, roster: false });
    assert.equal(f.calls.length, 3);
    f.clock.now += 5000;
    await f.wardogs.read({ ...input, operation: "capabilities" });
    assert.equal(f.calls.length, 4);
    const added = await f.service.addServer({
      guildId: "guild-1",
      name: "Second entry",
      provider: "wardogs-rcon",
      providerServerId: f.target.id,
    });
    assert.ok(added.ok);
    f.clock.now += 5000;
    assert.ok((await f.service.testServerReachability("guild-1", added.server.id)).ok);
    assert.equal((await f.restart().testServerReachability("guild-1", f.server.id)).ok, false);
    assert.equal(f.calls.length, 5);
    assert.ok(f.calls.every((url) => !url.endsWith("/v1/players")));
  } finally {
    f.close();
  }
});

test("Player Count minute budgets retain genuine failures and the longer shared origin cooldown", async () => {
  const f = await setup();
  try {
    f.respond(async () => new Response("", { status: 500 }));
    await f.service.refreshServer("guild-1", f.server.id);
    const failed = await f.stores.playerCount.readPlayerCountServer(f.server.id);
    f.clock.now += 5000;
    await f.restart().refreshServer("guild-1", f.server.id);
    assert.deepEqual(await f.stores.playerCount.readPlayerCountServer(f.server.id), failed);
    assert.equal(f.calls.length, 1);
    f.clock.now += 55_000;
    f.respond(async () => new Response("", { status: 429, headers: { "Retry-After": "180" } }));
    await f.service.refreshServer("guild-1", f.server.id);
    assert.equal(f.calls.length, 2);
    f.clock.now += 60_000;
    await f.restart().refreshServer("guild-1", f.server.id);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await f.stores.playerCount.readPlayerCountServer(f.server.id), failed);
    assert.equal(f.alerts.length, 1);
    f.clock.now += 120_000;
    f.respond(async () => Response.json(synthetic.status));
    assert.ok((await f.restart().refreshServer("guild-1", f.server.id)).ok);
    assert.equal(f.calls.length, 3);
    assert.equal(f.reportedStreaks.size, 0);
  } finally {
    f.close();
  }
});
