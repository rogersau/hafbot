import assert from "node:assert/strict";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import test from "node:test";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import {
  createCloudflareBanEnforcementStore,
  createCloudflareWardogsStore,
} from "../src/runtime/cloudflare-wardogs-store";
import { BanCaseEnforcement } from "../src/ban-case-enforcement/service";
import { createWardogsBanProvider, decodeBanPresence } from "../src/ban-case-enforcement/provider";
import { WardogsService } from "../src/wardogs/service";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import type { NetworkPolicy } from "../src/wardogs/model";
import { WardogsError } from "../src/wardogs/model";
import type { BanCase } from "../src/types";
import { handleBanEnforcementInteraction } from "../src/runtime/ban-case-enforcement-interaction";
import { createBanCaseEnforcementRuntime } from "../src/runtime/ban-case-enforcement-runtime";

async function setup() {
  const fixture = createProductionRuntimeStores();
  const clock = { now: 1_000_000 };
  const control = {
    authorized: true,
    available: true,
    banned: false,
    mode: "normal",
    mutations: true,
    notifications: 0,
    notificationFail: false,
  };
  const requests: { url: string; method: string; body: unknown }[] = [];
  const policy: NetworkPolicy = {
    enabled: true,
    origins: [
      {
        id: "test",
        origin: "https://wardogs.example.com",
        runtime: "cloudflare",
        securePathEvidence: "Synthetic recording only",
      },
    ],
    approvals: [],
  };
  const targetStore = createCloudflareWardogsStore(fixture.database.d1);
  const options = {
    store: targetStore,
    policy,
    runtime: "cloudflare" as const,
    mutationsEnabled: true,
    keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
    now: () => clock.now,
    wait: async (ms: number) => {
      clock.now += ms;
    },
    transport: async (url: string, init: RequestInit) => {
      requests.push({
        url,
        method: init.method!,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("capabilities"))
        return Response.json({
          routes: ["GET /v1/status", "GET /v1/bans", "POST /v1/bans", "DELETE /v1/bans/{steamId}"],
        });
      if (url.endsWith("status")) return Response.json({ players: { current: 0, max: 64 } });
      if (init.method === "GET") {
        if (control.mode === "read-fail") throw new Error("private raw provider error");
        if (control.mode === "auth") return new Response("private error", { status: 401 });
        if (control.mode === "rate")
          return new Response("", { status: 429, headers: { "Retry-After": "1200" } });
        if (control.mode === "malformed") return Response.json({ bans: [], nextPage: "unknown" });
        return Response.json({
          bans: control.banned
            ? [{ steamId: "76561198000000001", reason: "another administrator's reason" }]
            : [],
        });
      }
      assert.ok(control.mutations);
      if (control.mode !== "lost-no-apply") control.banned = init.method === "POST";
      if (control.mode.startsWith("lost"))
        throw new Error("private-password private provider failure");
      return Response.json({ message: "accepted" });
    },
  };
  const wardogs = new WardogsService(options);
  let target = await wardogs.create("guild-1", "Synthetic target", "test");
  target = await wardogs.change({
    guildId: "guild-1",
    targetId: target.id,
    generation: target.generation,
    secret: "private-password",
    enabled: true,
    banCasesEnabled: true,
  });
  policy.approvals = [
    {
      targetId: target.id,
      generation: target.generation,
      originRef: "test",
      origin: policy.origins[0]!.origin,
      banContract: {
        physicalTargetId: "synthetic-physical-server",
        evidence: "Synthetic contract only",
        completeList: true,
        synchronousMutations: true,
        ban: true,
        unban: true,
      },
    },
  ];
  await wardogs.verify({
    guildId: "guild-1",
    targetId: target.id,
    generation: target.generation,
    roster: false,
  });
  clock.now += 5000;
  requests.length = 0;
  const c: BanCase = {
    guildId: "guild-1",
    caseId: "case-1",
    sourceId: "source",
    publicId: "public",
    subject: { platform: "steam", id: "76561198000000001" },
    username: "Reported",
    status: "new",
    threadChannelId: "thread",
    threadMessageId: "message",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  await fixture.stores.banCases.createBanCase(c);
  const store = createCloudflareBanEnforcementStore(fixture.database.d1);
  const provider = createWardogsBanProvider(wardogs);
  const serviceOptions = {
    store,
    cases: fixture.stores.banCases,
    provider,
    now: () => clock.now,
    wait: async (ms: number) => {
      clock.now += ms;
    },
    authorize: async () => control.authorized,
    available: async () => control.available,
    notify: async () => {
      control.notifications++;
      if (control.notificationFail) throw new Error("Discord unavailable");
      return "operation-message";
    },
  };
  const service = new BanCaseEnforcement(serviceOptions);
  const input = {
    guildId: "guild-1",
    actorId: "moderator",
    caseId: c.caseId,
    targetId: target.id,
    action: "ban" as const,
    reason: "Staff decision",
  };
  const prepare = (action: "ban" | "unban" = "ban") => service.prepare({ ...input, action });
  const confirm = async (action: "ban" | "unban" = "ban") => {
    const intent = await prepare(action);
    return service.confirm(intent.id, input.guildId, input.actorId);
  };
  const tick = async (ms = 60_000) => {
    clock.now += ms;
    // Advance one durable stage when a test needs to interleave a failure.
    for (const op of await store.due(clock.now)) await service.process(op.id);
    await service.projectDue();
  };
  return {
    fixture,
    store,
    clock,
    control,
    requests,
    policy,
    wardogs,
    target,
    service,
    provider,
    options,
    serviceOptions,
    input,
    prepare,
    confirm,
    tick,
  };
}

for (const action of ["ban", "unban"] as const)
  test(`WARDOGS ${action}: durable confirmation, GET before mutation, structured command and verified read-back`, async () => {
    const f = await setup();
    try {
      f.control.banned = action === "unban";
      const op = await f.confirm(action);
      assert.equal(op.state, "pending");
      assert.equal(f.requests.length, 0);
      for (let i = 0; i < 4; i++) await f.tick();
      const result = await f.store.read(op.id);
      assert.equal(result?.state, "succeeded");
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ["GET", "GET", "GET", action === "ban" ? "POST" : "DELETE", "GET"],
      );
      assert.equal(f.requests[1]?.url, "https://wardogs.example.com/v1/bans");
      if (action === "ban")
        assert.deepEqual(f.requests[3]?.body, {
          steamId: "76561198000000001",
          reason: "Staff decision",
        });
      else
        assert.equal(f.requests[3]?.url, "https://wardogs.example.com/v1/bans/76561198000000001");
      assert.equal(
        (await f.fixture.stores.banCases.readBanCase("guild-1", "case-1"))?.status,
        "new",
      );
      assert.doesNotMatch(
        JSON.stringify(await f.store.list("guild-1")),
        /private-password|Bearer|another administrator/,
      );
    } finally {
      f.fixture.database.close();
    }
  });

test("lost response and restarted consumer verify without a blind second mutation", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    f.control.mode = "lost-applied";
    await f.tick();
    assert.equal((await f.store.read(op.id))?.state, "verifying");
    f.clock.now += 20 * 60_000;
    await new BanCaseEnforcement(f.serviceOptions).processDue();
    assert.equal((await f.store.read(op.id))?.state, "needs-attention");
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    await assert.rejects(f.confirm("unban"));
  } finally {
    f.fixture.database.close();
  }
});

