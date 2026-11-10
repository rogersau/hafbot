import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createCloudflareObservationStore } from "../src/runtime/attendance-observation-runtime";
import { createCloudflareWardogsStore } from "../src/runtime/cloudflare-wardogs-store";
import { WardogsService } from "../src/wardogs/service";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import type { NetworkPolicy } from "../src/wardogs/model";
import { AttendanceObservationService } from "../src/server-levels/observations/service";
import { createWardogsObservationProvider } from "../src/server-levels/observations/provider";
import { createPlatformLinkIdentityReader } from "../src/services/platform-link-identity-reader";
import { createAdminApiHandler } from "./helpers/admin-api";
import { createAttendanceObservationRuntime } from "../src/runtime/attendance-observation-runtime";
import { createRuntimeApp, type RuntimeAppOptions } from "../src/runtime/app";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";
import { processGatewayEventQueueMessages } from "../src/runtime/gateway-event-queue-consumer";
import { ObservationError, observationMemberKey } from "../src/server-levels/observations/model";
import { SafeDiagnosticError } from "../src/observability/safe-diagnostic-error";
import {
  __testing as reporterTesting,
  reportOperationalEvent,
} from "../src/observability/operational-reporter";
import { handleApplicationCommand } from "../src/runtime/application-command-handler";
import type { Env } from "../src/env";
import type { CustomerSession } from "../src/runtime/auth/customer-session";
const STEAM = "76561198000000001",
  MANUAL = "76561198000000002",
  UNLINKED = "76561198000000003";
async function fixture() {
  const f = createProductionRuntimeStores();
  let now = 1_800_000_000_000;
  const control = {
    eligible: true,
    member: true,
    status: "normal",
    roster: "normal",
    current: 3,
    max: 64,
    seconds: 100,
    map: "fixture-map",
    players: [STEAM, MANUAL, UNLINKED],
    afterStatus: async () => {},
  };
  const calls: { url: string; method: string; time: number }[] = [];
  const policy: NetworkPolicy = {
    enabled: true,
    origins: [
      {
        id: "fixture",
        origin: "https://wardogs.example",
        runtime: "cloudflare",
        securePathEvidence: "Synthetic fixture",
      },
    ],
    approvals: [],
  };
  const targetStore = createCloudflareWardogsStore(f.database.d1);
  const wardogs = new WardogsService({
    store: targetStore,
    runtime: "cloudflare",
    policy,
    keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    transport: async (url, init) => {
      calls.push({ url, method: init.method!, time: now });
      if (url.endsWith("capabilities"))
        return Response.json({ routes: ["GET /v1/status", "GET /v1/players"] });
      if (url.endsWith("status")) {
        await control.afterStatus();
        if (control.status === "outage") throw new Error("private raw credential details");
        if (control.status === "rate")
          return new Response("", { status: 429, headers: { "Retry-After": "180" } });
        return Response.json({
          players: { current: control.current, max: control.max },
          matchSeconds: control.seconds,
          map: control.map,
          queueSize: 99,
        });
      }
      if (control.roster === "partial")
        return Response.json({ players: [], nextPage: "private-cursor" });
      if (control.roster === "malformed") return Response.json({ players: [{ steamId: 17 }] });
      return Response.json({
        players: control.players.map((steamId) => ({
          steamId,
          name: "discard-name",
          kills: 999,
          cash: 999,
          pingMs: 10,
        })),
      });
    },
  });
  let target = await wardogs.create("guild", "Fixture", "fixture");
  target = await wardogs.change({
    guildId: "guild",
    targetId: target.id,
    generation: target.generation,
    enabled: true,
    secret: "private-password",
  });
  policy.approvals = [
    {
      targetId: target.id,
      generation: target.generation,
      originRef: "fixture",
      origin: policy.origins[0].origin,
      attendanceContract: { completeRoster: true, evidence: "Synthetic complete snapshot only" },
    },
  ];
  await wardogs.verify({
    guildId: "guild",
    targetId: target.id,
    generation: target.generation,
    roster: true,
  });
  now += 60000;
  calls.length = 0;
  const link = async (steamId = STEAM, manual = false, active = true) =>
    f.stores.platformLink.upsertPlatformLink({
      guildId: "guild",
      userId: "member",
      platform: "steam",
      platformId: steamId,
      manual,
      active,
      linkedAtMs: now,
      actionedByUserId: manual ? "admin" : null,
      metadataJson: null,
    });
  await link();
  await link(MANUAL, true);
  const store = createCloudflareObservationStore(f.database.d1);
  const service = new AttendanceObservationService({
    store,
    provider: createWardogsObservationProvider(wardogs),
    identities: createPlatformLinkIdentityReader(f.stores.platformLink),
    eligible: async () => control.eligible,
    owner: async (g, s) =>
      (await f.stores.platformLink.readPlatformLinkByPlatformId(g, "steam", s))?.userId ?? null,
    member: async () => control.member,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  const input = {
    guildId: "guild",
    targetId: target.id,
    generation: target.generation,
    actorId: "admin",
    durationHours: 1,
    configuredCapacity: 60,
    evidence: {
      sourceRevision: "cb899a1e4f5430d4e14f2e545877894b3cf50418",
      serverBuild: "synthetic",
      hostEvidence: "synthetic-fixture",
    },
    confirmation: "OBSERVATION_ONLY_NO_XP" as const,
  };
  const noEffects = () => {
    for (const table of [
      "server_level_earning_sessions",
      "server_level_awards",
      "server_level_member_totals",
      "server_level_daily_summaries",
      "server_level_announcement_outbox",
      "server_level_current_presence",
      "server_level_webhook_inbox",
      "server_level_ingress_outbox",
      "server_level_processing_cursors",
      "server_level_processing_leases",
      "commerce_game_fulfillments",
      "commerce_game_selections",
      "commerce_game_audit",
      "commerce_game_assignments",
      "commerce_role_assignments",
    ]) {
      assert.equal(
        f.database.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0].count,
        0,
        table,
      );
    }
    assert.ok(calls.every((c) => c.method === "GET"));
  };
  return {
    f,
    control,
    calls,
    policy,
    target,
    wardogs,
    store,
    service,
    input,
    link,
    noEffects,
    now: () => now,
    advance: (ms = 60000) => {
      now += ms;
    },
  };
}

test("authorized start/stop and durable polling retain only linked subjects, with no XP or access", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  await h.f.database.d1
    .prepare(
      "INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES('guild','premium','premium',1)",
    )
    .run();
  const handler = createAdminApiHandler({
    stores: h.f.stores,
    discordBotToken: "fake",
    attendanceObservations: { store: h.store, service: h.service },
    authorizeAttendanceObservationAdmin: async (_request, guildId) => guildId === "guild",
    readCustomerAdminSession: async () => ({ user: { discordUserId: "admin" } }) as CustomerSession,
    adminAccess: {
      authorize: async (request, requirement) =>
        request.headers.get("x-admin") === "yes" && requirement.guildId === "guild"
          ? { ok: true }
          : { ok: false, error: { _tag: "Forbidden", message: "Forbidden" } },
    },
  });
  const request = async (path: string, body?: object, allowed = true) => {
    const url = new URL(`https://example.com/admin/api/wardogs/observations${path}`);
    return handler(
      new Request(url, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "x-admin": allowed ? "yes" : "no" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      url,
    );
  };
  const { actorId: _actor, ...body } = h.input;
  assert.equal((await request("/start", body, false))?.status, 403);
  const created = await request("/start", body);
  assert.equal(created?.status, 200);
  const { id } = (await created!.json()) as { id: string };
  await h.service.processDue();
  const samples = await h.store.samples(id, h.now());
  assert.equal(samples.length, 1);
  const sample = samples[0];
  assert.equal(sample.status.population, 3);
  assert.equal(sample.roster.count, 3);
  assert.equal(sample.roster.completeness, "complete");
  assert.equal(sample.capacityMismatch, true);
  assert.deepEqual(sample.linkedSubjects, [
    {
      steamId: STEAM,
      assurance: "authenticated",
      memberKey: await observationMemberKey("guild", "member"),
    },
    {
      steamId: MANUAL,
      assurance: "administrative",
      memberKey: await observationMemberKey("guild", "member"),
    },
  ]);
  assert.equal(sample.queue.count, null);
  assert.equal(sample.continuity.sessionId, null);
  assert.ok(sample.roster.startedAtMs > sample.status.finishedAtMs);
  const report = JSON.stringify(await h.store.report(id));
  for (const value of [
    STEAM,
    MANUAL,
    UNLINKED,
    '"member"',
    '"admin"',
    "private-password",
    "discard-name",
  ])
    assert.ok(!report.includes(value), value);
  assert.ok(!JSON.stringify(samples).includes(UNLINKED));
  assert.ok(!JSON.stringify(samples).includes("discard-name"));
  assert.equal((await request("/stop", { guildId: "guild", id }))?.status, 200);
  h.advance();
  const before = h.calls.length;
  await h.service.processDue();
  assert.equal(h.calls.length, before);
});

test("duplicate scheduled slots are harmless and empty complete roster differs from unavailable", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  h.control.current = 0;
  h.control.players = [];
  await Promise.all([h.service.processDue(), h.service.processDue()]);
  assert.equal(h.calls.length, 2);
  assert.equal((await h.store.samples(run.id, h.now()))[0].roster.count, 0);
  await h.service.processDue();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.store.report(run.id))?.totals.duplicatesIgnored, 1);
  h.advance();
  h.control.status = "outage";
  await h.service.processDue();
  const last = (await h.store.samples(run.id, h.now())).at(-1)!;
  assert.equal(last.status.population, null);
  assert.equal(last.roster.count, 0);
});

