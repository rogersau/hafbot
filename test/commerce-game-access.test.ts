import assert from "node:assert/strict";
import test from "node:test";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createCloudflareGameAccessStore } from "../src/runtime/commerce/game-access-runtime";
import {
  CommerceGameAccessService,
  type GameAccessTruth,
} from "../src/commerce/game-access/service";
import { decodeReservedSlots, type GameAccessProvider } from "../src/commerce/game-access/provider";
import { createPlatformLinkIdentityReader } from "../src/services/platform-link-identity-reader";
import type { PaidRoleEntitlementState } from "../src/commerce/paid-role-entitlement";
const SUBJECT = "76561198000000001";
const SECOND = "76561198000000002";
function paid(overrides: Partial<PaidRoleEntitlementState> = {}): PaidRoleEntitlementState {
  return {
    entitlementId: "entitlement",
    connectedAccountId: "account",
    guildId: "guild",
    discordUserId: "buyer",
    discordRoleId: "role",
    subscriptionId: "subscription",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: 9e12,
    paymentStatus: "succeeded",
    amountMinor: 1000,
    amountRefundedMinor: 0,
    disputeStatus: null,
    failedPaymentAtMs: null,
    adminAction: null,
    memberState: "present",
    updatedAtMs: 0,
    ...overrides,
  };
}
async function setup() {
  const fixture = createProductionRuntimeStores();
  const store = createCloudflareGameAccessStore(fixture.database.d1);
  let now = 1e9;
  const control = {
    ready: true,
    sales: true,
    mode: "normal",
    capacity: 4,
    beforeMutation: async () => {},
  };
  const truth: GameAccessTruth = {
    entitlements: [],
    grantsAllowed: true,
    unpaidAllocationsTerminal: false,
  };
  const reservations = new Set<string>();
  const requests: string[] = [];
  const provider: GameAccessProvider = {
    async readiness(guildId, targetId) {
      return {
        guildId,
        targetId,
        ready: control.ready,
        generation: 1,
        physicalTarget: "physical",
        origin: "https://fixture.example",
        capacity: control.capacity,
      };
    },
    async capabilities() {
      return true;
    },
    async list() {
      requests.push("GET");
      if (
        control.mode === "outage" ||
        (control.mode === "readback-outage" && reservations.has(SUBJECT))
      )
        throw new Error("private provider details");
      return new Set(reservations);
    },
    async mutate(_target, subject, action, beforeSend) {
      await control.beforeMutation();
      if (control.mode === "before-send-failure") throw new Error("unavailable");
      await beforeSend();
      requests.push(`${action}:${subject}`);
      if (control.mode !== "lost-late") {
        if (action === "grant") reservations.add(subject);
        else reservations.delete(subject);
      }
      if (control.mode.startsWith("lost")) throw new Error("private credential provider error");
    },
  };
  const service = new CommerceGameAccessService({
    store,
    provider,
    identities: createPlatformLinkIdentityReader(fixture.stores.platformLink),
    truth: async () => truth,
    salesAllowed: async () => control.sales,
    offering: async () => ({ guildId: "guild", recurring: true, purchased: false }),
    audit: async (event) => {
      await fixture.database.d1
        .prepare("INSERT INTO commerce_game_audit(id,guild_id,created_at_ms,data) VALUES(?,?,?,?)")
        .bind(crypto.randomUUID(), event.guildId, now, JSON.stringify(event))
        .run();
    },
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  const link = async (
    subject = SUBJECT,
    userId = "buyer",
    guildId = "guild",
    manual = false,
    active = true,
  ) =>
    fixture.stores.platformLink.upsertPlatformLink({
      guildId,
      userId,
      platform: "steam",
      platformId: subject,
      linkedAtMs: now,
      manual,
      active,
      actionedByUserId: null,
      metadataJson: null,
    });
  await link();
  await service.configure({
    guildId: "guild",
    offeringId: "offering",
    targetId: "target",
    allocationCeiling: 2,
    acceptingSales: true,
    actorId: "seller",
  });
  const checkout = (overrides: Partial<Parameters<typeof service.checkout>[0]> = {}) =>
    service.checkout({
      guildId: "guild",
      offeringId: "offering",
      buyerId: "buyer-row",
      userId: "buyer",
      checkoutId: "checkout",
      ...overrides,
    });
  const cycle = async () => {
    now += 900_000;
    await service.processDue();
  };
  const assignment = async () => (await store.list())[0]!;
  return {
    fixture,
    store,
    control,
    truth,
    reservations,
    requests,
    service,
    link,
    checkout,
    cycle,
    assignment,
  };
}

test("authenticated exact Steam selection: zero/one/many and checkout tampering", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.link(SUBJECT, "buyer", "guild", true);
  await assert.rejects(h.checkout(), /Link and authenticate/);
  await h.link();
  await h.link(SECOND);
  await assert.rejects(h.checkout(), /Choose/);
  await h.checkout({ subject: SUBJECT });
  await assert.rejects(h.checkout({ subject: SECOND }), /substituted/);
  assert.equal((await h.assignment()).subject, SUBJECT);
  await h.link(SUBJECT, "buyer", "guild", false, false);
  await assert.rejects(h.checkout({ subject: SUBJECT }), /Choose/);
});

test("cross-Guild/member links cannot authorize selection or alias ownership", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await assert.rejects(h.checkout({ userId: "other" }), /Link and authenticate/);
  await h.checkout();
  await h.fixture.stores.platformLink.deletePlatformLink("guild", "buyer", "steam", SUBJECT);
  await h.link(SUBJECT, "other");
  await assert.rejects(
    h.checkout({ userId: "other", buyerId: "other-row", checkoutId: "other" }),
    /conflicting owner/,
  );
});