test("unknown late effect blocks opposite action, survives expiry, and never replays", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    f.control.mode = "lost-no-apply";
    await f.tick();
    await f.tick();
    assert.equal((await f.store.read(op.id))?.state, "needs-attention");
    await assert.rejects(f.confirm("unban"), /Unresolved work/);
    await assert.rejects(f.service.cancel(op.id, "guild-1", "moderator"), /Only undispatched/);
    await f.tick(30 * 60_000);
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    await assert.rejects(f.confirm("unban"));
    f.control.banned = true;
    await f.tick();
    assert.equal((await f.store.read(op.id))?.state, "needs-attention");
  } finally {
    f.fixture.database.close();
  }
});

test("concurrent actor-bound confirmations suppress duplicates, reject cross-Guild and expire", async () => {
  const f = await setup();
  try {
    const a = await f.prepare(),
      b = await f.prepare();
    await assert.rejects(f.service.confirm(a.id, "guild-2", "moderator"));
    await assert.rejects(f.service.confirm(a.id, "guild-1", "other-actor"));
    const ops = await Promise.all(
      [a, a, b].map((i) => f.service.confirm(i.id, "guild-1", "moderator")),
    );
    assert.equal(new Set(ops.map((o) => o.id)).size, 1);
    await f.tick(16 * 60_000);
    assert.equal((await f.store.read(ops[0]!.id))?.state, "expired");
    assert.equal(f.requests.length, 0);
    await assert.rejects(f.service.confirm(b.id, "guild-1", "moderator"), /expired/);
  } finally {
    f.fixture.database.close();
  }
});

for (const change of ["role", "available", "target", "switch"] as const)
  test(`${change} changes cancel unsent work before HTTP`, async () => {
    const f = await setup();
    try {
      const op = await f.confirm();
      if (change === "role") f.control.authorized = false;
      if (change === "available") f.control.available = false;
      if (change === "switch") f.options.mutationsEnabled = false;
      if (change === "target")
        await f.wardogs.change({
          guildId: "guild-1",
          targetId: f.target.id,
          generation: f.target.generation,
          name: "Changed",
        });
      await f.tick();
      assert.equal(f.requests.length, 0);
      assert.equal((await f.store.read(op.id))?.state, "cancelled");
    } finally {
      f.fixture.database.close();
    }
  });

for (const action of ["ban", "unban"] as const)
  test(`already ${action === "ban" ? "banned" : "unbanned"} is satisfied without changing external reasons`, async () => {
    const f = await setup();
    try {
      f.control.banned = action === "ban";
      const op = await f.confirm(action);
      await f.tick();
      await f.tick();
      assert.equal((await f.store.read(op.id))?.state, "succeeded");
      assert.ok(f.requests.every((r) => r.method === "GET"));
    } finally {
      f.fixture.database.close();
    }
  });

test("malformed/paginated lists cannot prove absence; invalid subjects/reasons never confirm", async () => {
  for (const body of [
    {},
    { bans: null },
    { bans: [], next: null },
    { bans: [{ steamId: Number("76561198000000001") }] },
    { bans: Array(2001).fill({ steamId: "76561198000000001" }) },
  ])
    assert.equal(decodeBanPresence(body, "76561198000000001"), null);
  const f = await setup();
  try {
    await assert.rejects(f.service.prepare({ ...f.input, reason: "x".repeat(501) }));
    await assert.rejects(f.service.prepare({ ...f.input, targetId: "foreign" }));
    const original = await f.fixture.stores.banCases.readBanCase("guild-1", "case-1");
    assert.ok(original);
    for (const subject of [
      { platform: "discord" as const, id: "76561198000000001" },
      { platform: "steam" as const, id: "not-a-steamid" },
    ]) {
      const caseId = crypto.randomUUID();
      await f.fixture.stores.banCases.createBanCase({ ...original, caseId, subject });
      await assert.rejects(f.service.prepare({ ...f.input, caseId }), /SteamID64/);
    }
    f.policy.approvals[0]!.banContract!.unban = false;
    await assert.rejects(f.prepare("unban"), /capabilities/);
    const draft = await f.service.select(f.input);
    await assert.rejects(f.service.confirm(draft.id, "guild-1", "moderator"));
    const op = await f.confirm();
    await f.tick();
    f.control.mode = "malformed";
    await f.tick();
    assert.equal((await f.store.read(op.id))?.state, "failed");
    assert.ok(f.requests.every((r) => r.method === "GET"));
  } finally {
    f.fixture.database.close();
  }
});

test("failed notifications never repeat a successful mutation", async () => {
  const f = await setup();
  try {
    f.control.notificationFail = true;
    const op = await f.confirm();
    for (let i = 0; i < 5; i++) await f.tick();
    assert.equal((await f.store.read(op.id))?.state, "succeeded");
    f.control.notificationFail = false;
    await f.tick();
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    assert.ok(f.control.notifications > 1);
  } finally {
    f.fixture.database.close();
  }
});

test("rate delay expires unsent work and auth errors do not retry passwords", async () => {
  for (const mode of ["rate", "auth"]) {
    const f = await setup();
    try {
      const op = await f.confirm();
      await f.tick();
      f.control.mode = mode;
      await f.tick();
      const n = f.requests.length;
      await f.tick(20 * 60_000);
      assert.equal(f.requests.length, n);
      assert.ok(["failed", "expired"].includes((await f.store.read(op.id))!.state));
    } finally {
      f.fixture.database.close();
    }
  }
});

test("pre-send failures have bounded retries and concurrent consumers claim one stage", async () => {
  const f = await setup();
  try {
    f.provider.capabilities = async () => {
      throw new WardogsError("unreachable");
    };
    const op = await f.confirm();
    for (let i = 0; i < 7; i++) {
      f.clock.now += 60_000;
      await Promise.all([
        f.service.process(op.id),
        new BanCaseEnforcement(f.serviceOptions).process(op.id),
      ]);
    }
    assert.equal((await f.store.read(op.id))?.state, "failed");
    assert.equal((await f.store.read(op.id))?.attempts, 5);
    assert.equal(f.requests.length, 0);
  } finally {
    f.fixture.database.close();
  }
});