for (const mode of ["partial", "malformed"])
  test(`${mode} roster never becomes empty attendance`, async (t) => {
    const h = await fixture();
    t.after(() => {
      h.noEffects();
      h.f.close();
    });
    const run = await h.service.start(h.input);
    h.control.roster = mode;
    await h.service.processDue();
    const sample = (await h.store.samples(run.id, h.now()))[0];
    assert.equal(sample.roster.count, null);
    assert.equal(sample.roster.completeness, "unknown");
    assert.deepEqual(sample.linkedSubjects, []);
    assert.equal((await h.store.report(run.id))?.totals.failed, 1);
  });

test("non-atomic disagreement and a match reset do not establish restart or continuity", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  await h.service.processDue();
  h.advance();
  h.control.seconds = 1;
  h.control.current = 4;
  await h.service.processDue();
  const second = (await h.store.samples(run.id, h.now()))[1];
  assert.equal(second.countDisagreement, true);
  assert.equal(second.possibleMatchBoundary, true);
  assert.equal(second.continuity.state, "unknown");
  assert.equal((await h.store.report(run.id))?.totals.apparentArrivals, 0);
  assert.equal((await h.store.report(run.id))?.totals.apparentDepartures, 0);
  // An unobservable leave/rejoin between identical samples cannot change this evidence.
  assert.equal((await h.store.report(run.id))?.decision, "NO_GO");
});

test("missed intervals are unknown and current unlink or Guild departure removes retained identity", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  await h.service.processDue();
  h.advance(180000);
  await h.link(STEAM, false, false);
  await h.service.processDue();
  let last = (await h.store.samples(run.id, h.now())).at(-1)!;
  assert.deepEqual(last.linkedSubjects, [
    {
      steamId: MANUAL,
      assurance: "administrative",
      memberKey: await observationMemberKey("guild", "member"),
    },
  ]);
  assert.ok((await h.store.report(run.id))!.totals.missingSlots >= 2);
  h.advance();
  h.control.member = false;
  await h.service.processDue();
  last = (await h.store.samples(run.id, h.now())).at(-1)!;
  assert.deepEqual(last.linkedSubjects, []);
});

test("stop, target-generation change, or entitlement loss fences an in-flight sample", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  h.control.afterStatus = async () => {
    await h.wardogs.change({
      guildId: "guild",
      targetId: h.target.id,
      generation: h.target.generation,
      disconnect: true,
    });
  };
  await h.service.processDue();
  assert.equal((await h.store.samples(run.id, h.now())).length, 0);
  assert.equal((await h.store.read(run.id))?.state, "stopped");
  assert.equal(h.calls.length, 1);
});

test("paid readiness, explicit opt-in, maximum duration and run expiry are enforced", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  h.control.eligible = false;
  await assert.rejects(h.service.start(h.input), /requires paid/);
  h.control.eligible = true;
  await assert.rejects(h.service.start({ ...h.input, durationHours: 25 }), /24 hours/);
  await assert.rejects(h.service.start({ ...h.input, durationHours: 1 / 7 }), /24 hours/);
  await assert.rejects(h.service.start({ ...h.input, confirmation: "wrong" as never }), /consent/);
  await assert.rejects(
    h.service.start({
      ...h.input,
      evidence: { ...h.input.evidence, sourceRevision: STEAM + "a".repeat(23) },
    }),
    /non-identifying/,
  );
  await assert.rejects(
    h.service.start({ ...h.input, evidence: { ...h.input.evidence, serverBuild: STEAM } }),
    /non-identifying/,
  );
  const run = await h.service.start(h.input);
  await assert.rejects(h.service.start(h.input), /already has/);
  h.advance(3600000);
  await h.service.processDue();
  assert.equal((await h.store.read(run.id))?.stopReason, "expired");
  assert.equal(h.calls.length, 0);
});

