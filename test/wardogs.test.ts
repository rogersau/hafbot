import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "./support/sqlite-d1-database";
import { createSqliteWardogsStore } from "./support/sqlite/runtime/sqlite-wardogs-store";
import {
  createWebhookCredentialKeyRing,
  encryptWebhookCredential,
  type PlaintextWebhookUrl,
} from "../src/security/webhook-credentials";
import { WardogsService } from "../src/wardogs/service";
import { approvedOrigin, readWdrcon } from "../src/wardogs/transport";
import { wardogsNetworkPolicy } from "../src/wardogs/config";
import { validateWardogsContract } from "../src/wardogs/harness";
import {
  type ApprovedOrigin,
  type NetworkPolicy,
  type ReadOperation,
  WARDOGS_POLICY,
} from "../src/wardogs/model";
const fixture = JSON.parse(readFileSync("test/fixtures/wardogs/reads.json", "utf8"));
const origin: ApprovedOrigin = {
  id: "synthetic",
  origin: "https://wardogs.example.com",
  securePathEvidence: "Synthetic recording transport only",
};
const keyRing = () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) });
async function setup() {
  const database = await createTestDatabase();
  const store = createSqliteWardogsStore(database.d1);
  const calls: { url: string; init: RequestInit }[] = [];
  const clock = { now: 1_000_000 };
  let responder = (operation: ReadOperation) => Response.json(fixture[operation]);
  const policy: NetworkPolicy = { enabled: true, origins: [origin], approvals: [] };
  const service = new WardogsService({
    store,
    keyRing,
    policy,
    now: () => clock.now,
    wait: async (ms) => {
      clock.now += ms;
    },
    transport: async (url, init) => {
      calls.push({ url, init });
      return responder(
        url.endsWith("capabilities")
          ? "capabilities"
          : url.endsWith("status")
            ? "status"
            : "roster",
      );
    },
  });
  let target = await service.create("guild-1", "Test", origin.id);
  target = await service.change({
    guildId: "guild-1",
    targetId: target.id,
    generation: target.generation,
    secret: "private-password",
    enabled: true,
  });
  policy.approvals = [
    {
      targetId: target.id,
      generation: target.generation,
      originRef: origin.id,
      origin: origin.origin,
    },
  ];
  return {
    database,
    store,
    service,
    calls,
    clock,
    policy,
    target,
    input: { guildId: "guild-1", targetId: target.id, generation: target.generation },
    respond: (fn: typeof responder) => {
      responder = fn;
    },
  };
}

test("WARDOGS synthetic decoding exposes only known reads, unknown queue and string identities", async () => {
  const f = await setup();
  try {
    assert.equal(fixture.provenance, "synthetic");
    assert.deepEqual(await f.service.read({ ...f.input, operation: "capabilities" }), {
      routes: ["status", "roster"],
    });
    f.clock.now += 5000;
    const status = await f.service.read({ ...f.input, operation: "status" });
    assert.equal(status.queue, null);
    assert.equal(f.calls.length, 2);
    f.clock.now += 5000;
    assert.deepEqual(await f.service.read({ ...f.input, operation: "roster" }), {
      players: [{ steamId: "76561198000000001" }],
    });
    assert.ok(f.calls.every(({ init }) => init.method === "GET" && init.redirect === "manual"));
    assert.ok(
      f.calls.every(({ url }) =>
        /^https:\/\/wardogs.example.com\/v1\/(capabilities|status|players)$/.test(url),
      ),
    );
    const dto = JSON.stringify(await f.service.list("guild-1"));
    for (const forbidden of [
      "private-password",
      "envelope",
      "ciphertext",
      "fingerprint",
      "credentialId",
    ])
      assert.ok(!dto.includes(forbidden));
  } finally {
    f.database.close();
  }
});