test("staff modal presents exact external-report identity and durable acknowledgement", async () => {
  const f = await setup();
  try {
    const draft = await f.service.select(f.input);
    const base = { guild_id: "guild-1", member: { user: { id: "moderator" } } };
    const response = await handleBanEnforcementInteraction(
      {
        ...base,
        type: 5,
        data: {
          custom_id: `bce:reason:${draft.id}`,
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Explicit staff reason" }],
            },
          ],
        },
      },
      f.service,
      f.wardogs,
    );
    const json = (await response.json()) as any;
    assert.match(json.data.content, /76561198000000001/);
    assert.match(json.data.content, /Ownership is not verified/);
    const confirmed = await handleBanEnforcementInteraction(
      { ...base, type: 3, data: { custom_id: json.data.components[0].components[0].custom_id } },
      f.service,
      f.wardogs,
    );
    assert.match(JSON.stringify(await confirmed.json()), /persisted/);
    assert.equal((await f.store.list("guild-1")).length, 1);
    assert.equal(f.requests.length, 0);
  } finally {
    f.fixture.database.close();
  }
});

test("a stale worker cannot transmit after its durable claim is reclaimed", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const realMutate = f.provider.mutate;
    f.provider.mutate = async (intent, beforeSend) => {
      entered();
      await blocked;
      await realMutate(intent, beforeSend);
    };
    f.clock.now += 60_000;
    const old = f.service.process(op.id);
    await started;
    f.clock.now += 60_000;
    const current = await f.store.read(op.id);
    assert.ok(current);
    await f.store.save(
      { ...current, state: "cancelled", outcome: "cancelled while undispatched" },
      current.revision,
    );
    release();
    await assert.rejects(old, /Stale operation/);
    assert.ok(f.requests.every((r) => r.method === "GET"));
  } finally {
    f.fixture.database.close();
  }
});

test("crash marker after possible send triggers observation even beyond expiry", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.store.save(
      {
        ...op,
        state: "executing",
        transmittedAtMs: f.clock.now,
        outcome: "possible transmission",
        nextAtMs: f.clock.now,
      },
      op.revision,
    );
    f.control.banned = true;
    f.clock.now += 20 * 60_000;
    await new BanCaseEnforcement(f.serviceOptions).processDue();
    assert.equal((await f.store.read(op.id))?.state, "needs-attention");
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["GET"],
    );
  } finally {
    f.fixture.database.close();
  }
});

test("completed cases permit explicit actions; cancel and replace only undispatched work", async () => {
  const f = await setup();
  try {
    await f.fixture.stores.banCases.updateBanCaseStatus(
      "guild-1",
      "case-1",
      "completed",
      f.clock.now,
    );
    assert.equal((await f.store.list("guild-1")).length, 0);
    const ban = await f.confirm();
    await f.service.cancel(ban.id, "guild-1", "moderator");
    const unban = await f.confirm("unban");
    assert.notEqual(ban.id, unban.id);
    assert.equal(
      (await f.fixture.stores.banCases.readBanCase("guild-1", "case-1"))?.status,
      "completed",
    );
  } finally {
    f.fixture.database.close();
  }
});

test("direct adapter callers cannot bypass the mutation switch or target opt-in", async () => {
  const f = await setup();
  try {
    const intent = await f.prepare();
    f.policy.approvals[0]!.banContract!.unban = false;
    await assert.rejects(
      f.wardogs.banRequest(
        { ...intent, action: "ban" },
        {
          kind: "mutation",
          action: "unban",
          steamId: intent.subject,
          reason: intent.reason,
        },
      ),
      { code: "unsupported_operation" },
    );
    f.options.mutationsEnabled = false;
    await assert.rejects(
      f.provider.mutate(intent, async () => {}),
      { code: "disabled" },
    );
    f.options.mutationsEnabled = true;
    await f.wardogs.change({
      guildId: "guild-1",
      targetId: f.target.id,
      generation: f.target.generation,
      banCasesEnabled: false,
    });
    await assert.rejects(
      f.provider.mutate(intent, async () => {}),
      { code: "disabled" },
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.fixture.database.close();
  }
});

test("signed Discord runtime confirmation rejects a different actor and acknowledges only durable intent", async () => {
  const { handleInteractionRequest } = await import("../src/runtime/interaction-handler");
  const { createComponentIdSigner } = await import("../src/security/component-id-signer");
  const { signSensitiveComponentId } = await import("../src/security/sensitive-component-ids");
  const f = await setup();
  try {
    const intent = await f.prepare();
    const signer = createComponentIdSigner({
      currentSecret: "synthetic-component-signing-secret-32",
    });
    const customId = await signSensitiveComponentId(`bce:confirm:${intent.id}`, signer, {
      guildId: "guild-1",
      actorUserId: "moderator",
      expiresAtMs: Date.now() + 300000,
    });
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const hex = (bytes: ArrayBuffer) =>
      Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    const publicKey = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
    const options = {
      discordPublicKey: publicKey,
      discordBotToken: "synthetic-discord-token",
      stores: f.fixture.stores,
      gateway: { start: async () => {}, status: async () => ({}) },
      wardogs: f.wardogs,
      banEnforcementStore: f.store,
      componentIdSigner: signer,
      services: { banCaseEnforcement: f.service },
    };
    async function request(actor: string) {
      const body = JSON.stringify({
        type: 3,
        guild_id: "guild-1",
        member: { user: { id: actor } },
        data: { custom_id: customId },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = hex(
        await crypto.subtle.sign(
          "Ed25519",
          pair.privateKey,
          new TextEncoder().encode(timestamp + body),
        ),
      );
      return handleInteractionRequest(
        new Request("https://haf.example.com/interactions", {
          method: "POST",
          headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
          body,
        }),
        options,
      );
    }
    assert.match(JSON.stringify(await (await request("other")).json()), /no longer available/);
    assert.equal((await f.store.list("guild-1")).length, 0);
    assert.match(JSON.stringify(await (await request("moderator")).json()), /persisted/);
    assert.equal((await f.store.list("guild-1")).length, 1);
    assert.equal(f.requests.length, 0);
  } finally {
    f.fixture.database.close();
  }
});

test("admin requests bind confirmation to the authenticated account and enforce paid access", async () => {
  const { createAdminApiHandler } = await import("./helpers/admin-api");
  const f = await setup();
  try {
    await f.fixture.database.d1
      .prepare("INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES(?,?,?,?)")
      .bind("guild-1", "premium", "premium", 1)
      .run();
    const handler = createAdminApiHandler({
      stores: f.fixture.stores,
      discordBotToken: "synthetic-discord",
      services: { banCaseEnforcement: f.service },
      wardogs: f.wardogs,
      readCustomerAdminSession: async (request) => ({
        user: {
          id: "session",
          name: "Staff",
          discordUserId: request.headers.get("x-test-actor") ?? "moderator",
        },
      }),
    });
    async function request(stage: string, body: unknown, actor = "moderator") {
      const url = new URL(`https://haf.example.com/admin/api/ban-cases/server-actions/${stage}`);
      const response = await handler(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-actor": actor },
          body: JSON.stringify(body),
        }),
        url,
      );
      assert.ok(response);
      return response;
    }
    const { actorId: _actor, ...input } = f.input;
    const prepared = await request("prepare", input);
    assert.equal(prepared.status, 200);
    const id = ((await prepared.json()) as { confirmation: { id: string } }).confirmation.id;
    assert.equal((await request("confirm", { guildId: "guild-1", id }, "other")).status, 409);
    assert.equal((await f.store.list("guild-1")).length, 0);
    assert.equal((await request("confirm", { guildId: "guild-1", id })).status, 200);
    assert.equal((await f.store.list("guild-1")).length, 1);
    await f.fixture.database.d1
      .prepare("UPDATE guild_entitlements SET tier='free',plan='free' WHERE guild_id='guild-1'")
      .run();
    assert.notEqual((await request("prepare", input)).status, 200);
    assert.equal(f.requests.length, 0);
  } finally {
    f.fixture.database.close();
  }
});

test("runtime authorization refetches Ban Case staff roles before execution", async () => {
  const { createBanCaseEnforcementRuntime } =
    await import("../src/runtime/ban-case-enforcement-runtime");
  const f = await setup();
  const previous = globalThis.fetch;
  try {
    await f.fixture.stores.banCases.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      forumChannelId: "forum",
      modRoleIds: ["staff-role"],
      updatedAtMs: 1,
    });
    await f.fixture.database.d1
      .prepare("INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES(?,?,?,?)")
      .bind("guild-1", "premium", "premium", 1)
      .run();
    const discordCalls: string[] = [];
    let roles = ["staff-role"];
    globalThis.fetch = async (input) => {
      const url = String(input);
      discordCalls.push(url);
      assert.match(url, /discord.com\/api\/v10\/guilds\/guild-1\/members\/moderator/);
      return Response.json({ roles });
    };
    const service = createBanCaseEnforcementRuntime({
      stores: f.fixture.stores,
      discordBotToken: "synthetic-discord",
      wardogs: f.wardogs,
      banEnforcementStore: f.store,
      banCasesEnabled: true,
    });
    assert.ok(service);
    const intent = await service.prepare(f.input);
    const op = await service.confirm(intent.id, "guild-1", "moderator");
    roles = [];
    await service.process(op.id);
    assert.equal((await f.store.read(op.id))?.state, "cancelled");
    assert.equal(f.requests.length, 0);
    assert.ok(discordCalls.length >= 3);
  } finally {
    globalThis.fetch = previous;
    f.fixture.database.close();
  }
});