test("provider cooldown delays polling; stopping and losing paid eligibility send no further reads", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  h.control.status = "rate";
  await h.service.processDue();
  const count = h.calls.length;
  h.advance();
  await h.service.processDue();
  assert.equal(h.calls.length, count);
  h.advance(180000);
  h.control.status = "normal";
  h.control.eligible = false;
  await h.service.processDue();
  assert.equal((await h.store.read(run.id))?.state, "stopped");
  assert.equal(h.calls.length, count);
});

test("seven-day cleanup keeps only aggregate evidence and Guild erasure removes everything", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  await h.service.processDue();
  await h.service.stop("guild", run.id);
  h.advance(604800001);
  await h.store.cleanup(h.now());
  assert.equal(await h.store.read(run.id), null);
  assert.deepEqual(await h.store.samples(run.id, h.now()), []);
  const report = await h.store.report(run.id);
  assert.equal(report?.decision, "NO_GO");
  assert.ok(!JSON.stringify(report).includes(STEAM));
  await h.store.eraseGuild("guild");
  assert.equal(await h.store.report(run.id), null);
});

test("observation implementation has no earning, ledger, role, paid-access or notification dependency", () => {
  for (const file of readdirSync("src/server-levels/observations")) {
    const text = readFileSync(`src/server-levels/observations/${file}`, "utf8");
    assert.doesNotMatch(
      text,
      /from ["'][^"']*(processor|commerce|announcements|policy|ingress)["']/,
    );
    assert.doesNotMatch(
      text,
      /INSERT INTO (server_level_|commerce_)|createEarningSession|addGuildMemberRole|calculateServerXp/,
    );
  }
});

test("an expired worker claim cannot commit an out-of-order result", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  h.control.afterStatus = async () => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
  };
  const old = h.service.processDue();
  await started;
  h.advance(120000);
  await h.service.processDue();
  release();
  await old;
  const samples = await h.store.samples(run.id, h.now());
  assert.equal(samples.length, 1);
  assert.equal(samples[0].slot, Math.floor(h.now() / 60000));
  assert.equal((await h.store.report(run.id))?.totals.lateResultsDiscarded, 1);
});

test("an explicit stop during a request discards its observation", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  const run = await h.service.start(h.input);
  h.control.afterStatus = async () => {
    await h.service.stop("guild", run.id);
  };
  await h.service.processDue();
  assert.equal((await h.store.samples(run.id, h.now())).length, 0);
  assert.equal((await h.store.read(run.id))?.stopReason, "admin_stopped");
});

test("runtime readiness uses real paid and Steam configuration without DayZ or Player Count setup", async (t) => {
  const { createAttendanceObservationRuntime } =
    await import("../src/runtime/attendance-observation-runtime");
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    h.noEffects();
    h.f.close();
  });
  globalThis.fetch = async () => Response.json({ user: { id: "bot" }, roles: [] });
  const options = {
    store: h.store,
    wardogs: h.wardogs,
    stores: h.f.stores,
    enabled: true,
    steamEnabled: true,
    processingAvailable: true,
    botToken: "fake",
    botUserId: "bot",
  };
  const ready = () =>
    createAttendanceObservationRuntime(options).service.readiness("guild", h.target.id);
  assert.equal((await ready()).ready, false);
  await h.f.database.d1
    .prepare(
      "INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES('guild','premium','premium',1)",
    )
    .run();
  assert.equal((await ready()).ready, false);
  await h.f.stores.platformLink.upsertPlatformLinkConfig({
    guildId: "guild",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Steam",
    panelDescription: "Link",
    panelButtonLabel: "Steam",
    panelButtonStyle: "primary",
    allowRelink: true,
    allowMultipleLinks: true,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
  });
  assert.equal((await ready()).ready, true);
  assert.deepEqual(await h.f.stores.serverLevels!.listConfiguredGameServers("guild"), []);
  options.processingAvailable = false;
  assert.equal((await ready()).ready, false);
  options.processingAvailable = true;
  options.steamEnabled = false;
  assert.equal((await ready()).ready, false);
  options.steamEnabled = true;
  options.enabled = false;
  assert.equal((await ready()).ready, false);
});

test("valid rosters without a completeness contract stay unknown and the network switch stops reads", async (t) => {
  const h = await fixture();
  t.after(() => {
    h.noEffects();
    h.f.close();
  });
  delete h.policy.approvals[0].attendanceContract;
  const run = await h.service.start(h.input);
  await h.service.processDue();
  const samples = await h.store.samples(run.id, h.now());
  assert.equal(samples[0].roster.count, 3);
  assert.equal(samples[0].roster.completeness, "unknown");
  assert.deepEqual(samples[0].continuity, { state: "unknown", sessionId: null });
  const count = h.calls.length;
  h.policy.enabled = false;
  h.advance();
  await h.service.processDue();
  assert.equal(h.calls.length, count);
  assert.equal((await h.store.read(run.id))?.stopReason, "readiness_lost");
});