test("concurrent checkouts enforce finite capacity atomically including external entries", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.link(SECOND, "second");
  await h.link("76561198000000003", "third");
  const results = await Promise.allSettled([
    h.checkout(),
    h.checkout({ userId: "second", buyerId: "second", checkoutId: "second" }),
    h.checkout({ userId: "third", buyerId: "third", checkoutId: "third" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal((await h.store.list()).filter((a) => a.slot !== null).length, 2);
  h.reservations.add("76561198000000004");
  h.reservations.add("76561198000000005");
  h.reservations.add("76561198000000006");
  await assert.rejects(h.checkout({ checkoutId: "late" }), /capacity/);
});

test("two entitlements retain one managed entry until the last eligible source ends", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid(), paid({ entitlementId: "second" })];
  h.truth.unpaidAllocationsTerminal = true;
  await h.cycle();
  assert.equal((await h.assignment()).state, "managed");
  h.truth.entitlements[0].adminAction = "revoke";
  await h.cycle();
  assert.ok(h.reservations.has(SUBJECT));
  h.truth.entitlements[1].adminAction = "revoke";
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
  assert.equal((await h.assignment()).obligation, false);
  assert.deepEqual(
    h.requests.filter((r) => r !== "GET"),
    [`grant:${SUBJECT}`, `remove:${SUBJECT}`],
  );
});

test("pre-existing reservation is never adopted or removed", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  h.reservations.add(SUBJECT);
  await h.checkout();
  h.truth.entitlements = [paid()];
  await h.cycle();
  assert.equal((await h.assignment()).state, "externally-managed");
  h.truth.entitlements = [paid({ adminAction: "revoke" })];
  await h.cycle();
  assert.ok(h.reservations.has(SUBJECT));
  assert.equal((await h.assignment()).ownership, "external");
  assert.ok(h.requests.every((r) => r === "GET"));
});

for (const mode of ["lost-applied", "lost-late"])
  test(`${mode}: lost acknowledgement never confers ownership or permits an opposite request`, async (t) => {
    const h = await setup();
    t.after(() => h.fixture.close());
    await h.checkout();
    h.truth.entitlements = [paid()];
    h.control.mode = mode;
    await h.cycle();
    assert.equal((await h.assignment()).state, "needs-attention");
    h.truth.entitlements = [paid({ adminAction: "revoke" })];
    h.control.mode = "normal";
    await h.cycle();
    h.reservations.add(SUBJECT);
    await h.cycle();
    assert.equal((await h.assignment()).ownership, "uncertain");
    assert.equal((await h.assignment()).obligation, true);
    assert.equal(h.requests.filter((r) => r !== "GET").length, 1);
    await assert.rejects(
      h.service.repair({
        guildId: "guild",
        id: (await h.assignment()).id,
        actorId: "staff",
        reason: "Provider investigation",
      }),
      /possible late/,
    );
  });