test("feature-owned incidents persist uncertainty without changing shared incident tables", async () => {
  const { createCloudflareOperationalIncidentStore } =
    await import("../src/runtime/cloudflare-operational-incident-store");
  const { OperationalIncidentService } = await import("../src/operations/incidents");
  const f = await setup();
  try {
    const store = createCloudflareOperationalIncidentStore(f.fixture.database.d1, "ban-cases");
    const reporter = new OperationalIncidentService(store);
    const key = {
      feature: "ban-cases" as const,
      resourceKind: "server-action",
      resourceId: "operation",
      condition: "enforcement-uncertain",
    };
    const incident = await reporter.observeFailure({
      guildId: "guild-1",
      key,
      summaryCode: "ban_case_enforcement_uncertain",
      safeArgs: { operationId: "operation" },
      remediationCode: "operator_intervention_required",
      observationId: "first",
    });
    assert.equal((await reporter.get("guild-1", incident.id))?.status, "open");
    assert.equal(
      (
        await createCloudflareOperationalIncidentStore(f.fixture.database.d1).listByGuild({
          guildId: "guild-1",
          status: "open",
          limit: 25,
        })
      ).length,
      0,
    );
    await reporter.observeHealthy({ guildId: "guild-1", key });
    assert.equal((await reporter.get("guild-1", incident.id))?.status, "resolved");
    assert.equal((await reporter.listEvents("guild-1", incident.id)).length, 2);
    assert.equal(
      f.fixture.database.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM operational_incident_events",
      )[0]?.n,
      0,
    );
  } finally {
    f.fixture.database.close();
  }
});

test("resuming prepared work re-reads bans and preserves an intervening external ban", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    assert.equal((await f.store.read(op.id))?.outcome, "ready to send");
    f.control.banned = true;
    await f.tick(5 * 60_000);
    assert.equal((await f.store.read(op.id))?.outcome, "already banned; existing reason preserved");
    assert.ok(f.requests.every((r) => r.method === "GET"));
  } finally {
    f.fixture.database.close();
  }
});

test("suppressed confirmation receipts remain consumed after cancellation or completion", async () => {
  const f = await setup();
  try {
    const first = await f.prepare();
    const duplicate = await f.prepare();
    const op = await f.service.confirm(first.id, "guild-1", "moderator");
    assert.equal((await f.service.confirm(duplicate.id, "guild-1", "moderator")).id, op.id);
    await f.service.cancel(op.id, "guild-1", "moderator");
    const opposite = await f.confirm("unban");
    const replay = await f.service.confirm(duplicate.id, "guild-1", "moderator");
    assert.equal(replay.id, op.id);
    assert.equal(replay.state, "cancelled");
    assert.equal((await f.store.list("guild-1")).length, 2);
    assert.notEqual(opposite.id, op.id);
  } finally {
    f.fixture.close();
  }
});

test("outbox or projection persistence failure cannot acknowledge or consume a confirmation", async () => {
  const f = await setup();
  try {
    const intent = await f.prepare();
    f.fixture.database
      .execRaw(`CREATE TRIGGER fail_projection BEFORE INSERT ON ban_case_operation_projections
      BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END;`);
    await assert.rejects(f.service.confirm(intent.id, "guild-1", "moderator"));
    assert.equal((await f.store.list("guild-1")).length, 0);
    assert.equal(
      f.fixture.database.query<{ operation_id: string | null }>(
        "SELECT operation_id FROM ban_case_confirmations WHERE id = ?",
        intent.id,
      )[0]?.operation_id,
      null,
    );
    assert.equal(f.requests.length, 0);
    f.fixture.database.execRaw("DROP TRIGGER fail_projection");
    assert.equal((await f.service.confirm(intent.id, "guild-1", "moderator")).state, "pending");
  } finally {
    f.fixture.close();
  }
});

