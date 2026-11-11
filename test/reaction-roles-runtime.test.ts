import { gatewayEnvelope } from "./support/gateway-envelope";
import assert from "node:assert/strict";
import test from "node:test";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createReactionRolesAdminRoutes } from "../src/runtime/admin-routes/reaction-roles";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { allowAllAdminAccess } from "./helpers/admin-api";
import { createDiscordReactionRoleOperations } from "../src/discord/reaction-roles";
import { reactionRoleGatewayHandler } from "../src/runtime/gateway-events/handlers/reaction-roles";
import { processGatewayEventQueueMessages } from "./support/gateway-event-consumer";
import type { Env } from "./support/test-env";
import type { TicketPanelConfig } from "../src/types";
import { ReactionRoleService } from "../src/services/reaction-role-service";
import type {
  GatewayEventCapabilities,
  GatewayEventEnvelope,
} from "../src/runtime/gateway-events/contracts";

const settings = {
  channelId: "200",
  title: "Games",
  description: "Choose your games.",
  options: [{ emoji: "🟢", roleId: "300", label: "DayZ" }],
};

function ticketPanel(panelId = "main", supportRoleId = "600"): TicketPanelConfig {
  return {
    guildId: "100",
    panelId,
    panelName: panelId,
    panelChannelId: "200",
    categoryChannelId: "201",
    transcriptChannelId: "202",
    panelEmoji: null,
    panelTitle: "Support",
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: 2,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId,
        channelNamePrefix: "support",
        questions: [],
        limitExclusion: false,
        responseRules: [],
      },
    ],
  };
}

test("reaction-role protection reads current ticket panels, including empty and multiple panels", async (t) => {
  const f = createProductionRuntimeStores();
  t.after(f.close);
  await f.stores.tickets!.upsertTicketPanelConfig(ticketPanel());
  await f.stores.tickets!.upsertTicketPanelConfig(ticketPanel("secondary", "601"));
  await f.stores.tickets!.upsertTicketPanelConfig({ ...ticketPanel("empty"), ticketTypes: [] });
  assert.deepEqual(
    await f.stores.reactionRoles!.readRestrictedRoleIds("100"),
    new Set(["600", "601"]),
  );
  assert.deepEqual(await f.stores.reactionRoles!.readRestrictedRoleIds("101"), new Set());
});

test("malformed ticket protection fails deliberately for invalid wrappers and role IDs", async (t) => {
  const f = createProductionRuntimeStores();
  t.after(f.close);
  await f.stores.tickets!.upsertTicketPanelConfig(ticketPanel());
  for (const payload of [
    "",
    "{",
    "null",
    "{}",
    '{"ticketTypes":{}}',
    '{"ticketTypes":[{}]}',
    '[{"supportRoleId":123}]',
    '{"ticketTypes":[null]}',
  ]) {
    await f.database.d1
      .prepare("UPDATE ticket_panels SET ticket_types_json = ? WHERE guild_id = ?")
      .bind(payload, "100")
      .run();
    await assert.rejects(() => f.stores.reactionRoles!.readRestrictedRoleIds("100"));
  }
});