test("unlink before first grant withholds; relinking another account never transfers", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid()];
  await h.link(SUBJECT, "buyer", "guild", false, false);
  await h.link(SECOND);
  await h.cycle();
  assert.equal(h.requests.filter((r) => r !== "GET").length, 0);
  await h.link();
  await h.cycle();
  assert.ok(h.reservations.has(SUBJECT));
  assert.ok(!h.reservations.has(SECOND));
  await h.link(SUBJECT, "buyer", "guild", false, false);
  await h.cycle();
  assert.ok(!h.reservations.has(SUBJECT));
  assert.ok(h.requests.includes(`remove:${SUBJECT}`));
});

test("eligibility is reloaded immediately before dispatch", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid()];
  h.control.beforeMutation = async () => {
    h.truth.entitlements = [paid({ adminAction: "revoke" })];
  };
  await h.cycle();
  assert.equal(h.requests.filter((r) => r !== "GET").length, 0);
  assert.equal((await h.assignment()).transmitted, null);
});

test("sales/grants off preserve cleanup; hard stop sends no traffic and retains obligations", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid()];
  await h.cycle();
  h.control.sales = false;
  h.truth.grantsAllowed = false;
  h.truth.entitlements = [paid({ adminAction: "revoke" })];
  h.control.ready = false;
  h.requests.length = 0;
  await h.cycle();
  assert.equal(h.requests.length, 0);
  assert.equal((await h.assignment()).obligation, true);
  await assert.rejects(h.checkout(), /disabled/);
  h.control.ready = true;
  await h.cycle();
  assert.ok(h.requests.includes(`remove:${SUBJECT}`));
});

test("five failed automatic dispatches retain cleanup; authorized repair recomputes current truth", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid()];
  await h.cycle();
  h.truth.entitlements = [paid({ adminAction: "revoke" })];
  h.control.mode = "before-send-failure";
  for (let i = 0; i < 7; i++) await h.cycle();
  assert.equal((await h.assignment()).attempts, 5);
  assert.equal((await h.assignment()).obligation, true);
  h.control.mode = "normal";
  await h.service.repair({
    guildId: "guild",
    id: (await h.assignment()).id,
    actorId: "staff",
    reason: "Provider access restored",
  });
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
});

test("confirmed unpaid expiry releases allocations; late payment cannot bypass capacity", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.cycle();
  assert.notEqual((await h.assignment()).slot, null);
  h.truth.unpaidAllocationsTerminal = true;
  await h.cycle();
  assert.equal((await h.assignment()).slot, null);
  h.control.capacity = 0;
  h.truth.entitlements = [paid()];
  await h.cycle();
  assert.equal((await h.assignment()).state, "needs-attention");
  assert.ok(h.requests.every((r) => r === "GET"));
});

test("one validated target list serves multiple due buyers without mutations", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.link(SECOND, "second");
  await h.checkout({ checkoutId: "second", userId: "second", buyerId: "second" });
  h.requests.length = 0;
  await h.cycle();
  assert.deepEqual(h.requests, ["GET"]);
  h.control.mode = "outage";
  await h.cycle();
  assert.equal((await h.assignment()).observed, false);
});

test("incomplete, duplicate, non-string and malformed reserved lists are unknown", () => {
  for (const body of [
    {},
    { reservedSlots: [], nextPage: "x" },
    { reservedSlots: [SUBJECT, SUBJECT] },
    { reservedSlots: [Number(SUBJECT)] },
    { reservedSlots: ["invalid"] },
  ])
    assert.throws(() => decodeReservedSlots(body));
  assert.deepEqual([...decodeReservedSlots({ reservedSlots: [SUBJECT] })], [SUBJECT]);
});