test("independent notification delivery cannot invalidate a worker paused before transmission", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const mutate = f.provider.mutate;
    f.provider.mutate = async (intent, beforeSend, current) => {
      entered();
      await blocked;
      await mutate(intent, beforeSend, current);
    };
    f.clock.now += 60_000;
    const execution = f.service.process(op.id);
    await started;
    const revision = (await f.store.read(op.id))!.revision;
    await new BanCaseEnforcement(f.serviceOptions).processDue();
    assert.equal((await f.store.read(op.id))!.revision, revision);
    release();
    await execution;
    await f.tick();
    assert.equal((await f.store.read(op.id))!.state, "succeeded");
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  } finally {
    f.fixture.close();
  }
});

test("a replaced worker is fenced again after the possible-transmission marker", async () => {
  const f = await setup();
  try {
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    const mutate = f.provider.mutate;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    f.provider.mutate = (intent, beforeSend, current) =>
      mutate(
        intent,
        async () => {
          await beforeSend();
          entered();
          await blocked;
        },
        current,
      );
    f.clock.now += 60_000;
    const stale = f.service.process(op.id);
    await started;
    f.clock.now += 60_000;
    await new BanCaseEnforcement(f.serviceOptions).process(op.id);
    assert.equal((await f.store.read(op.id))!.state, "needs-attention");
    release();
    await assert.rejects(stale, /Stale operation/);
    assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
    await assert.rejects(f.confirm("unban"), /Unresolved work/);
  } finally {
    f.fixture.close();
  }
});

test("authentication, unsupported routes, malformed and partial ban lists fail before mutation", async () => {
  for (const response of [
    () => new Response("private details", { status: 403 }),
    () => new Response("private details", { status: 405 }),
    () => Response.json({ bans: [] }, { status: 206 }),
    () => Response.json({ bans: [] }, { headers: { Link: '</v1/bans?page=2>; rel="next"' } }),
    () => Response.json({ bans: [] }, { headers: { "Content-Range": "items 0-0/5" } }),
  ]) {
    const f = await setup();
    try {
      const transport = f.options.transport;
      f.options.transport = (url, init) =>
        init.method === "GET" && url.endsWith("/v1/bans")
          ? Promise.resolve(response())
          : transport(url, init);
      const op = await f.confirm();
      await f.tick();
      await f.tick();
      await f.tick();
      assert.equal((await f.store.read(op.id))!.state, "failed");
      assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
      assert.doesNotMatch(JSON.stringify(await f.store.list("guild-1")), /private details/);
    } finally {
      f.fixture.close();
    }
  }
});

test("2xx without an observed effect remains uncertain, including unavailable readback", async () => {
  const f = await setup();
  try {
    const transport = f.options.transport;
    f.options.transport = async (url, init) => {
      const response = await transport(url, init);
      if (init.method === "POST") f.control.banned = false;
      return response;
    };
    const op = await f.confirm();
    await f.tick();
    await f.tick();
    await f.tick();
    assert.equal((await f.store.read(op.id))!.state, "verifying");
    f.control.mode = "read-fail";
    await f.tick();
    assert.notEqual((await f.store.read(op.id))!.state, "succeeded");
    f.control.mode = "normal";
    await f.tick();
    assert.equal((await f.store.read(op.id))!.state, "needs-attention");
    await assert.rejects(f.confirm("unban"));
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  } finally {
    f.fixture.close();
  }
});

test("roles, entitlement and expiry are rechecked at the final unsent mutation boundary", async () => {
  for (const gate of ["role", "availability", "expiry"] as const) {
    const f = await setup();
    try {
      const op = await f.confirm();
      await f.tick();
      await f.tick();
      const mutate = f.provider.mutate;
      f.provider.mutate = (intent, beforeSend, current) => {
        if (gate === "role") f.control.authorized = false;
        if (gate === "availability") f.control.available = false;
        if (gate === "expiry") f.clock.now += 15 * 60_000;
        return mutate(intent, beforeSend, current);
      };
      await f.tick();
      await f.tick();
      assert.ok(["expired", "cancelled"].includes((await f.store.read(op.id))!.state));
      assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
    } finally {
      f.fixture.close();
    }
  }
});

for (const runtime of ["cloudflare", "portable"] as const)
  test(`${runtime} management adapter defaults off and does not invent a complete-list contract`, async () => {
    const f = await setup();
    try {
      f.policy.origins = f.policy.origins.map((origin) => ({ ...origin, runtime }));
      const disabled = new WardogsService({ ...f.options, runtime, mutationsEnabled: undefined });
      const intent = {
        ...f.input,
        id: "fixture",
        draft: false,
        subject: "76561198000000001",
        targetLabel: "Synthetic",
        generation: f.target.generation,
        physicalTarget: "synthetic-physical-server",
        approvalIdentity: "fixture",
        createdAtMs: f.clock.now,
        expiresAtMs: f.clock.now + 300000,
      };
      await assert.rejects(
        createWardogsBanProvider(disabled).mutate(intent, async () => {}),
        { code: "disabled" },
      );
      const enabled = new WardogsService({ ...f.options, runtime });
      delete f.policy.approvals[0]!.banContract;
      await assert.rejects(createWardogsBanProvider(enabled).observe(intent), { code: "disabled" });
      assert.equal(f.requests.length, 0);
    } finally {
      f.fixture.close();
    }
  });