test("Ban Cases and reserved access retain independent opt-ins and share one origin budget", async () => {
  const f = await setup();
  try {
    let target = await f.service.change({
      ...f.input,
      banCasesEnabled: true,
      commerceEnabled: true,
    });
    const approval = {
      targetId: target.id,
      generation: target.generation,
      originRef: origin.id,
      origin: origin.origin,
      banContract: {
        physicalTargetId: "synthetic-server",
        evidence: "Synthetic synchronous ban contract",
        completeList: true,
        synchronousMutations: true,
        ban: true,
        unban: true,
      },
      reservedContract: {
        physicalTargetId: "synthetic-server",
        evidence: "Synthetic reserved-access contract",
        completeList: true,
        capacityMeaning: "saleable-entries",
        entryCapacity: 2,
      },
    };
    const policy = wardogsNetworkPolicy({
      WARDOGS_NETWORK_ENABLED: "true",
      WARDOGS_NETWORK_POLICY: JSON.stringify({ origins: [origin], approvals: [approval] }),
    });
    assert.equal(policy.enabled, true);
    assert.equal(policy.approvals.length, 1);
    const calls: { path: string; method: string }[] = [];
    const waits: number[] = [];
    const service = new WardogsService({
      store: f.store,
      keyRing,
      policy,
      mutationsEnabled: true,
      reservedAccessEnabled: true,
      commerceGrantsEnabled: true,
      now: () => f.clock.now,
      wait: async (ms) => {
        waits.push(ms);
        f.clock.now += ms;
      },
      transport: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method ?? "GET" });
        if (init.method !== "GET") return new Response(null, { status: 204 });
        if (path === "/v1/capabilities") return Response.json(fixture.capabilities);
        if (path === "/v1/status") return Response.json(fixture.status);
        return Response.json({ entries: [] });
      },
    });
    const input = () => ({ ...f.input, generation: target.generation });
    await service.verify({ ...input(), roster: false });
    assert.equal((await service.banReadiness("guild-1", target.id, "ban")).ready, true);
    assert.equal((await service.accessReadiness("guild-1", target.id)).ready, true);
    const stored = (await f.store.read("guild-1", target.id))!;
    assert.equal(stored.banCasesEnabled, true);
    assert.equal(stored.commerceEnabled, true);
    const steamId = "76561198000000001";
    f.clock.now += 5000;
    await service.banRequest(
      { ...input(), action: "ban" },
      { kind: "mutation", action: "ban", steamId, reason: "Synthetic staff reason" },
    );
    waits.length = 0;
    await service.accessRequest(input(), { kind: "reserved-list" });
    assert.deepEqual(waits, [5000]);
    await assert.rejects(service.banRequest({ ...input(), action: "ban" }, { kind: "bans" }), {
      code: "rate_limited",
    });
    f.clock.now += 5000;
    await service.accessRequest(input(), { kind: "reserved-mutation", action: "grant", steamId });
    f.clock.now += 5000;
    await service.banRequest(
      { ...input(), action: "unban" },
      { kind: "mutation", action: "unban", steamId, reason: "Synthetic staff reason" },
    );
    f.clock.now += 5000;
    await service.accessRequest(input(), { kind: "reserved-mutation", action: "remove", steamId });
    assert.deepEqual(
      calls.filter(({ method }) => method !== "GET"),
      [
        { path: "/v1/bans", method: "POST" },
        { path: "/v1/reserved-slots", method: "POST" },
        { path: `/v1/bans/${steamId}`, method: "DELETE" },
        { path: `/v1/reserved-slots/${steamId}`, method: "DELETE" },
      ],
    );
    for (const banCasesEnabled of [false, true]) {
      target = await service.change({
        ...input(),
        banCasesEnabled,
        commerceEnabled: !banCasesEnabled,
      });
      policy.approvals = [{ ...policy.approvals[0]!, generation: target.generation }];
      f.clock.now += 5000;
      await service.verify({ ...input(), roster: false });
      assert.equal(
        (await service.banReadiness("guild-1", target.id, "ban")).ready,
        banCasesEnabled,
      );
      assert.equal((await service.accessReadiness("guild-1", target.id)).ready, !banCasesEnabled);
    }
  } finally {
    f.database.close();
  }
});