for (const [label, overrides] of Object.entries({
  refund: { amountRefundedMinor: 1000 },
  dispute: { disputeStatus: "lost" },
  banned: { memberState: "banned" },
  left: { memberState: "left" },
  unpaid: { subscriptionStatus: "unpaid" },
  suspended: { adminAction: "suspend" },
}))
  test(`${label} removes only HAF-owned game access`, async (t) => {
    const h = await setup();
    t.after(() => h.fixture.close());
    await h.checkout();
    h.truth.entitlements = [paid()];
    await h.cycle();
    h.truth.entitlements = [paid(overrides as Partial<PaidRoleEntitlementState>)];
    await h.cycle();
    assert.equal((await h.assignment()).state, "removed");
  });

test("the narrow WDRCON adapter maps only reserved-list/add/remove and rejects writes by default", async () => {
  const { requestWdrcon } = await import("../src/wardogs/transport");
  const requests: { url: string; method: string; body: unknown }[] = [];
  const input = {
    origin: {
      id: "fixture",
      origin: "https://fixture.example",
      runtime: "cloudflare" as const,
      securePathEvidence: "Synthetic transport only",
    },
    secret: "synthetic-password",
    reservedAccessEnabled: true,
    targetOptIn: true,
    transport: async (url: string, init: RequestInit) => {
      requests.push({
        url,
        method: init.method!,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ reservedSlots: [] });
    },
  };
  await assert.rejects(
    requestWdrcon({
      ...input,
      request: { kind: "reserved-mutation", action: "grant", steamId: SUBJECT },
    }),
  );
  assert.equal(requests.length, 0);
  await requestWdrcon({ ...input, request: { kind: "reserved-list" } });
  await requestWdrcon({
    ...input,
    mutationsEnabled: true,
    targetOptIn: true,
    request: { kind: "reserved-mutation", action: "grant", steamId: SUBJECT },
  });
  await requestWdrcon({
    ...input,
    mutationsEnabled: true,
    targetOptIn: true,
    request: { kind: "reserved-mutation", action: "remove", steamId: SUBJECT },
  });
  assert.deepEqual(requests, [
    { url: "https://fixture.example/v1/reserved-slots", method: "GET", body: null },
    {
      url: "https://fixture.example/v1/reserved-slots",
      method: "POST",
      body: { steamId: SUBJECT },
    },
    { url: `https://fixture.example/v1/reserved-slots/${SUBJECT}`, method: "DELETE", body: null },
  ]);
});