test("runtime notification recovery edits one Discord item after a lost create response", async () => {
  const { createBanCaseEnforcementRuntime } =
    await import("../src/runtime/ban-case-enforcement-runtime");
  const f = await setup();
  const previousFetch = globalThis.fetch;
  try {
    await f.fixture.stores.banCases.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      forumChannelId: "forum",
      modRoleIds: ["staff-role"],
      updatedAtMs: 1,
    });
    await f.fixture.database.d1
      .prepare("INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES(?,?,?,?)")
      .bind("guild-1", "premium", "premium", 1)
      .run();
    const messages: { id: string; content: string }[] = [];
    let creates = 0;
    let edits = 0;
    let failEdits = true;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/members/moderator")) return Response.json({ roles: ["staff-role"] });
      assert.match(url, /\/channels\/thread\/messages/);
      if (init?.method === "POST") {
        creates++;
        const body = JSON.parse(String(init.body));
        assert.equal(body.enforce_nonce, true);
        assert.deepEqual(body.allowed_mentions, { parse: [] });
        messages.push({ id: "staff-item", content: body.content });
        throw new Error("Synthetic lost Discord acknowledgement");
      }
      if (init?.method === "PATCH") {
        edits++;
        if (failEdits) throw new Error("Synthetic notification outage");
        messages[0]!.content = JSON.parse(String(init.body)).content;
        return Response.json(messages[0]);
      }
      return Response.json(messages);
    };
    const service = createBanCaseEnforcementRuntime({
      stores: f.fixture.stores,
      discordBotToken: "synthetic-discord",
      wardogs: f.wardogs,
      banEnforcementStore: f.store,
      banCasesEnabled: true,
      now: () => f.clock.now,
      wait: f.serviceOptions.wait,
    })!;
    const intent = await service.prepare(f.input);
    const op = await service.confirm(intent.id, "guild-1", "moderator");
    for (let i = 0; i < 5; i++) {
      f.clock.now += 60000;
      await service.processDue();
    }
    assert.equal((await f.store.read(op.id))!.state, "succeeded");
    failEdits = false;
    f.clock.now += 60000;
    await service.processDue();
    assert.equal(creates, 1);
    assert.ok(edits > 1);
    assert.match(messages[0]!.content, /succeeded: verified desired state/);
    assert.doesNotMatch(messages[0]!.content, /private-password|Bearer|another administrator/);
    assert.equal((await f.store.projection(op.id))!.messageId, "staff-item");
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    f.fixture.close();
  }
});

test("one physical target/subject remains serialized across distinct Guild-owned aliases", async () => {
  const f = await setup();
  try {
    const active = await f.confirm();
    let alias = await f.wardogs.create("guild-2", "Same physical target", "test");
    alias = await f.wardogs.change({
      guildId: "guild-2",
      targetId: alias.id,
      generation: alias.generation,
      enabled: true,
      banCasesEnabled: true,
      secret: "other-private-password",
    });
    f.policy.approvals = [
      ...f.policy.approvals,
      { ...f.policy.approvals[0]!, targetId: alias.id, generation: alias.generation },
    ];
    await f.wardogs.verify({
      guildId: "guild-2",
      targetId: alias.id,
      generation: alias.generation,
      roster: false,
    });
    const existing = (await f.fixture.stores.banCases.readBanCase("guild-1", "case-1"))!;
    await f.fixture.stores.banCases.createBanCase({
      ...existing,
      guildId: "guild-2",
      caseId: "foreign-case",
    });
    for (const action of ["ban", "unban"] as const) {
      const intent = await f.service.prepare({
        ...f.input,
        guildId: "guild-2",
        caseId: "foreign-case",
        targetId: alias.id,
        action,
      });
      await assert.rejects(f.service.confirm(intent.id, "guild-2", "moderator"), /Unresolved work/);
    }
    assert.equal((await f.store.list("guild-2")).length, 0);
    assert.equal((await f.store.read(active.id))!.state, "pending");
  } finally {
    f.fixture.close();
  }
});

test("queued acknowledgements retain the opposite-action block even when another admin supplies desired state", async () => {
  const f = await setup();
  try {
    const transport = f.options.transport;
    f.options.transport = async (url, init) => {
      const response = await transport(url, init);
      return init.method === "POST" ? new Response(null, { status: 202 }) : response;
    };
    const op = await f.confirm();
    for (let i = 0; i < 4; i++) await f.tick();
    assert.equal((await f.store.read(op.id))!.state, "needs-attention");
    assert.equal((await f.store.read(op.id))!.after, true);
    await assert.rejects(f.confirm("unban"));
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  } finally {
    f.fixture.close();
  }
});

test("maintenance executes durable server work with Player Count disabled before unsent expiry", async () => {
  const { createRuntimeApp } = await import("../src/runtime/app");
  const f = await setup();
  try {
    const op = await f.confirm();
    f.clock.now += 5 * 60000;
    const runtime = createRuntimeApp({
      stores: f.fixture.stores,
      discordBotToken: "synthetic-discord",
      discordPublicKey: "unused",
      gateway: { start: async () => {}, status: async () => ({}) },
      services: { banCaseEnforcement: f.service },
      features: { ...ALL_FEATURES_ENABLED, playerCount: false },
    });
    await runtime.refreshPlayerCount();
    assert.equal((await f.store.read(op.id))!.state, "succeeded");
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    assert.ok(f.clock.now < op.expiresAtMs);
  } finally {
    f.fixture.close();
  }
});

function runtimeFor(f: Awaited<ReturnType<typeof setup>>) {
  return createBanCaseEnforcementRuntime({
    stores: f.fixture.stores,
    discordBotToken: "synthetic-discord",
    wardogs: f.wardogs,
    banEnforcementStore: f.store,
    banCasesEnabled: true,
    now: () => f.clock.now,
    wait: f.serviceOptions.wait,
  })!;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a timeout inside the mutation transport retains possible transmission and forbids replay", async () => {
  const f = await setup();
  try {
    const transport = f.options.transport;
    f.options.transport = async (url, init) => {
      if (init.method !== "GET") {
        f.requests.push({ url, method: init.method!, body: null });
        throw new WardogsError("timeout");
      }
      return transport(url, init);
    };
    const op = await f.confirm();
    for (let stage = 0; stage < 4; stage++) await f.tick();
    const uncertain = (await f.store.read(op.id))!;
    assert.equal(uncertain.state, "needs-attention");
    assert.notEqual(uncertain.transmittedAtMs, null);
    f.clock.now = op.expiresAtMs + 1;
    await new BanCaseEnforcement(f.serviceOptions).process(op.id);
    assert.equal((await f.store.read(op.id))!.transmittedAtMs, uncertain.transmittedAtMs);
    assert.equal(f.requests.filter((r) => r.method !== "GET").length, 1);
    await assert.rejects(f.confirm("unban"), /Unresolved work/);
  } finally {
    f.fixture.close();
  }
});