test("WARDOGS Guild ownership, envelope binding, replacement and disconnect fence stale work", async () => {
  const f = await setup();
  try {
    assert.deepEqual(await f.service.list("guild-2"), []);
    await assert.rejects(f.service.read({ ...f.input, guildId: "guild-2", operation: "status" }), {
      code: "disabled",
    });
    const other = await f.service.create("guild-1", "Other", origin.id);
    const stored = (await f.store.read("guild-1", f.target.id))!;
    const ring = await keyRing();
    for (const owner of [
      { kind: "wardogs_rcon" as const, guildId: "guild-2", publicId: f.target.id },
      { kind: "wardogs_rcon" as const, guildId: "guild-1", publicId: other.id },
      { kind: "server_levels_data_api" as const, guildId: "guild-1", publicId: f.target.id },
    ]) {
      stored.envelope = await encryptWebhookCredential({
        plaintext: "private-password" as PlaintextWebhookUrl,
        credentialId: stored.credentialId!,
        owner,
        keyRing: ring,
      });
      await f.store.save(stored, stored.generation);
      await assert.rejects(f.service.read({ ...f.input, operation: "status" }), {
        code: "disabled",
      });
      f.clock.now += 5000;
    }
    assert.equal(f.calls.length, 0);
    const replaced = await f.service.change({ ...f.input, secret: "replacement" });
    assert.equal(replaced.generation, f.target.generation + 1);
    assert.equal(replaced.verifiedAtMs, null);
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), { code: "disabled" });
    await assert.rejects(
      f.service.read({ ...f.input, generation: replaced.generation, operation: "status" }),
      { code: "unapproved_target" },
    );
    const disconnected = await f.service.change({
      ...f.input,
      generation: replaced.generation,
      disconnect: true,
    });
    assert.equal(disconnected.credentialConfigured, false);
    assert.equal(disconnected.enabled, false);
    assert.equal((await f.service.list("guild-1")).length, 2);
  } finally {
    f.database.close();
  }
});

test("WARDOGS rejects every disabled, unapproved, ambiguous and forbidden origin before egress", async () => {
  const f = await setup();
  try {
    for (const raw of [
      "http://public.example.com",
      "https://127.0.0.1",
      "https://2130706433",
      "https://0x7f000001",
      "https://10.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://localhost",
      "https://metadata.google.internal",
      "https://foo.local",
      "https://foo.internal",
      "https://public.example.com:8080",
      "https://u:p@public.example.com",
      "https://public.example.com/path",
      "https://public.example.com?",
      "https://public.example.com#",
      "https://public.example.com.",
      "https://public.example.com\\@evil.com",
      " https://public.example.com",
      "https://%31%32%37.0.0.1",
    ]) {
      assert.throws(
        () => approvedOrigin({ ...origin, origin: raw }),
        { code: "unapproved_target" },
        raw,
      );
    }
    assert.equal(
      approvedOrigin({ ...origin, origin: "https://WARDOGS.example.com:443/" }),
      origin.origin,
    );
    f.policy.enabled = false;
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), { code: "disabled" });
    f.policy.enabled = true;
    f.policy.approvals = [];
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), {
      code: "unapproved_target",
    });
    const disabled = new WardogsService({ store: f.store, keyRing });
    await assert.rejects(disabled.read({ ...f.input, operation: "status" }), { code: "disabled" });
    assert.equal(f.calls.length, 0);
    assert.equal(wardogsNetworkPolicy({ WARDOGS_NETWORK_ENABLED: "true" }).enabled, false);
    assert.equal(
      wardogsNetworkPolicy({ WARDOGS_NETWORK_ENABLED: "true", WARDOGS_NETWORK_POLICY: "bad" })
        .enabled,
      false,
    );
  } finally {
    f.database.close();
  }
});

test("WARDOGS roster envelope metadata cannot be discarded into a complete empty roster", async () => {
  for (const metadata of [
    { nextPage: "cursor" },
    { nextCursor: "cursor" },
    { partial: true },
    { truncated: true },
    { total: 10 },
  ])
    await assert.rejects(
      readWdrcon({
        origin,
        secret: "synthetic",
        operation: "roster",
        transport: async () => Response.json({ players: [], ...metadata }),
      }),
      { code: "invalid_response" },
    );
});