test("reaction-role API publishes through Discord, enforces guild/workspace access, and honors the feature switch", async (t) => {
  const f = createProductionRuntimeStores();
  t.after(f.close);
  await f.stores.tickets!.upsertTicketPanelConfig(ticketPanel());
  let discordCalls = 0;
  let postCount = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    discordCalls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bot test-token");
    const url = new URL(String(input));
    if (url.pathname.endsWith("/guilds/100/emojis")) return Response.json([]);
    if (url.pathname.endsWith("/guilds/100/channels"))
      return Response.json([{ id: "200", name: "welcome", type: 0, parent_id: null, position: 0 }]);
    if (url.pathname.endsWith("/guilds/100/roles"))
      return Response.json([
        { id: "100", name: "@everyone", permissions: "68672", position: 0 },
        { id: "400", name: "HAF", permissions: String(1n << 28n), position: 10 },
        { id: "300", name: "DayZ", permissions: "0", position: 1 },
        { id: "301", name: "Europe", permissions: "0", position: 2 },
      ]);
    if (url.pathname.endsWith("/members/900"))
      return Response.json({ user: { id: "900" }, roles: ["400"] });
    if (url.pathname.endsWith("/channels/200/messages") && init?.method === "POST") {
      postCount++;
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      assert.equal(body.enforce_nonce, true);
      return Response.json({
        id: String(499 + postCount),
        channel_id: "200",
        content: body.content,
      });
    }
    if (url.pathname.includes("/reactions/") && init?.method === "PUT")
      return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/messages/500") && init?.method === "PATCH")
      return Response.json({ id: "500", channel_id: "200", content: "" });
    if (url.pathname.endsWith("/messages/500") && init?.method === "DELETE")
      return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/messages/501") && init?.method === "DELETE")
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected Discord call: ${init?.method} ${url}`);
  };
  const routes = createReactionRolesAdminRoutes({
    stores: f.stores,
    discordBotToken: "unused-standard-token",
    discordBotUserId: "unused-standard-bot",
    resolveGuildBotIdentity: async (guildId) => {
      assert.equal(guildId, "100");
      return { token: "test-token", userId: "900" };
    },
    adminAccess: allowAllAdminAccess,
  });
  const options = {
    stores: f.stores,
    features: ALL_FEATURES_ENABLED,
    adminAccess: allowAllAdminAccess,
  };
  const request = (path: string, method: string, body?: object) =>
    new Request(`https://admin.example/admin/api/reaction-roles${path}`, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  const scope = { guildId: "100", workspaceId: "workspace-1" };
  const resourcesResponse = await dispatchAdminRoute(
    routes,
    request("/resources?guildId=100&workspaceId=workspace-1", "GET"),
    options,
  );
  assert.equal(resourcesResponse?.status, 200);
  assert.deepEqual(((await resourcesResponse!.json()) as { textChannels: object[] }).textChannels, [
    { id: "200", name: "welcome" },
  ]);
  const saved = await dispatchAdminRoute(
    routes,
    request("", "POST", { ...scope, settings }),
    options,
  );
  assert.equal(saved?.status, 200);
  assert.equal((await f.stores.reactionRoles!.readPanel("100"))?.enabled, false);
  const published = await dispatchAdminRoute(routes, request("/publish", "POST", scope), options);
  assert.equal(published?.status, 200);
  assert.equal((await f.stores.reactionRoles!.readPanel("100"))?.enabled, true);
  assert.equal(postCount, 1);

  const secondary = await dispatchAdminRoute(
    routes,
    request("", "POST", {
      ...scope,
      panelId: null,
      settings: {
        ...settings,
        title: "Regions",
        options: [{ emoji: "🟠", roleId: "301", label: "Europe" }],
      },
    }),
    options,
  );
  assert.equal(secondary?.status, 200);
  const secondaryId = ((await secondary!.json()) as { panel: { id: string } }).panel.id;
  assert.equal(
    (
      await dispatchAdminRoute(
        routes,
        request("/publish", "POST", { ...scope, panelId: secondaryId }),
        options,
      )
    )?.status,
    200,
  );
  assert.equal((await f.stores.reactionRoles!.readPanel("100", secondaryId))?.messageId, "501");
  assert.equal(
    (
      await dispatchAdminRoute(
        routes,
        request("/enabled", "POST", { ...scope, panelId: secondaryId, enabled: false }),
        options,
      )
    )?.status,
    200,
  );
  assert.equal((await f.stores.reactionRoles!.readPanel("100"))?.enabled, true);
  assert.equal((await f.stores.reactionRoles!.readPanel("100", secondaryId))?.enabled, false);
  const listed = await dispatchAdminRoute(routes, request("?guildId=100", "GET"), options);
  assert.equal(((await listed!.json()) as { panels: unknown[] }).panels.length, 2);

  const before = discordCalls;
  const deniedOptions = {
    ...options,
    adminAccess: {
      authorize: async (
        _request: Request,
        access: { guildId?: string | null; workspaceId?: string | null },
      ) => {
        assert.equal(access.guildId, "100");
        assert.equal(access.workspaceId, "wrong-workspace");
        return {
          ok: false as const,
          error: { _tag: "Forbidden" as const, message: "Guild is not linked to this workspace." },
        };
      },
    },
  };
  for (const [path, method, body] of [
    ["?guildId=100&workspaceId=wrong-workspace", "GET", undefined],
    ["/resources?guildId=100&workspaceId=wrong-workspace", "GET", undefined],
    ["/publish", "POST", { guildId: "100", workspaceId: "wrong-workspace" }],
    ["", "DELETE", { guildId: "100", workspaceId: "wrong-workspace" }],
  ] as const)
    assert.equal(
      (await dispatchAdminRoute(routes, request(path, method, body), deniedOptions))?.status,
      403,
    );
  assert.equal(discordCalls, before);
  const disabled = await dispatchAdminRoute(routes, request("/publish", "POST", scope), {
    ...options,
    features: { ...ALL_FEATURES_ENABLED, reactionRoles: false },
  });
  assert.equal(disabled?.status, 404);
  assert.equal(discordCalls, before);
  assert.equal(
    (await dispatchAdminRoute(routes, request("?guildId=101", "GET"), options))?.status,
    200,
  );
  assert.equal((await dispatchAdminRoute(routes, request("", "GET"), options))?.status, 400);
  assert.equal(
    (
      await dispatchAdminRoute(
        routes,
        request("", "POST", { ...scope, settings: { ...settings, options: [] } }),
        options,
      )
    )?.status,
    400,
  );
  assert.equal(
    (
      await dispatchAdminRoute(
        routes,
        request("", "DELETE", { ...scope, panelId: secondaryId }),
        options,
      )
    )?.status,
    200,
  );
  assert.equal(
    (await dispatchAdminRoute(routes, request("", "DELETE", scope), options))?.status,
    200,
  );
  assert.equal(await f.stores.reactionRoles!.readPanel("100"), null);
});

