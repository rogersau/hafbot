/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile through tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import type { RuntimeStores } from "../src/runtime/app-types";
import { createCloudflareOneTimeTokenStore } from "../src/runtime/cloudflare-one-time-token-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const guildId = "100";
const actorId = "200";
const botId = "300";
const sourceId = "400";
const targetId = "500";

test("channel permission copy denies unauthenticated HAF access before Discord fetch", async () => {
  const handler = createAdminApiHandler({
    stores: {} as RuntimeStores,
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => null,
    adminAccess: {
      authorize() {
        return Promise.resolve({
          ok: false as const,
          error: { _tag: "Unauthorized" as const, message: "Unauthorized" },
        });
      },
    },
  });
  const request = new Request(
    `https://example.test/admin/api/guilds/${guildId}/channel-permission-copy/resources`,
  );
  const response = await handler(request, new URL(request.url));
  assert.equal(response?.status, 401);
});

test("channel permission copy is write-gated, rejects injection, applies one safe PATCH, and rejects replay", async () => {
  const accessModes: string[] = [];
  const patches: Array<{ body: unknown; reason: string | null }> = [];
  const auditMessages: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = discordFetch(patches, undefined, auditMessages);
  const stores = routeStores("700");
  const handlerOptions = {
    stores,
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
    adminAccess: {
      authorize(_request: Request, requirement: { mode: string }) {
        accessModes.push(requirement.mode);
        return Promise.resolve({ ok: true as const });
      },
    },
  };
  const handler = createAdminApiHandler(handlerOptions);
  try {
    const invalid = await request(handler, "preview", {
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      mode: "exact",
      permission_overwrites: [{ id: guildId, type: 0, allow: "0", deny: "1024" }],
    });
    assert.equal(invalid.status, 400);

    const previewResponse = await request(handler, "preview", {
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      mode: "exact",
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as { previewToken: string };
    const applyResponse = await request(handler, "apply", {
      previewToken: preview.previewToken,
      confirmationTargetName: "target",
      permission_overwrites: [],
    });
    assert.equal(applyResponse.status, 400);

    const freshPreview = (await (
      await request(handler, "preview", {
        sourceChannelId: sourceId,
        targetChannelId: targetId,
        mode: "exact",
      })
    ).json()) as { previewToken: string };
    const applied = await request(handler, "apply", {
      previewToken: freshPreview.previewToken,
      confirmationTargetName: "target",
    });
    assert.equal(applied.status, 200);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0]?.body, {
      permission_overwrites: [{ id: guildId, type: 0, allow: "1024", deny: "0" }],
    });
    assert.match(patches[0]?.reason ?? "", /^HAF%20Bot%3A%20permissions%20copied/);
    assert.equal(auditMessages.length, 1);
    assert.match(JSON.stringify(auditMessages[0]), /Channel Permissions Copied/);
    assert.match(JSON.stringify(auditMessages[0]), /source/);
    assert.match(JSON.stringify(auditMessages[0]), /target/);
    const separateHandler = createAdminApiHandler(handlerOptions);
    const replay = await request(separateHandler, "apply", {
      previewToken: freshPreview.previewToken,
      confirmationTargetName: "target",
    });
    assert.equal(replay.status, 409);
    assert.equal(patches.length, 1);
    assert.ok(accessModes.every((mode) => mode === "write"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("channel permission copy keeps consumption final after a lost Discord response", async () => {
  const database = new SqliteD1Database();
  const patches: Array<{ body: unknown; reason: string | null }> = [];
  const originalFetch = globalThis.fetch;
  const provider = discordFetch(patches);
  globalThis.fetch = (async (input, init) => {
    const response = await provider(input, init);
    if (init?.method === "PATCH") throw new TypeError("response lost after commit");
    return response;
  }) as typeof fetch;
  const options = {
    stores: {
      ...routeStores(),
      oneTimeTokens: createCloudflareOneTimeTokenStore(database.d1),
    },
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
  };
  try {
    const handler = createAdminApiHandler(options);
    const previewResponse = await request(handler, "preview", {
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      mode: "exact",
    });
    assert.equal(previewResponse.status, 200);
    const { previewToken } = (await previewResponse.json()) as { previewToken: string };
    const body = { previewToken, confirmationTargetName: "target" };
    const failed = await request(handler, "apply", body);
    assert.ok(failed.status >= 400);
    assert.equal(patches.length, 1);

    // Reads deliberately retain the preview fingerprints: durable consumption must
    // reject replay even when a subsequent provider read has not observed the PATCH.
    globalThis.fetch = provider;
    const replay = await request(createAdminApiHandler(options), "apply", body);
    assert.equal(replay.status, 409);
    assert.equal(patches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

for (const checkpoint of ["concurrent apply", "lost consumption acknowledgement"] as const) {
  test(`channel permission copy retains durable admission after ${checkpoint}`, async () => {
    const database = new SqliteD1Database();
    const patches: Array<{ body: unknown; reason: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = discordFetch(patches);
    const durableTokens = createCloudflareOneTimeTokenStore(database.d1);
    const options = {
      stores: { ...routeStores(), oneTimeTokens: durableTokens },
      discordBotToken: "token",
      discordBotUserId: botId,
      configurationRevisionSigningSecret: "test signing secret long enough",
      readCustomerAdminSession: async () => ({
        user: { id: "session", discordUserId: actorId, name: "Admin" },
      }),
    };
    try {
      const handler = createAdminApiHandler(options);
      const previewResponse = await request(handler, "preview", {
        sourceChannelId: sourceId,
        targetChannelId: targetId,
        mode: "exact",
      });
      assert.equal(previewResponse.status, 200);
      const { previewToken } = (await previewResponse.json()) as { previewToken: string };
      const body = { previewToken, confirmationTargetName: "target" };
      if (checkpoint === "concurrent apply") {
        let arrivals = 0;
        let admit!: () => void;
        const bothArrived = new Promise<void>((resolve) => {
          admit = resolve;
        });
        const concurrentOptions = {
          ...options,
          stores: {
            ...options.stores,
            oneTimeTokens: {
              async consume(input: Parameters<typeof durableTokens.consume>[0]) {
                if (++arrivals === 2) admit();
                await bothArrived;
                return durableTokens.consume(input);
              },
            },
          },
        };
        const responses = await Promise.all([
          request(createAdminApiHandler(concurrentOptions), "apply", body),
          request(createAdminApiHandler(concurrentOptions), "apply", body),
        ]);
        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
        assert.equal(patches.length, 1);
      } else {
        const uncertainOptions = {
          ...options,
          stores: {
            ...options.stores,
            oneTimeTokens: {
              async consume(input: Parameters<typeof durableTokens.consume>[0]) {
                assert.equal(await durableTokens.consume(input), true);
                throw new Error("consumption acknowledgement lost after commit");
              },
            },
          },
        };
        const failed = await request(createAdminApiHandler(uncertainOptions), "apply", body);
        assert.equal(failed.status, 500);
        assert.equal(patches.length, 0);
      }
      const replay = await request(createAdminApiHandler(options), "apply", body);
      assert.equal(replay.status, 409);
      assert.equal(patches.length, checkpoint === "concurrent apply" ? 1 : 0);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });
}

test("channel permission copy rechecks Discord authority without consuming a denied preview", async () => {
  const database = new SqliteD1Database();
  const patches: Array<{ body: unknown; reason: string | null }> = [];
  const originalFetch = globalThis.fetch;
  const provider = discordFetch(patches);
  let authorized = true;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith(`/guilds/${guildId}`) && !authorized) {
      return Response.json({ id: guildId, name: "Guild", owner_id: "999" });
    }
    return provider(input, init);
  }) as typeof fetch;
  const options = {
    stores: { ...routeStores(), oneTimeTokens: createCloudflareOneTimeTokenStore(database.d1) },
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
  };
  try {
    const previewResponse = await request(createAdminApiHandler(options), "preview", {
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      mode: "exact",
    });
    assert.equal(previewResponse.status, 200);
    const { previewToken } = (await previewResponse.json()) as { previewToken: string };
    const body = { previewToken, confirmationTargetName: "target" };
    authorized = false;
    const denied = await request(createAdminApiHandler(options), "apply", body);
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { code: string }).code, "permission_denied");
    assert.equal(patches.length, 0);
    authorized = true;
    const applied = await request(createAdminApiHandler(options), "apply", body);
    assert.equal(applied.status, 200);
    assert.equal(patches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("channel permission copy rejects stale Discord state without mutation", async () => {
  const patches: Array<{ body: unknown; reason: string | null }> = [];
  const state = { targetDeny: "1024" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = discordFetch(patches, state);
  const handler = createAdminApiHandler({
    stores: routeStores(),
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
  });
  try {
    const preview = (await (
      await request(handler, "preview", {
        sourceChannelId: sourceId,
        targetChannelId: targetId,
        mode: "exact",
      })
    ).json()) as { previewToken: string };
    state.targetDeny = "2048";
    const response = await request(handler, "apply", {
      previewToken: preview.previewToken,
      confirmationTargetName: "target",
    });
    assert.equal(response.status, 409);
    const error = (await response.json()) as { code: string; staleReason: string };
    assert.equal(error.code, "stale_preview");
    assert.equal(error.staleReason, "target");
    assert.equal(patches.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("channel permission copy lets the central Admin mapper handle Discord rate limits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "rate limited", retry_after: 2 }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "2" },
    })) as typeof fetch;
  const handler = createAdminApiHandler({
    stores: routeStores(),
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
  });
  try {
    const request = new Request(
      `https://example.test/admin/api/guilds/${guildId}/channel-permission-copy/resources`,
    );
    const response = (await handler(request, new URL(request.url)))!;
    const error = (await response.json()) as { code: string; retryAfterSeconds: number };
    assert.equal(response.status, 429);
    assert.equal(error.code, "discord_rate_limited");
    assert.equal(error.retryAfterSeconds, 2);
    assert.equal(response.headers.get("retry-after"), "2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview uses Guild permissions when copied bits are denied on the target", async () => {
  const patches: Array<{ body: unknown; reason: string | null }> = [];
  const originalFetch = globalThis.fetch;
  const copiedBits =
    (1n << 6n) | // Add Reactions
    (1n << 10n) | // View Channel
    (1n << 20n) | // Connect
    (1n << 38n); // Send Messages In Threads
  const managementBits = (1n << 4n) | (1n << 10n) | (1n << 28n);
  globalThis.fetch = discordFetch(patches, { targetDeny: String(copiedBits) }, [], {
    botRolePermissions: String(copiedBits | managementBits),
    sourceOverwrites: [{ id: guildId, type: 0, allow: String(copiedBits), deny: "0" }],
  });
  const handler = createAdminApiHandler({
    stores: routeStores(),
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
  });
  try {
    const response = await request(handler, "preview", {
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      mode: "exact",
    });
    assert.equal(response.status, 200);
    const preview = (await response.json()) as { blockers: Array<{ code: string }> };
    assert.ok(
      preview.blockers.every((blocker) => blocker.code !== "bot_permission_bits_unsettable"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview and apply preserve HAF Bot recovery access explicitly", async () => {
  const patches: Array<{ body: unknown; reason: string | null }> = [];
  const originalFetch = globalThis.fetch;
  const required = (1n << 4n) | (1n << 10n) | (1n << 28n);
  globalThis.fetch = discordFetch(patches, { targetDeny: "0" }, [], {
    botRolePermissions: String(required),
    sourceOverwrites: [{ id: guildId, type: 0, allow: "0", deny: String(required) }],
  });
  const handler = createAdminApiHandler({
    stores: routeStores(),
    discordBotToken: "token",
    discordBotUserId: botId,
    configurationRevisionSigningSecret: "test signing secret long enough",
    readCustomerAdminSession: async () => ({
      user: { id: "session", discordUserId: actorId, name: "Admin" },
    }),
  });
  try {
    const previewResponse = await request(handler, "preview", {
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      mode: "exact",
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as {
      previewToken: string;
      blockers: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
      changes: Array<{ targetId: string; change: string }>;
    };
    assert.deepEqual(preview.blockers, []);
    assert.ok(preview.warnings.some((warning) => warning.code === "bot_access_preserved"));
    assert.ok(
      preview.changes.some((change) => change.targetId === botId && change.change === "added"),
    );

    const applied = await request(handler, "apply", {
      previewToken: preview.previewToken,
      confirmationTargetName: "target",
    });
    assert.equal(applied.status, 200);
    assert.deepEqual(patches[0]?.body, {
      permission_overwrites: [
        { id: guildId, type: 0, allow: "0", deny: String(required) },
        { id: botId, type: 1, allow: String(required), deny: "0" },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function request(
  handler: ReturnType<typeof createAdminApiHandler>,
  operation: "preview" | "apply",
  body: Record<string, unknown>,
) {
  const request = new Request(
    `https://example.test/admin/api/guilds/${guildId}/channel-permission-copy/${operation}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return handler(request, new URL(request.url)) as Promise<Response>;
}

function discordFetch(
  patches: Array<{ body: unknown; reason: string | null }>,
  state = { targetDeny: "1024" },
  auditMessages: unknown[] = [],
  options: {
    botRolePermissions?: string;
    sourceOverwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
  } = {},
): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      const headers = new Headers(init.headers);
      patches.push({
        body: JSON.parse(String(init.body)),
        reason: headers.get("X-Audit-Log-Reason"),
      });
      return Response.json(
        channel(targetId, "target", [{ id: guildId, type: 0, allow: "1024", deny: "0" }]),
      );
    }
    if (init?.method === "POST" && url.endsWith("/channels/700/messages")) {
      auditMessages.push(JSON.parse(String(init.body)));
      return Response.json({ id: "audit-message", channel_id: "700" });
    }
    if (url.endsWith(`/guilds/${guildId}`))
      return Response.json({ id: guildId, name: "Guild", owner_id: actorId });
    if (url.endsWith(`/guilds/${guildId}/channels`)) {
      return Response.json([
        channel(
          sourceId,
          "source",
          options.sourceOverwrites ?? [{ id: guildId, type: 0, allow: "1024", deny: "0" }],
        ),
        channel(targetId, "target", [{ id: guildId, type: 0, allow: "0", deny: state.targetDeny }]),
      ]);
    }
    if (url.endsWith(`/guilds/${guildId}/roles`)) {
      return Response.json([
        { id: guildId, name: "@everyone", permissions: "0", position: 0 },
        {
          id: "600",
          name: "Admin",
          permissions: options.botRolePermissions ?? "8",
          position: 1,
        },
      ]);
    }
    if (url.endsWith(`/members/${actorId}`))
      return Response.json({ user: { id: actorId }, roles: [] });
    if (url.endsWith(`/members/${botId}`))
      return Response.json({ user: { id: botId }, roles: ["600"] });
    return Response.json({ message: "missing" }, { status: 404 });
  }) as typeof fetch;
}

function channel(id: string, name: string, permission_overwrites: unknown[]) {
  return { id, name, type: 0, parent_id: null, position: 0, permission_overwrites };
}

function routeStores(auditChannelId = ""): RuntimeStores {
  const consumed = new Set<string>();
  return {
    oneTimeTokens: {
      async consume({ nonce }: { nonce: string }) {
        if (consumed.has(nonce)) return false;
        consumed.add(nonce);
        return true;
      },
    },
    guildAuditLog: {
      async readConfig() {
        return auditChannelId
          ? {
              guildId,
              auditChannelId,
              groupChannelIds: {},
              eventStates: { groups: {}, overrides: {} },
              updatedAtMs: 0,
            }
          : null;
      },
    },
  } as unknown as RuntimeStores;
}