test("WARDOGS invalid complete rosters and malformed responses never return partial observations", async () => {
  for (const players of [
    [{ steamId: Number("76561198000000001") }],
    [{ steamId: "76561198000000001" }, {}],
    [{ steamId: "76561198000000001" }, { steamId: "76561198000000001" }],
    Array(513).fill({ steamId: "76561198000000001" }),
  ]) {
    await assert.rejects(
      readWdrcon({
        origin,
        secret: "secret",
        operation: "roster",
        transport: async () => Response.json({ players }),
      }),
      { code: "invalid_response" },
    );
  }
  for (const body of [
    "broken",
    "{}",
    '{"players":{"current":-1,"max":64}}',
    '{"players":{"current":1,"max":"64"}}',
  ]) {
    await assert.rejects(
      readWdrcon({
        origin,
        secret: "secret",
        operation: "status",
        transport: async () => new Response(body),
      }),
      { code: "invalid_response" },
    );
  }
  await assert.rejects(
    readWdrcon({
      origin,
      secret: "secret",
      operation: "status",
      transport: async () => new Response("x".repeat(WARDOGS_POLICY.maxResponseBytes + 1)),
    }),
    { code: "oversized_response" },
  );
});

test("WARDOGS normalizes redirects, TLS, provider errors and header-unsafe passwords", async () => {
  for (const [status, code] of [
    [302, "unapproved_target"],
    [401, "authentication_failed"],
    [403, "forbidden"],
    [404, "unsupported_operation"],
    [500, "provider_unavailable"],
  ] as const) {
    await assert.rejects(
      readWdrcon({
        origin,
        secret: "secret",
        operation: "status",
        transport: async () =>
          new Response("private-password player identity", {
            status,
            headers: { Location: "https://other.example.com" },
          }),
      }),
      (error: Error) => {
        assert.equal((error as Error & { code: string }).code, code);
        assert.ok(!error.message.includes("private-password"));
        return true;
      },
    );
  }
  await assert.rejects(
    readWdrcon({
      origin,
      secret: "secret",
      operation: "status",
      transport: async () => {
        throw Object.assign(new Error("private"), { code: "CERT_HAS_EXPIRED" });
      },
    }),
    { code: "tls_error" },
  );
  for (const secret of ["", "\npassword", " password", "password\t", "a".repeat(1025)]) {
    await assert.rejects(
      readWdrcon({
        origin,
        secret,
        operation: "status",
        transport: async () => {
          assert.fail("must not send credentials");
        },
      }),
      { code: "invalid_response" },
    );
  }
});

test("WARDOGS authentication suppression and origin-wide Retry-After survive service recreation", async () => {
  const f = await setup();
  try {
    f.respond(() => new Response("secret", { status: 401 }));
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), {
      code: "authentication_failed",
    });
    f.clock.now += 5000;
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), {
      code: "authentication_failed",
    });
    assert.equal(f.calls.length, 1);
    f.respond((operation) => Response.json(fixture[operation]));
    const verified = await f.service.verify({ ...f.input, roster: false });
    assert.equal(verified.verifiedGeneration, f.target.generation);
    f.clock.now += 5000;
    f.respond(() => new Response("secret", { status: 429, headers: { "Retry-After": "90" } }));
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), {
      code: "rate_limited",
    });
    f.clock.now += 60_000;
    assert.equal(
      await createSqliteWardogsStore(f.database.d1).claim(
        origin.origin,
        "another",
        f.clock.now,
        6000,
        5000,
      ),
      false,
    );
    const state = (await f.service.list("guild-1"))[0]!;
    assert.equal(state.stale, true);
    assert.notEqual(state.lastSuccessAtMs, null);
  } finally {
    f.database.close();
  }
});

test("WARDOGS durable claims limit concurrent consumers and Guild slots", async () => {
  const f = await setup();
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        f.store.claim(origin.origin, crypto.randomUUID(), f.clock.now, 6000, 5000),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const creations = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => f.service.create("guild-1", `Target ${i}`, null)),
    );
    assert.equal(creations.filter((result) => result.status === "fulfilled").length, 4);
    assert.equal((await f.service.list("guild-1")).length, 5);
  } finally {
    f.database.close();
  }
});