for (const runtime of ["cloudflare", "portable"] as const)
  test(`${runtime}: WARDOGS reserved grants stay disabled independently of approved cleanup`, async (t) => {
    const { WardogsService } = await import("../src/wardogs/service");
    const { createCloudflareWardogsStore } =
      await import("../src/runtime/cloudflare-wardogs-store");
    const { createWebhookCredentialKeyRing } = await import("../src/security/webhook-credentials");
    const fixture = createProductionRuntimeStores();
    t.after(() => fixture.close());
    const store = createCloudflareWardogsStore(fixture.database.d1);
    let now = 1e6;
    const policy: import("../src/wardogs/model").NetworkPolicy = {
      enabled: true,
      origins: [
        {
          id: "fixture",
          origin: "https://fixture.example",
          runtime,
          securePathEvidence: "Synthetic only",
        },
      ],
      approvals: [],
    };
    const calls: string[] = [];
    const service = new WardogsService({
      store,
      policy,
      runtime,
      mutationsEnabled: true,
      reservedAccessEnabled: true,
      keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      transport: async (url, init) => {
        calls.push(init.method!);
        return Response.json(
          url.endsWith("capabilities")
            ? { routes: ["GET /v1/status"] }
            : { players: { current: 0, max: 64 } },
        );
      },
    });
    let target = await service.create("guild", "Fixture", "fixture");
    target = await service.change({
      guildId: "guild",
      targetId: target.id,
      generation: target.generation,
      enabled: true,
      commerceEnabled: true,
      secret: "synthetic-password",
    });
    policy.approvals = [
      {
        targetId: target.id,
        generation: target.generation,
        originRef: "fixture",
        origin: policy.origins[0].origin,
        reservedContract: {
          physicalTargetId: "physical",
          evidence: "Synthetic finite-entry fixture only",
          completeList: true,
          capacityMeaning: "saleable-entries",
          entryCapacity: 2,
        },
      },
    ];
    await service.verify({
      guildId: "guild",
      targetId: target.id,
      generation: target.generation,
      roster: false,
    });
    now += 5000;
    calls.length = 0;
    await assert.rejects(
      service.accessRequest(
        { guildId: "guild", targetId: target.id, generation: target.generation },
        { kind: "reserved-mutation", action: "grant", steamId: SUBJECT },
      ),
    );
    assert.equal(calls.length, 0);
    await service.accessRequest(
      { guildId: "guild", targetId: target.id, generation: target.generation },
      { kind: "reserved-mutation", action: "remove", steamId: SUBJECT },
    );
    assert.deepEqual(calls, ["DELETE"]);
    const disabled = new WardogsService({
      store,
      policy,
      runtime,
      keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
      transport: async () => {
        assert.fail("Reserved network defaults off at the side-effect boundary");
      },
    });
    for (const request of [
      { kind: "reserved-list" } as const,
      { kind: "reserved-mutation", action: "remove", steamId: SUBJECT } as const,
    ]) {
      await assert.rejects(
        disabled.accessRequest(
          { guildId: "guild", targetId: target.id, generation: target.generation },
          request,
        ),
        { code: "disabled" },
      );
    }
    await service.change({
      guildId: "guild",
      targetId: target.id,
      generation: target.generation,
      disconnect: true,
    });
    now += 6000;
    await assert.rejects(
      service.accessRequest(
        { guildId: "guild", targetId: target.id, generation: target.generation },
        { kind: "reserved-list" },
      ),
      { code: "disabled" },
    );
    assert.deepEqual(calls, ["DELETE"]);
  });

test("purchased destinations cannot be redirected, even by a racing configuration write", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  const config = (await h.store.config("offering"))!;
  await h.fixture.database.d1
    .prepare(
      `INSERT INTO commerce_checkout_attempts(id,connected_account_id,guild_id,offering_id,price_id,buyer_id,status,expires_at_ms,created_at_ms,updated_at_ms) VALUES('locked-checkout','account','guild','offering','price','buyer-row','creating',1,1,1)`,
    )
    .run();
  await assert.rejects(h.store.configure({ ...config, targetId: "other" }), /immutable/);
  await assert.rejects(
    h.store.configure({ ...config, origin: "https://other.example" }),
    /immutable/,
  );
  assert.equal(await h.store.canChangeOrigin("guild", "target"), false);
  await h.store.configure({ ...config, acceptingSales: false });
  assert.equal((await h.store.config("offering"))?.acceptingSales, false);
});

test("acknowledged writes remain uncertain until complete readback succeeds", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid()];
  h.control.mode = "readback-outage";
  await h.cycle();
  assert.equal((await h.assignment()).state, "needs-attention");
  assert.equal((await h.assignment()).transmitted?.acknowledged, true);
  h.control.mode = "outage";
  await h.cycle();
  assert.equal((await h.assignment()).obligation, true);
  h.control.mode = "normal";
  await h.cycle();
  assert.equal((await h.assignment()).state, "managed");
  assert.deepEqual(
    h.requests.filter((x) => x !== "GET"),
    [`grant:${SUBJECT}`],
  );
});

test("a lost Queue send remains durable and reconciliation retries present state", async (t) => {
  const h = await setup();
  t.after(() => h.fixture.close());
  await h.checkout();
  h.truth.entitlements = [paid()];
  await assert.rejects(
    h.service.sweepOutbox({
      send: async () => {
        throw new Error("queue unavailable");
      },
    }),
  );
  assert.equal((await h.assignment()).desired, true);
  assert.equal(h.requests.filter((x) => x !== "GET").length, 0);
  h.truth.entitlements = [paid({ subscriptionStatus: "ended" })];
  await h.cycle();
  assert.equal(h.requests.filter((x) => x !== "GET").length, 0);
});