test("Discord reaction lookup checks the exact member across normal and super reactions", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: URL[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bot white-label-token");
    assert.equal(url.searchParams.get("after"), "799");
    assert.equal(url.searchParams.get("limit"), "1");
    return Response.json(url.searchParams.get("type") === "1" ? [{ id: "800" }] : [{ id: "801" }]);
  };
  const discord = createDiscordReactionRoleOperations("white-label-token");
  assert.equal(await discord.hasReaction("200", "500", "game:123", "800"), true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].pathname, /game%3A123/);
});

test("Gateway reaction roles use the envelope bot identity and the operation receipt runner", async () => {
  const seen: string[] = [];
  const capabilities = {
    env: { BOT_USER_ID: "standard-bot" },
    features: ALL_FEATURES_ENABLED,
    stores: { reactionRole: { readPanel: async () => null } },
    discord: { reactionRoles: {} },
    operations: {
      run: async (key: string, run: () => Promise<void>) => {
        seen.push(key);
        await run();
        return true;
      },
    },
  } as unknown as GatewayEventCapabilities;
  const envelope: GatewayEventEnvelope = {
    version: 2,
    eventKey: "reaction-event",
    sessionId: "session",
    sequence: 1,
    type: "MESSAGE_REACTION_ADD",
    botUserId: "900",
    data: { guild_id: "100", user_id: "900", emoji: { name: "🟢" } },
  };
  await reactionRoleGatewayHandler.handle(capabilities, envelope);
  assert.deepEqual(seen, ["reaction-roles:reconcile"]);
  assert.equal(
    reactionRoleGatewayHandler.isEnabled?.(
      { ...capabilities, features: { ...ALL_FEATURES_ENABLED, reactionRoles: false } },
      envelope,
    ),
    false,
  );
});