test("WARDOGS validation harness uses real client and emits secret-free evidence", async () => {
  const f = await setup();
  try {
    const evidence = await validateWardogsContract(f.service, {
      ...f.input,
      roster: true,
      operatorConfirmation: "APPROVE_READ_ONLY_VALIDATION",
      provider: "Synthetic fixture",
      serverBuild: null,
      sourceRevision: "test",
    });
    assert.equal(evidence.testedRoutes.length, 3);
    const json = JSON.stringify(evidence);
    for (const forbidden of [
      "private-password",
      "76561198000000001",
      origin.origin,
      "Synthetic player",
    ])
      assert.ok(!json.includes(forbidden));
  } finally {
    f.database.close();
  }
});

test("WARDOGS timeout bounds a transport that ignores abort", async () => {
  await assert.rejects(
    readWdrcon({
      origin,
      secret: "secret",
      operation: "status",
      transport: () => new Promise(() => {}),
    }),
    { code: "timeout" },
  );
});

test("WARDOGS shared origin budget cannot be bypassed by another Guild target", async () => {
  const f = await setup();
  try {
    let other = await f.service.create("guild-2", "Shared listener", origin.id);
    other = await f.service.change({
      guildId: "guild-2",
      targetId: other.id,
      generation: other.generation,
      secret: "other-password",
      enabled: true,
    });
    f.policy.approvals = [
      ...f.policy.approvals,
      {
        targetId: other.id,
        generation: other.generation,
        originRef: origin.id,
        origin: origin.origin,
      },
    ];
    for (let i = 0; i < 12; i++) {
      await f.service.read({ ...f.input, operation: "status" });
      await assert.rejects(
        f.service.read({
          guildId: "guild-2",
          targetId: other.id,
          generation: other.generation,
          operation: "status",
        }),
        { code: "rate_limited" },
      );
      f.clock.now += 5000;
    }
    assert.equal(f.calls.length, 12);
  } finally {
    f.database.close();
  }
});

test("WARDOGS discards in-flight results after disconnect", async () => {
  const f = await setup();
  try {
    let complete!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new WardogsService({
      store: f.store,
      keyRing,
      policy: f.policy,
      now: () => f.clock.now,
      transport: () => {
        started();
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      },
    });
    const pending = service.read({ ...f.input, operation: "status" });
    await ready;
    const disconnected = await f.service.change({ ...f.input, disconnect: true });
    complete(Response.json(fixture.status));
    await assert.rejects(pending, { code: "disabled" });
    const persisted = (await f.service.list("guild-1"))[0]!;
    assert.equal(persisted.generation, disconnected.generation);
    assert.equal(persisted.credentialConfigured, false);
    assert.equal(persisted.lastSuccessAtMs, null);
  } finally {
    f.database.close();
  }
});

test("WARDOGS body timeout, 429 fallback and no arbitrary runtime routes", async () => {
  await assert.rejects(
    readWdrcon({
      origin,
      secret: "secret",
      operation: "status",
      transport: async () =>
        new Response(
          new ReadableStream({
            start() {
              /* Never produces bytes. */
            },
          }),
        ),
    }),
    { code: "timeout" },
  );
  for (const retryAfter of ["", "bad", "0", "-1"]) {
    await assert.rejects(
      readWdrcon({
        origin,
        secret: "secret",
        operation: "status",
        now: () => 1000,
        transport: async () =>
          new Response("", { status: 429, headers: { "Retry-After": retryAfter } }),
      }),
      { code: "rate_limited", retryAtMs: 61_000 },
    );
  }
  for (const operation of [
    "config",
    "audit",
    "kill",
    "broadcast",
    "password",
    "POST /v1/bans",
    "toString",
  ]) {
    await assert.rejects(
      readWdrcon({
        origin,
        secret: "secret",
        operation: operation as ReadOperation,
        transport: async () => {
          assert.fail("arbitrary route");
        },
      }),
      { code: "unsupported_operation" },
    );
  }
});

test("WARDOGS approval cannot follow an operator reference to a different origin", async () => {
  const f = await setup();
  try {
    await f.service.verify({ ...f.input, roster: false });
    const calls = f.calls.length;
    f.clock.now += 5000;
    f.policy.origins = [{ ...origin, origin: "https://other.example.com" }];
    assert.equal((await f.service.list("guild-1"))[0]!.stale, true);
    await assert.rejects(f.service.read({ ...f.input, operation: "status" }), {
      code: "unapproved_target",
    });
    assert.equal(f.calls.length, calls);
  } finally {
    f.database.close();
  }
});