for (const recovery of ["retry", "expiry", "attempt limit"] as const)
  test(`slow successful runtime authorization stays known-unsent until ${recovery}`, async () => {
    const f = await setup();
    const previousFetch = globalThis.fetch;
    try {
      await f.fixture.stores.banCases.upsertConfig({
        guildId: "guild-1",
        enabled: true,
        forumChannelId: "forum",
        modRoleIds: ["staff-role"],
        updatedAtMs: 1,
      });
      await f.fixture.database.d1
        .prepare("INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES(?,?,?,?)")
        .bind("guild-1", "premium", "premium", 1)
        .run();
      let slow = true;
      globalThis.fetch = async (input) => {
        assert.match(String(input), /\/guilds\/guild-1\/members\/moderator$/);
        if (slow) f.clock.now += 1001;
        return Response.json({ roles: ["staff-role"] });
      };
      const action = recovery === "expiry" ? "unban" : "ban";
      f.control.banned = action === "unban";
      let runtime = runtimeFor(f);
      const intent = await runtime.prepare({ ...f.input, action });
      const op = await runtime.confirm(intent.id, "guild-1", "moderator");
      const step = async () => {
        f.clock.now = Math.max(f.clock.now, (await f.store.read(op.id))!.nextAtMs);
        await runtime.process(op.id);
      };
      for (let stage = 0; stage < 3; stage++) await step();
      const unsent = (await f.store.read(op.id))!;
      assert.equal(unsent.state, "pending");
      assert.equal(unsent.outcome, "pre-send retry scheduled");
      assert.equal(unsent.transmittedAtMs, null);
      assert.equal(unsent.acknowledgedAtMs, null);
      assert.equal(unsent.attempts, 1);
      assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
      runtime = runtimeFor(f); // Recover using persisted state, without the old consumer.
      if (recovery === "retry") {
        slow = false;
        for (let stage = 0; stage < 4; stage++) await step();
        assert.equal((await f.store.read(op.id))!.state, "succeeded");
        assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
      } else {
        if (recovery === "expiry") {
          f.clock.now = op.expiresAtMs;
          await step();
        } else {
          for (let attempt = 1; attempt < 5; attempt++)
            for (let stage = 0; stage < 3; stage++) await step();
          await step();
        }
        const result = (await f.store.read(op.id))!;
        assert.equal(result.state, recovery === "expiry" ? "expired" : "failed");
        assert.equal(result.attempts, recovery === "expiry" ? 1 : 5);
        assert.equal(result.transmittedAtMs, null);
        assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
        const reverse = await runtime.prepare({
          ...f.input,
          action: action === "ban" ? "unban" : "ban",
        });
        assert.equal((await runtime.confirm(reverse.id, "guild-1", "moderator")).state, "pending");
      }
    } finally {
      globalThis.fetch = previousFetch;
      f.fixture.close();
    }
  });

for (const action of ["ban", "unban"] as const)
  for (const timing of ["before dispatch", "after dispatch"] as const)
    test(`runtime target change ${timing} preserves ${action} transmission evidence`, async () => {
      const f = await setup();
      const previousFetch = globalThis.fetch;
      try {
        await f.fixture.stores.banCases.upsertConfig({
          guildId: "guild-1",
          enabled: true,
          forumChannelId: "forum",
          modRoleIds: ["staff-role"],
          updatedAtMs: 1,
        });
        await f.fixture.database.d1
          .prepare(
            "INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES(?,?,?,?)",
          )
          .bind("guild-1", "premium", "premium", 1)
          .run();
        globalThis.fetch = async (input) => {
          assert.match(String(input), /\/guilds\/guild-1\/members\/moderator$/);
          return Response.json({ roles: ["staff-role"] });
        };
        f.control.banned = action === "unban";
        const runtime = runtimeFor(f);
        const intent = await runtime.prepare({ ...f.input, action });
        const op = await runtime.confirm(intent.id, "guild-1", "moderator");
        const step = async () => {
          f.clock.now = Math.max(f.clock.now, (await f.store.read(op.id))!.nextAtMs);
          await runtime.process(op.id);
        };
        await step();
        await step();
        let target = f.target;
        let changed = false;
        const disableTarget = async () => {
          changed = true;
          target = await f.wardogs.change({
            guildId: "guild-1",
            targetId: target.id,
            generation: target.generation,
            banCasesEnabled: false,
          });
        };
        if (timing === "before dispatch") {
          const save = f.store.save;
          f.store.save = async (candidate, revision) => {
            const saved = await save(candidate, revision);
            if (saved && !changed && candidate.transmittedAtMs !== null) await disableTarget();
            return saved;
          };
        } else {
          const transport = f.options.transport;
          f.options.transport = async (url, init) => {
            const response = await transport(url, init);
            if (!changed && init.method !== "GET") await disableTarget();
            return response;
          };
        }
        await step();
        assert.equal(changed, true);
        const currentTarget = (await f.options.store.read("guild-1", target.id))!;
        assert.equal(currentTarget.generation, target.generation);
        assert.equal(currentTarget.banCasesEnabled, false);
        assert.equal(currentTarget.verifiedGeneration, null);
        assert.equal(currentTarget.diagnostic, null); // Old diagnostics cannot overwrite the new target.
        const after = (await f.store.read(op.id))!;
        if (timing === "before dispatch") {
          assert.equal(after.state, "failed");
          assert.equal(after.outcome, "disabled");
          assert.equal(after.transmittedAtMs, null);
        } else {
          assert.equal(after.state, "verifying");
          assert.notEqual(after.transmittedAtMs, null);
          await step();
          assert.equal((await f.store.read(op.id))!.state, "needs-attention");
        }
        assert.equal(after.acknowledgedAtMs, null);
        // Restore and verify the real target through its admin configuration seam.
        target = await f.wardogs.change({
          guildId: "guild-1",
          targetId: target.id,
          generation: target.generation,
          banCasesEnabled: true,
        });
        f.policy.approvals[0]!.generation = target.generation;
        f.clock.now += 60_001;
        await f.wardogs.verify({
          guildId: "guild-1",
          targetId: target.id,
          generation: target.generation,
          roster: false,
        });
        f.clock.now = op.expiresAtMs + 60_001;
        const restarted = runtimeFor(f);
        await restarted.process(op.id);
        const reverse = await restarted.prepare({
          ...f.input,
          action: action === "ban" ? "unban" : "ban",
        });
        if (timing === "before dispatch") {
          assert.equal((await f.store.read(op.id))!.state, "failed");
          assert.equal(
            (await restarted.confirm(reverse.id, "guild-1", "moderator")).state,
            "pending",
          );
        } else {
          assert.equal((await f.store.read(op.id))!.state, "needs-attention");
          assert.equal((await f.store.read(op.id))!.transmittedAtMs, after.transmittedAtMs);
          await assert.rejects(
            restarted.confirm(reverse.id, "guild-1", "moderator"),
            /Unresolved work/,
          );
        }
        assert.equal(
          f.requests.filter((r) => r.method !== "GET").length,
          timing === "before dispatch" ? 0 : 1,
        );
      } finally {
        globalThis.fetch = previousFetch;
        f.fixture.close();
      }
    });