test("ticket-panel storage allows publication and queued grant/removal after a role becomes unsafe", async (t) => {
  const f = createProductionRuntimeStores();
  t.after(f.close);
  await f.stores.tickets!.upsertTicketPanelConfig(ticketPanel());
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let removals = 0;
  let grants = 0;
  let selected = true;
  let staffPermissions = "0";
  const roles = new Set(["301"]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bot test-token");
    if (url.pathname.endsWith("/guilds/100/channels"))
      return Response.json([{ id: "200", name: "welcome", type: 0, parent_id: null, position: 0 }]);
    if (url.pathname.endsWith("/guilds/100/roles"))
      return Response.json([
        { id: "100", name: "@everyone", position: 0, permissions: "68672" },
        { id: "400", name: "HAF", position: 10, permissions: String(1n << 28n) },
        { id: "300", name: "DayZ", position: 1, permissions: staffPermissions },
        { id: "600", name: "Support", position: 2, permissions: "0" },
        { id: "601", name: "Legacy support", position: 3, permissions: "0" },
      ]);
    if (url.pathname.endsWith("/members/900")) return Response.json({ roles: ["400"] });
    if (url.pathname.endsWith("/members/800"))
      return Response.json({ user: { id: "800" }, roles: [...roles] });
    if (url.pathname.endsWith("/channels/200/messages") && init?.method === "POST")
      return Response.json({ id: "500", channel_id: "200", content: "" });
    if (url.pathname.includes("/reactions/"))
      return init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json(selected ? [{ id: "800" }] : []);
    if (url.pathname.endsWith("/members/800/roles/300") && init?.method === "PUT") {
      grants++;
      roles.add("300");
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/members/800/roles/300") && init?.method === "DELETE") {
      removals++;
      roles.delete("300");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const env = {
    HAF_DB: f.database.d1,
    DISCORD_BOT_TOKEN: "test-token",
    BOT_USER_ID: "900",
    DISCORD_PUBLIC_KEY: "test-public-key",
    GATEWAY_SESSION_DO: {} as Env["GATEWAY_SESSION_DO"],
    GATEWAY_EVENT_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    DISABLE_SUGGESTIONS: "true",
    DISABLE_BLOCKLIST: "true",
  } satisfies Env;
  const service = new ReactionRoleService(
    f.stores.reactionRoles!,
    createDiscordReactionRoleOperations("test-token"),
    "900",
  );
  for (const supportRoleId of ["600", "601"]) {
    if (supportRoleId === "601") {
      await f.stores.tickets!.upsertTicketPanelConfig(ticketPanel("secondary", "601"));
    }
    await assert.rejects(
      () =>
        service.save("100", {
          ...settings,
          options: [{ ...settings.options[0], roleId: supportRoleId }],
        }),
      /ticket/,
    );
  }
  await service.save("100", settings);
  await service.publish("100");
  const message = gatewayEnvelope({
    type: "MESSAGE_REACTION_REMOVE",
    data: {
      guild_id: "100",
      channel_id: "200",
      message_id: "500",
      user_id: "800",
      emoji: { name: "🟢", id: null },
    },
  });
  const logger = {
    error: (...args) => assert.fail(JSON.stringify(args)),
  } satisfies Parameters<typeof processGatewayEventQueueMessages>[2];
  await processGatewayEventQueueMessages(
    [gatewayEnvelope({ ...message, type: "MESSAGE_REACTION_ADD" })],
    env,
    logger,
  );
  assert.equal(grants, 1);
  assert.deepEqual([...roles].sort(), ["300", "301"]);
  staffPermissions = "8";
  selected = false;
  await processGatewayEventQueueMessages([message, message], env, logger);
  assert.equal(removals, 1);
  assert.deepEqual([...roles], ["301"]);
  assert.ok(
    f.database.query(
      "SELECT handler_key FROM gateway_event_operations WHERE handler_key = 'reaction-roles:reconcile' AND state = 'completed'",
    ).length > 0,
  );
});

test("the Gateway handler forwards event receipt time before reconciling a resumed panel", async (t) => {
  const f = createProductionRuntimeStores();
  t.after(f.close);
  const seedLease = { token: "seed", nowMs: Date.now() };
  await f.stores.reactionRoles!.claimLease("100", seedLease.token, seedLease.nowMs);
  await f.stores.reactionRoles!.savePanel(
    {
      ...settings,
      guildId: "100",
      id: "panel",
      botUserId: "900",
      messageId: "500",
      enabled: true,
      updatedAtMs: 3000,
      activatedAtMs: 3000,
      publishedOptions: settings.options,
    },
    seedLease,
  );
  await f.stores.reactionRoles!.releaseLease("100", seedLease.token);
  const capabilities = {
    env: { BOT_USER_ID: "900" },
    features: ALL_FEATURES_ENABLED,
    stores: { reactionRole: f.stores.reactionRoles },
    discord: { reactionRoles: {} },
    operations: {
      run: async (_key: string, run: () => Promise<void>) => {
        await run();
        return true;
      },
    },
  } as unknown as GatewayEventCapabilities;
  await reactionRoleGatewayHandler.handle(capabilities, {
    version: 2,
    eventKey: "paused-event",
    receivedAtMs: 2500,
    sessionId: "session",
    sequence: 1,
    type: "MESSAGE_REACTION_ADD",
    botUserId: "900",
    data: {
      guild_id: "100",
      user_id: "800",
      channel_id: "200",
      message_id: "500",
      emoji: { name: "🟢", id: null },
    },
  });
});