async function publicRuntime(
  h: Awaited<ReturnType<typeof fixture>>,
  t: import("node:test").TestContext,
  scheduledOptions: Pick<
    RuntimeAppOptions,
    "sweepBillingSyncOutbox" | "reportOperationalEvent"
  > = {},
) {
  await h.f.database.d1
    .prepare(
      "INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES('guild','premium','premium',1)",
    )
    .run();
  await h.f.stores.platformLink.upsertPlatformLinkConfig({
    guildId: "guild",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Steam",
    panelDescription: "Link",
    panelButtonLabel: "Steam",
    panelButtonStyle: "primary",
    allowRelink: true,
    allowMultipleLinks: true,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
  });
  await h.f.stores.guildRbac.upsertGuildAdminRoleId("guild", "observation-admin-role");
  const originalFetch = globalThis.fetch;
  const discordCalls: { url: string; method: string }[] = [];
  const authorization = { admin: true, signedIn: true };
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    discordCalls.push({ url, method });
    assert.equal(method, "GET", "attendance must never mutate Discord roles or send notifications");
    if (url.endsWith("/members/admin"))
      return Response.json({
        user: { id: "admin" },
        roles: authorization.admin ? ["observation-admin-role"] : [],
      });
    if (url.endsWith("/members/bot")) return Response.json({ user: { id: "bot" }, roles: [] });
    if (url.endsWith("/members/member"))
      return h.control.member
        ? Response.json({ user: { id: "member" }, roles: [] })
        : new Response(null, { status: 404 });
    if (url.endsWith("/roles")) return Response.json([{ id: "guild", permissions: "0" }]);
    if (url.endsWith("/guilds/guild"))
      return Response.json({ id: "guild", owner_id: "fixture-owner" });
    throw new Error("Unexpected Discord request in observation fixture");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    h.noEffects();
    h.f.close();
  });
  const makeObservation = () =>
    createAttendanceObservationRuntime({
      store: h.store,
      wardogs: h.wardogs,
      stores: h.f.stores,
      enabled: true,
      steamEnabled: true,
      processingAvailable: true,
      botToken: "fake",
      botUserId: "bot",
      now: h.now,
      wait: async (ms) => h.advance(ms),
    });
  const newWorker = () =>
    createRuntimeApp({
      stores: h.f.stores,
      discordPublicKey: "a".repeat(64),
      discordBotToken: "fake",
      discordBotUserId: "bot",
      gateway: { start: async () => {}, status: async () => {} },
      customerAuth: {
        handler: async () => new Response(null, { status: 404 }),
        api: {
          getSession: async () =>
            authorization.signedIn
              ? {
                  session: {},
                  user: { id: "customer", discordUserId: "admin", name: "Synthetic admin" },
                }
              : null,
        },
      } as never,
      guildResources: createPermissiveGuildResourceValidator(),
      attendanceObservations: makeObservation(),
      features: { ...ALL_FEATURES_ENABLED, playerCount: false },
      ...scheduledOptions,
    });
  const app = newWorker();
  const request = (path: string, body?: object) =>
    app.fetch(
      new Request(`https://example.com/admin/api/wardogs/observations${path}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const { actorId: _actor, ...body } = h.input;
  const start = async () => {
    const response = await request("/start", body);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as { id: string };
  };
  return { app, newWorker, request, start, body, authorization, discordCalls };
}

function captureObservationDiagnostics(t: import("node:test").TestContext) {
  const logs: unknown[] = [];
  const exceptions: unknown[] = [];
  const sentryMetadata: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  reporterTesting.setSentryClient({
    withScope: (callback) =>
      callback({
        setLevel: (level) => sentryMetadata.push(level),
        setTag: (key, value) => sentryMetadata.push({ [key]: value }),
        setContext: (key, value) => sentryMetadata.push({ [key]: value }),
      }),
    captureException: (error) => exceptions.push(error),
    captureMessage: (message) => sentryMetadata.push(message),
  });
  t.after(() => reporterTesting.resetSentryClient());
  const serialize = (value: unknown) =>
    JSON.stringify(value, (_key, child) =>
      child instanceof Error
        ? {
            name: child.name,
            message: child.message,
            stack: child.stack,
            cause: child.cause,
            ...(child instanceof AggregateError ? { errors: child.errors } : {}),
          }
        : child,
    );
  return { logs, exceptions, sentryMetadata, serialize };
}

for (const [boundary, stage] of [
  ["cleanup", "cleanup"],
  ["due_listing", "due_listing"],
  ["readiness", "readiness"],
  ["eligibility", "readiness"],
  ["claim", "claim"],
  ["expired_stop", "expired_stop"],
  ["readiness_stop", "readiness_stop"],
  ["sample_recovery_read", "sample_recovery_read"],
  ["sample_recovery_stop", "sample_recovery_stop"],
  ["sample_recovery_stop_read", "sample_recovery_stop"],
] as const)
  test(`public scheduled ${boundary} failure retains a safe diagnostic and isolates later tasks`, async (t) => {
    const h = await fixture();
    const diagnostics = captureObservationDiagnostics(t);
    const failures: unknown[] = [];
    const tasks: string[] = [];
    const runtime = await publicRuntime(h, t, {
      reportOperationalEvent: (event) => {
        failures.push(event.cause);
        tasks.push("attendance");
        reportOperationalEvent(event);
      },
      sweepBillingSyncOutbox: async () => {
        tasks.push("billing");
      },
    });
    await runtime.start();
    const upstreamError = new TypeError("untrusted-message-sentinel synthetic-credential", {
      cause: { payload: "untrusted-payload-sentinel synthetic-customer-id" },
    });
    upstreamError.name = "untrusted-name-sentinel";
    upstreamError.stack = "untrusted-stack-sentinel";
    const sampleFailure = new SyntaxError("untrusted-sample-sentinel synthetic-credential", {
      cause: "untrusted-sample-cause-sentinel",
    });
    sampleFailure.name = "untrusted-sample-name-sentinel";
    sampleFailure.stack = "untrusted-sample-stack-sentinel";
    const upstream =
      boundary === "due_listing"
        ? "untrusted-thrown-string synthetic-credential"
        : boundary === "eligibility"
          ? { payload: "untrusted-thrown-object synthetic-customer-id" }
          : upstreamError;
    const fail = async () => {
      throw upstream;
    };
    switch (boundary) {
      case "cleanup":
        t.mock.method(h.store, "cleanup", fail);
        break;
      case "due_listing":
        t.mock.method(h.store, "due", fail);
        break;
      case "readiness":
        t.mock.method(h.wardogs, "observationReadiness", fail);
        break;
      case "eligibility":
        t.mock.method(h.f.stores.guildEntitlements, "readGuildEntitlement", fail);
        break;
      case "claim":
        t.mock.method(h.store, "claim", fail);
        break;
      case "expired_stop":
        h.advance(3600000);
        t.mock.method(h.store, "stop", fail);
        break;
      case "readiness_stop":
        h.policy.enabled = false;
        t.mock.method(h.store, "stop", fail);
        break;
      case "sample_recovery_read":
      case "sample_recovery_stop_read": {
        const read = h.store.read;
        let firstRecoveryRead = true;
        t.mock.method(h.store, "finish", async () => {
          t.mock.method(h.store, "read", async (id: string) => {
            if (boundary === "sample_recovery_read" || !firstRecoveryRead) throw upstream;
            firstRecoveryRead = false;
            return read(id);
          });
          throw sampleFailure;
        });
        break;
      }
      case "sample_recovery_stop":
        t.mock.method(h.store, "finish", async () => {
          throw sampleFailure;
        });
        t.mock.method(h.store, "stop", fail);
        break;
    }

    await runtime.app.refreshPlayerCount();

    assert.deepEqual(tasks, ["attendance", "billing"]);
    assert.equal(failures.length, 1);
    const failure = failures[0];
    assert.ok(failure instanceof ObservationError);
    assert.equal(failure.message, "Attendance observation processing unavailable.");
    assert.ok(failure.cause instanceof SafeDiagnosticError);
    assert.equal(failure.cause.message, `Attendance observation ${stage} failed.`);
    if (boundary.startsWith("sample_recovery")) {
      const recoveryFailure = failure.cause.cause;
      assert.ok(recoveryFailure instanceof AggregateError);
      assert.equal(recoveryFailure.errors.length, 2);
      assert.ok(recoveryFailure.errors[0] instanceof SafeDiagnosticError);
      assert.equal(recoveryFailure.errors[0].message, "Attendance observation sample failed.");
      assert.equal(recoveryFailure.errors[0].cause, sampleFailure);
      assert.equal(recoveryFailure.errors[1], upstream);
    } else assert.equal(failure.cause.cause, upstream);
    assert.equal(diagnostics.logs.length, 1);
    assert.equal(diagnostics.exceptions.length, 1);
    for (const output of [diagnostics.logs, diagnostics.exceptions]) {
      const serialized = diagnostics.serialize(output);
      assert.ok(serialized.includes(`Attendance observation ${stage} failed.`));
      assert.match(serialized, /untrusted error details omitted|non-error cause omitted/);
      if (boundary.startsWith("sample_recovery")) {
        assert.match(serialized, /Attendance observation sample failed\./);
        assert.match(serialized, /SyntaxError/);
        assert.match(serialized, /TypeError/);
      }
    }
    assert.doesNotMatch(
      diagnostics.serialize(diagnostics),
      /untrusted-|synthetic-credential|synthetic-customer-id/,
    );
  });

for (const mode of ["success", "provider_failure", "sample_failure"] as const)
  test(`public scheduled ${mode} preserves observation behavior without failure diagnostics`, async (t) => {
    const h = await fixture();
    const diagnostics = captureObservationDiagnostics(t);
    let laterTasks = 0;
    const runtime = await publicRuntime(h, t, {
      sweepBillingSyncOutbox: async () => {
        laterTasks++;
      },
    });
    const { id } = await runtime.start();
    if (mode === "provider_failure") h.control.status = "outage";
    if (mode === "sample_failure")
      t.mock.method(h.store, "finish", async () => {
        throw new Error("untrusted-handled-sample-failure synthetic-credential");
      });

    await runtime.app.refreshPlayerCount();

    assert.equal(laterTasks, 1);
    assert.deepEqual(diagnostics.logs, []);
    assert.deepEqual(diagnostics.exceptions, []);
    assert.deepEqual(diagnostics.sentryMetadata, []);
    const run = await h.store.read(id);
    assert.ok(run);
    const samples = await h.store.samples(id, h.now());
    if (mode === "sample_failure") {
      assert.equal(run.state, "stopped");
      assert.equal(run.stopReason, "validation_unavailable");
      assert.deepEqual(samples, []);
    } else {
      assert.equal(run.state, "running");
      assert.equal(run.stopReason, null);
      assert.equal(samples.length, 1);
      assert.equal(run.totals.failed, mode === "provider_failure" ? 1 : 0);
      assert.equal(samples[0].status.population, mode === "provider_failure" ? null : 3);
    }
  });

for (const mode of ["normal", "empty", "partial", "malformed", "outage", "rate"] as const)
  test(`public runtime ${mode} observation and replay have no progression, reward or access effects`, async (t) => {
    const h = await fixture();
    const runtime = await publicRuntime(h, t);
    if (mode === "empty") {
      h.control.players = [];
      h.control.current = 0;
    }
    if (["partial", "malformed"].includes(mode)) h.control.roster = mode;
    if (["outage", "rate"].includes(mode)) h.control.status = mode;
    const { id } = await runtime.start();
    await runtime.app.refreshPlayerCount();
    await runtime.app.refreshPlayerCount();
    const samples = await h.store.samples(id, h.now());
    assert.equal(samples.length, 1);
    assert.equal(samples[0].queue.state, "unknown");
    assert.equal(samples[0].continuity.state, "unknown");
    if (["partial", "malformed"].includes(mode)) {
      assert.equal(samples[0].roster.count, null);
      assert.equal(samples[0].roster.completeness, "unknown");
    }
    if (mode === "empty") assert.equal(samples[0].roster.count, 0);
    const details = await runtime.request("?guildId=guild");
    assert.equal(details.status, 200);
    const report = await details.text();
    for (const privateValue of [
      STEAM,
      MANUAL,
      UNLINKED,
      "private-password",
      "discard-name",
      '"actorId"',
    ])
      assert.ok(!report.includes(privateValue));
    assert.match(report, /Observation only — no XP/);
    assert.equal((await runtime.request("/stop", { guildId: "guild", id })).status, 200);
    h.advance();
    const calls = h.calls.length;
    await runtime.app.refreshPlayerCount();
    assert.equal(h.calls.length, calls);
    h.noEffects();
  });

test("public runtime uses current Guild Admin authorization for readiness, start, stop and private reports", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  assert.equal(
    (await runtime.request(`/readiness?guildId=guild&targetId=${h.target.id}`)).status,
    200,
  );
  runtime.authorization.admin = false;
  assert.equal((await runtime.request("/start", runtime.body)).status, 403);
  assert.equal((await runtime.request("?guildId=guild")).status, 403);
  assert.equal((await h.store.list("guild")).length, 0);
  runtime.authorization.admin = true;
  const { id } = await runtime.start();
  assert.equal((await runtime.request("/stop", { guildId: "another-guild", id })).status, 403);
  runtime.authorization.admin = false;
  assert.equal((await runtime.request("/stop", { guildId: "guild", id })).status, 403);
  assert.equal((await h.store.read(id))?.state, "running");
  runtime.authorization.admin = true;
  await h.f.database.d1
    .prepare("UPDATE guild_entitlements SET tier='free',plan='free' WHERE guild_id='guild'")
    .run();
  assert.equal(
    (await runtime.request("/stop", { guildId: "guild", id })).status,
    200,
    "stop remains available after paid entitlement loss",
  );
  runtime.authorization.signedIn = false;
  assert.equal((await runtime.request("?guildId=guild")).status, 401);
  h.noEffects();
});

test("public scheduled recovery, expiry and private retention never backfill or award XP", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  const { id } = await runtime.start();
  await runtime.app.refreshPlayerCount();
  h.advance(180000);
  h.control.status = "outage";
  await runtime.app.refreshPlayerCount();
  h.advance();
  h.control.status = "normal";
  await runtime.app.refreshPlayerCount();
  const samples = await h.store.samples(id, h.now());
  assert.equal(samples.length, 3);
  assert.equal(samples[1].status.population, null);
  assert.ok((await h.store.report(id))!.totals.missingSlots >= 2);
  assert.ok(samples.every((sample) => sample.continuity.state === "unknown"));
  h.advance(3600000);
  await runtime.app.refreshPlayerCount();
  assert.equal((await h.store.read(id))?.stopReason, "expired");
  h.advance(604800001);
  await runtime.app.refreshPlayerCount();
  assert.equal(await h.store.read(id), null);
  assert.deepEqual(await h.store.samples(id, h.now()), []);
  const reports = await runtime.request("?guildId=guild");
  assert.equal(reports.status, 200);
  assert.ok(!(await reports.text()).includes(STEAM));
  h.noEffects();
});

test("public Gateway uninstall delivery erases observations, unavailable events preserve them, replay is harmless", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  const { id } = await runtime.start();
  await runtime.app.refreshPlayerCount();
  const env = {
    HAF_DB: h.f.database.d1,
    BOT_USER_ID: "bot",
    DISCORD_BOT_TOKEN: "fake",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    STAGING_MODE: "true",
  } as Env;
  const logger = {
    error: (...args: unknown[]) => assert.fail(JSON.stringify(args)),
    info: () => {},
  };
  const event = { type: "GUILD_DELETE", data: { id: "guild" } };
  await processGatewayEventQueueMessages(
    [{ ...event, data: { id: "guild", unavailable: true } }],
    env,
    logger,
  );
  assert.equal((await h.store.read(id))?.state, "running");
  await processGatewayEventQueueMessages([event, event], env, logger);
  assert.equal(await h.store.read(id), null);
  assert.deepEqual(await h.store.samples(id, h.now()), []);
  assert.equal(await h.store.report(id), null);
  const calls = h.calls.length;
  await runtime.app.refreshPlayerCount();
  assert.equal(h.calls.length, calls);
  h.noEffects();
});

for (const boundary of ["stop", "generation", "paid"] as const)
  test(`public scheduled ${boundary} boundary fences an in-flight response without any earning effects`, async (t) => {
    const h = await fixture();
    const runtime = await publicRuntime(h, t);
    const { id } = await runtime.start();
    h.control.afterStatus = async () => {
      if (boundary === "stop")
        assert.equal((await runtime.request("/stop", { guildId: "guild", id })).status, 200);
      if (boundary === "generation")
        await h.wardogs.change({
          guildId: "guild",
          targetId: h.target.id,
          generation: h.target.generation,
          disconnect: true,
        });
      if (boundary === "paid")
        await h.f.database.d1
          .prepare("UPDATE guild_entitlements SET tier='free',plan='free' WHERE guild_id='guild'")
          .run();
    };
    await runtime.app.refreshPlayerCount();
    assert.equal((await h.store.samples(id, h.now())).length, 0);
    assert.equal((await h.store.read(id))?.state, "stopped");
    assert.equal(h.calls.length, 1);
    h.noEffects();
  });

test("public worker restart rejects late old results using durable claims and reports unknown continuity", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  const { id } = await runtime.start();
  let entered!: () => void, resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  h.control.afterStatus = async () => {
    if (first) {
      first = false;
      entered();
      await released;
    }
  };
  const old = runtime.app.refreshPlayerCount();
  await paused;
  try {
    h.advance(120000);
    await runtime.newWorker().refreshPlayerCount();
  } finally {
    resume();
  }
  await old;
  const samples = await h.store.samples(id, h.now());
  assert.equal(samples.length, 1);
  assert.equal(samples[0].continuity.state, "unknown");
  assert.equal((await h.store.report(id))?.totals.lateResultsDiscarded, 1);
  h.noEffects();
});

test("public delayed current membership preserves actual read cadence across concurrent run restarts", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  h.advance((50000 - (h.now() % 60000) + 60000) % 60000);
  const first = await runtime.start();
  const admittedAt = h.now();
  const discord = globalThis.fetch;
  let delayed = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!delayed && url.endsWith("/members/bot") && (await h.store.read(first.id))?.lease) {
      delayed = true;
      h.advance(20000);
    }
    return discord(input, init);
  };
  await runtime.app.refreshPlayerCount();
  assert.equal(delayed, true);
  const firstStart = h.calls[0].time;
  assert.equal(firstStart, admittedAt + 20000);
  assert.equal((await h.store.samples(first.id, h.now()))[0].status.startedAtMs, firstStart);
  assert.equal((await runtime.request("/stop", { guildId: "guild", id: first.id })).status, 200);
  h.advance(admittedAt + 60000 - h.now());
  const second = await runtime.start();
  await Promise.all([
    runtime.newWorker().refreshPlayerCount(),
    runtime.newWorker().refreshPlayerCount(),
  ]);
  t.diagnostic(JSON.stringify({ admittedAt, actualReads: h.calls }));
  assert.equal(
    h.calls.length,
    2,
    "admission cadence must not allow reads only forty seconds apart",
  );
  assert.deepEqual(await h.store.samples(second.id, h.now()), []);
  h.advance(firstStart + 59999 - h.now());
  await runtime.newWorker().refreshPlayerCount();
  assert.equal(h.calls.length, 2);
  h.advance(1);
  await Promise.all([
    runtime.newWorker().refreshPlayerCount(),
    runtime.newWorker().refreshPlayerCount(),
  ]);
  assert.deepEqual(
    h.calls.filter((call) => call.url.endsWith("/status")).map((call) => call.time),
    [firstStart, firstStart + 60000],
  );
  assert.equal((await h.store.samples(second.id, h.now())).length, 1);
  t.diagnostic(JSON.stringify({ actualReads: h.calls }));
  h.noEffects();
});

test("public abandoned delayed read retains cadence after stop without a completed sample", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  h.advance((50000 - (h.now() % 60000) + 60000) % 60000);
  const first = await runtime.start();
  const admittedAt = h.now();
  const discord = globalThis.fetch;
  let delayed = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!delayed && url.endsWith("/members/bot") && (await h.store.read(first.id))?.lease) {
      delayed = true;
      h.advance(20000);
    }
    return discord(input, init);
  };
  h.control.afterStatus = async () => {
    assert.equal((await runtime.request("/stop", { guildId: "guild", id: first.id })).status, 200);
  };
  await runtime.app.refreshPlayerCount();
  h.control.afterStatus = async () => {};
  const firstStart = admittedAt + 20000;
  assert.deepEqual(
    h.calls.map((call) => call.time),
    [firstStart],
  );
  assert.deepEqual(await h.store.samples(first.id, h.now()), []);
  assert.equal((await h.store.report(first.id))?.totals.samples, 0);
  h.advance(admittedAt + 60000 - h.now());
  const second = await runtime.start();
  await runtime.newWorker().refreshPlayerCount();
  assert.equal(h.calls.length, 1, "an abandoned read still constrains an explicit restart");
  h.advance(firstStart + 59999 - h.now());
  await runtime.newWorker().refreshPlayerCount();
  assert.equal(h.calls.length, 1);
  h.advance(1);
  await Promise.all([
    runtime.newWorker().refreshPlayerCount(),
    runtime.newWorker().refreshPlayerCount(),
  ]);
  assert.deepEqual(
    h.calls.filter((call) => call.url.endsWith("/status")).map((call) => call.time),
    [firstStart, firstStart + 60000],
  );
  assert.equal((await h.store.samples(second.id, h.now())).length, 1);
  t.diagnostic(JSON.stringify({ abandonedRun: first.id, actualReads: h.calls }));
  h.noEffects();
});

for (const guardDelay of [500, 1001])
  test(`public durable read guard delayed ${guardDelay}ms preserves cadence or refuses dispatch`, async (t) => {
    const h = await fixture();
    const runtime = await publicRuntime(h, t);
    h.advance((50000 - (h.now() % 60000) + 60000) % 60000);
    const first = await runtime.start();
    const admittedAt = h.now();
    const database = h.f.database.d1;
    const batch = database.batch.bind(database);
    let delayed = false;
    database.batch = async <T>(statements: D1PreparedStatement[]) => {
      const results = await batch<T>(statements);
      const rows = h.f.database.query<{ next_allowed_at_ms: number }>(
        "SELECT next_allowed_at_ms FROM attendance_observation_samples WHERE run_id=?",
        first.id,
      );
      if (!delayed && rows[0]?.next_allowed_at_ms === admittedAt + 61000) {
        delayed = true;
        h.advance(guardDelay);
      }
      return results;
    };
    await runtime.app.refreshPlayerCount();
    assert.equal(delayed, true);
    const sample = (await h.store.samples(first.id, h.now()))[0];
    assert.ok(sample);
    if (guardDelay === 500) {
      assert.deepEqual(
        h.calls.map((call) => call.time),
        [admittedAt + 500, admittedAt + 5500],
      );
      assert.equal(sample.status.startedAtMs, h.calls[0].time);
    } else {
      assert.deepEqual(h.calls, [], "a guard response after the send deadline must send no reads");
      assert.equal(sample.status.error, "timeout");
      assert.equal(sample.roster.count, null);
    }
    assert.equal((await runtime.request("/stop", { guildId: "guild", id: first.id })).status, 200);
    const second = await runtime.start();
    const allowedAt = admittedAt + (guardDelay === 500 ? 60500 : 61000);
    const callsBefore = h.calls.length;
    h.advance(allowedAt - 1 - h.now());
    await runtime.newWorker().refreshPlayerCount();
    assert.equal(h.calls.length, callsBefore);
    h.advance(1);
    await Promise.all([
      runtime.newWorker().refreshPlayerCount(),
      runtime.newWorker().refreshPlayerCount(),
    ]);
    assert.equal(h.calls.at(-2)?.time, allowedAt);
    assert.equal((await h.store.samples(second.id, h.now())).length, 1);
    t.diagnostic(JSON.stringify({ guardDelay, allowedAt, actualReads: h.calls }));
    h.noEffects();
  });

for (const boundary of ["stop", "lease", "generation"] as const)
  test(`public ${boundary} change during the last membership check prevents stale read dispatch`, async (t) => {
    const h = await fixture();
    const runtime = await publicRuntime(h, t);
    const first = await runtime.start();
    const discord = globalThis.fetch;
    let checks = 0;
    let changed = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!changed && url.endsWith("/members/bot") && (await h.store.read(first.id))?.lease) {
        checks++;
        if (checks === 2) {
          changed = true;
          if (boundary === "stop")
            assert.equal(
              (await runtime.request("/stop", { guildId: "guild", id: first.id })).status,
              200,
            );
          if (boundary === "lease") {
            h.advance(120000);
            await runtime.newWorker().refreshPlayerCount();
          }
          if (boundary === "generation")
            await h.wardogs.change({
              guildId: "guild",
              targetId: h.target.id,
              generation: h.target.generation,
              name: "Changed before dispatch",
            });
        }
      }
      return discord(input, init);
    };
    await runtime.app.refreshPlayerCount();
    assert.equal(changed, true);
    assert.equal(h.calls.length, boundary === "lease" ? 2 : 0);
    const samples = await h.store.samples(first.id, h.now());
    assert.equal(samples.length, boundary === "lease" ? 1 : 0);
    if (boundary === "lease") {
      assert.equal(samples[0].status.startedAtMs, h.calls[0].time);
      assert.equal((await h.store.report(first.id))?.totals.lateResultsDiscarded, 1);
    }
    h.noEffects();
  });

test("public stop and restart across a minute boundary preserves the 60-second sample cadence", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  h.advance((50000 - (h.now() % 60000) + 60000) % 60000);
  const first = await runtime.start();
  await runtime.app.refreshPlayerCount();
  const firstStart = h.calls[0].time;
  const stale = (await h.store.read(first.id))!;
  assert.equal((await runtime.request("/stop", { guildId: "guild", id: first.id })).status, 200);
  h.advance(60000 - (h.now() % 60000));
  const second = await runtime.start();
  await Promise.all([
    runtime.newWorker().refreshPlayerCount(),
    runtime.newWorker().refreshPlayerCount(),
  ]);
  assert.equal(h.calls.length, 2, "restart ten seconds later must send no additional reads");
  assert.deepEqual(await h.store.samples(second.id, h.now()), []);
  assert.equal(await h.store.claim(stale, h.now()), null, "a stopped run cannot reclaim");
  h.advance(firstStart + 59999 - h.now());
  await runtime.newWorker().refreshPlayerCount();
  assert.equal(h.calls.length, 2);
  h.advance(1);
  await Promise.all([
    runtime.newWorker().refreshPlayerCount(),
    runtime.newWorker().refreshPlayerCount(),
  ]);
  assert.deepEqual(
    h.calls.filter((call) => call.url.endsWith("/status")).map((call) => call.time),
    [firstStart, firstStart + 60000],
  );
  assert.equal((await h.store.samples(second.id, h.now())).length, 1);
  h.noEffects();
});

test("public explicit run restart in the same target generation cannot duplicate a scheduled slot", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  const first = await runtime.start();
  await runtime.app.refreshPlayerCount();
  assert.equal((await runtime.request("/stop", { guildId: "guild", id: first.id })).status, 200);
  const second = await runtime.start();
  const calls = h.calls.length;
  await runtime.newWorker().refreshPlayerCount();
  assert.equal(h.calls.length, calls);
  assert.equal((await h.store.samples(second.id, h.now())).length, 0);
  assert.equal((await h.store.report(second.id))?.totals.duplicatesIgnored, 1);
  h.advance(90000);
  await runtime.newWorker().refreshPlayerCount();
  assert.equal((await h.store.samples(second.id, h.now())).length, 1);
  assert.equal((await h.store.report(second.id))?.decision, "NO_GO");
  h.noEffects();
});

test("restricted personal erasure preserves cadence and the durable slot across an explicit restart", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  const first = await runtime.start();
  await runtime.app.refreshPlayerCount();
  const sample = (await h.store.samples(first.id, h.now()))[0];
  await h.f.stores.platformLink.deletePlatformLink("guild", "member", "steam", STEAM);
  await h.f.stores.platformLink.deletePlatformLink("guild", "member", "steam", MANUAL);
  const response = await handleApplicationCommand(
    {
      id: "synthetic-slot-erasure",
      type: 2,
      guild_id: "haf-admin-guild",
      member: { user: { id: "support" }, roles: ["support-role"] },
      data: {
        name: "haf-admin",
        options: [
          {
            type: 1,
            name: "erase-server-level-data",
            options: [
              { type: 3, name: "guild_id", value: "guild" },
              { type: 3, name: "user_id", value: "member" },
              { type: 3, name: "reason", value: "Synthetic privacy request" },
            ],
          },
        ],
      },
    },
    h.f.stores,
    "fake",
    ALL_FEATURES_ENABLED,
    {
      hafAdminGuildId: "haf-admin-guild",
      hafAdminRoleId: "support-role",
      eraseAttendanceObservationMember: (guildId, userId) => h.service.eraseMember(guildId, userId),
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await h.store.read(first.id))?.stopReason, "personal_erasure");
  assert.deepEqual(await h.store.samples(first.id, h.now()), []);
  await h.service.eraseMember("guild", "admin");
  h.advance(5000);
  const second = await runtime.start();
  await Promise.all([
    runtime.newWorker().refreshPlayerCount(),
    runtime.newWorker().refreshPlayerCount(),
  ]);
  assert.equal(h.calls.length, 2, "erasure must not reopen the same generation/slot");
  const rows = h.f.database.query<{ data: string }>(
    "SELECT data FROM attendance_observation_samples WHERE run_id=?",
    first.id,
  );
  assert.deepEqual(rows, [{ data: "{}" }], "erase the entire private payload, retain its claim");
  const retained = JSON.stringify({
    rows,
    run: await h.store.read(first.id),
    report: await h.store.report(first.id),
  });
  for (const value of [STEAM, MANUAL, await observationMemberKey("guild", "member"), '"admin"'])
    assert.ok(!retained.includes(value), value);
  assert.equal((await h.store.report(first.id))?.totals.samples, 1);
  h.advance(sample.status.startedAtMs + 60000 - h.now());
  await runtime.newWorker().refreshPlayerCount();
  const next = (await h.store.samples(second.id, h.now()))[0];
  assert.equal(next.status.startedAtMs - sample.status.startedAtMs, 60000);
  assert.ok(next.slot > sample.slot);
  assert.deepEqual(next.linkedSubjects, []);
  assert.equal(next.roster.count, 3, "unlinked occupancy remains a count only");
  await h.service.stop("guild", second.id);
  h.advance(604800001);
  await h.store.cleanup(h.now());
  assert.deepEqual(h.f.database.query("SELECT id FROM attendance_observation_samples"), []);
  assert.equal(await h.store.read(first.id), null);
  assert.equal((await h.store.report(first.id))?.totals.samples, 1);
  await h.store.eraseGuild("guild");
  assert.deepEqual(await h.store.reports("guild"), []);
  h.noEffects();
});

test("restricted support erasure removes observation identity after unlink and fences late reads without rewards", async (t) => {
  const h = await fixture();
  const runtime = await publicRuntime(h, t);
  const { id } = await runtime.start();
  await runtime.app.refreshPlayerCount();
  await h.f.stores.platformLink.deletePlatformLink("guild", "member", "steam", STEAM);
  await h.f.stores.platformLink.deletePlatformLink("guild", "member", "steam", MANUAL);
  h.advance();
  let entered!: () => void, resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  h.control.afterStatus = async () => {
    entered();
    await released;
  };
  const inFlight = runtime.app.refreshPlayerCount();
  await paused;
  const interaction = {
    id: "synthetic-erasure",
    type: 2,
    guild_id: "haf-admin-guild",
    member: { user: { id: "support" }, roles: ["support-role"] },
    data: {
      name: "haf-admin",
      options: [
        {
          type: 1,
          name: "erase-server-level-data",
          options: [
            { type: 3, name: "guild_id", value: "guild" },
            { type: 3, name: "user_id", value: "member" },
            { type: 3, name: "reason", value: "Synthetic privacy request" },
          ],
        },
      ],
    },
  };
  try {
    const response = await handleApplicationCommand(
      interaction,
      h.f.stores,
      "fake",
      ALL_FEATURES_ENABLED,
      {
        hafAdminGuildId: "haf-admin-guild",
        hafAdminRoleId: "support-role",
        eraseAttendanceObservationMember: (guildId, userId) =>
          h.service.eraseMember(guildId, userId),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await h.store.samples(id, h.now()), []);
    assert.equal((await h.store.read(id))?.stopReason, "personal_erasure");
    await h.service.eraseMember("guild", "admin");
    assert.equal((await h.store.read(id))?.actorId, null);
  } finally {
    resume();
  }
  await inFlight;
  assert.deepEqual(await h.store.samples(id, h.now()), []);
  const report = JSON.stringify(await h.store.report(id));
  assert.ok(!report.includes(await observationMemberKey("guild", "member")));
  assert.ok(!report.includes(STEAM));
  assert.match(report, /NO_GO/);
  h.noEffects();
});