for (const race of [
  "completed",
  "lost PATCH response",
  "completion pending",
  "repair CAS",
] as const)
  test(`runtime repairs a stale Discord PATCH after cancellation: ${race}`, async () => {
    const f = await setup();
    const previousFetch = globalThis.fetch;
    const oldStarted = deferred(),
      oldRelease = deferred();
    const newStarted = deferred(),
      newRelease = deferred();
    try {
      const op = await f.confirm();
      let content = "",
        creates = 0,
        patches = 0,
        delayOld = false;
      globalThis.fetch = async (input, init) => {
        assert.match(String(input), /\/channels\/thread\/messages/);
        const body = JSON.parse(String(init?.body));
        if (init?.method === "POST") creates++;
        else {
          assert.equal(init?.method, "PATCH");
          patches++;
          if (delayOld) {
            delayOld = false;
            oldStarted.resolve();
            await oldRelease.promise;
            content = body.content;
            if (race === "lost PATCH response") throw new Error("Synthetic lost PATCH response");
          }
        }
        content = body.content;
        return Response.json({ id: "same-item", content });
      };
      const old = runtimeFor(f),
        latest = runtimeFor(f);
      await old.projectDue();
      await f.service.process(op.id);
      delayOld = true;
      const oldWork = old.projectDue();
      await oldStarted.promise;
      await f.service.cancel(op.id, "guild-1", "moderator");
      const cancelled = (await f.store.read(op.id))!;
      f.clock.now += 60_001;
      const saveProjection = f.store.saveProjection;
      let pauseCompletion = race === "completion pending" || race === "repair CAS";
      let newWork: Promise<void>;
      f.store.saveProjection = async (projection, token) => {
        if (pauseCompletion && projection.notificationRevision === cancelled.revision) {
          pauseCompletion = false;
          newStarted.resolve();
          await newRelease.promise;
        } else if (race === "repair CAS" && projection.notificationRevision === 0) {
          // Finish the newer claim between the repair's read and conditional save.
          newRelease.resolve();
          await newWork;
        }
        return saveProjection(projection, token);
      };
      newWork = latest.projectDue();
      if (race === "completed" || race === "lost PATCH response") await newWork;
      else await newStarted.promise;
      assert.match(content, /cancelled: cancelled by staff/);
      oldRelease.resolve();
      await oldWork;
      assert.match(content, /pending: capability verified/);
      if (race === "completion pending") {
        // Repair retains the active lease; it must also fence this late completion.
        assert.equal((await f.store.notifications(f.clock.now)).length, 0);
        newRelease.resolve();
      }
      await newWork;
      f.clock.now += 60_001;
      assert.equal((await f.store.notifications(f.clock.now)).length, 1);
      await runtimeFor(f).projectDue();
      assert.match(content, /cancelled: cancelled by staff/);
      assert.equal(creates, 1);
      assert.equal(patches, 3);
      assert.deepEqual(await f.store.read(op.id), cancelled);
      assert.equal((await f.store.projection(op.id))!.notificationRevision, cancelled.revision);
      assert.equal((await f.store.notifications(f.clock.now)).length, 0);
      assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
    } finally {
      oldRelease.resolve();
      newRelease.resolve();
      globalThis.fetch = previousFetch;
      f.fixture.close();
    }
  });

test("runtime retries local notification preparation failure before marking a possible create", async () => {
  const f = await setup();
  const previousFetch = globalThis.fetch;
  try {
    const op = await f.confirm();
    const cases = f.fixture.stores.banCases;
    const read = cases.readBanCase.bind(cases);
    let fail = true,
      creates = 0;
    cases.readBanCase = async (...args) => {
      if (fail) throw new Error("Synthetic local case read failure");
      return read(...args);
    };
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /\/channels\/thread\/messages$/);
      assert.equal(init?.method, "POST");
      assert.equal((await f.store.projection(op.id))!.notificationStarted, true);
      creates++;
      return Response.json({ id: "same-item" });
    };
    await runtimeFor(f).projectDue();
    assert.equal(creates, 0);
    assert.equal(Boolean((await f.store.projection(op.id))!.notificationStarted), false);
    fail = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      f.clock.now += 60_001;
      await runtimeFor(f).projectDue();
    }
    assert.equal(creates, 1);
    assert.equal((await f.store.projection(op.id))!.messageId, "same-item");
    assert.equal((await f.store.notifications(f.clock.now)).length, 0);
    assert.deepEqual(await f.store.read(op.id), op);
    assert.equal(f.requests.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    f.fixture.close();
  }
});

test("a notification worker losing its claim during local preparation cannot create a second item", async () => {
  const f = await setup();
  const previousFetch = globalThis.fetch;
  const started = deferred(),
    release = deferred();
  try {
    const op = await f.confirm();
    const cases = f.fixture.stores.banCases;
    const read = cases.readBanCase.bind(cases);
    let delay = true,
      creates = 0;
    cases.readBanCase = async (...args) => {
      if (delay) {
        delay = false;
        started.resolve();
        await release.promise;
      }
      return read(...args);
    };
    globalThis.fetch = async (_input, init) => {
      if (init?.method === "POST") creates++;
      else assert.equal(init?.method, "PATCH");
      return Response.json({ id: "same-item" });
    };
    const oldWork = runtimeFor(f).projectDue();
    await started.promise;
    assert.equal(Boolean((await f.store.projection(op.id))!.notificationStarted), false);
    f.clock.now += 60_001;
    await runtimeFor(f).projectDue();
    assert.equal(creates, 1);
    release.resolve();
    await oldWork;
    await runtimeFor(f).projectDue();
    assert.equal(creates, 1);
    assert.equal((await f.store.projection(op.id))!.messageId, "same-item");
    assert.deepEqual(await f.store.read(op.id), op);
  } finally {
    release.resolve();
    globalThis.fetch = previousFetch;
    f.fixture.close();
  }
});

test("an ambiguous notification create without a recoverable item is never blindly repeated", async () => {
  const f = await setup();
  const previousFetch = globalThis.fetch;
  try {
    const op = await f.confirm();
    let creates = 0,
      searches = 0;
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /\/channels\/thread\/messages/);
      if (init?.method === "POST") {
        assert.equal((await f.store.projection(op.id))!.notificationStarted, true);
        creates++;
        throw new Error("Synthetic ambiguous create response");
      }
      assert.equal(init?.method, "GET");
      searches++;
      return Response.json([]);
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      await runtimeFor(f).projectDue();
      f.clock.now += 60_001;
    }
    assert.equal(creates, 1);
    assert.equal(searches, 3);
    assert.equal((await f.store.projection(op.id))!.notificationRevision, 0);
    assert.deepEqual(await f.store.read(op.id), op);
  } finally {
    globalThis.fetch = previousFetch;
    f.fixture.close();
  }
});
