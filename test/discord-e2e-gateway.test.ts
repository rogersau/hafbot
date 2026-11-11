import { gatewayEnvelope } from "./support/gateway-envelope";
import assert from "node:assert/strict";
import test from "node:test";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createDiscordReactionRoleOperations } from "../src/discord/reaction-roles";
import { ReactionRoleService } from "../src/services/reaction-role-service";
import { processGatewayEventQueueMessages } from "./support/gateway-event-consumer";
import { readDiscordE2eActors } from "../src/runtime/discord-e2e-actors";
import type { Env } from "./support/test-env";
import { createDefaultMentionProtectionConfig } from "../src/services/mention-protection/message-handler";

const GUILD = "100000000000000001";
const TESTER = "100000000000000002";
const HAF = "100000000000000003";
const actors = () =>
  readDiscordE2eActors({
    STAGING_MODE: "true",
    DATABASE_URL: "postgresql://haf:local-only@localhost/haf_e2e_test",
    BOT_USER_ID: HAF,
    HAF_E2E_GUILD_ID: GUILD,
    HAF_E2E_BOT_USER_IDS: TESTER,
  });

test("Gateway message moderation uses tester views for creates and partial updates without processing other bots or guilds", async (t) => {
  const fixture = createProductionRuntimeStores({ botUserId: HAF });
  t.after(fixture.close);
  const foreignGuild = "100000000000000005";
  for (const guildId of [GUILD, foreignGuild]) {
    const config = createDefaultMentionProtectionConfig(guildId, 1000);
    config.adminEnabled = true;
    config.protectedAdminRoleIds = ["admin-role"];
    await fixture.stores.mentionProtection!.upsertConfig(config);
  }
  const sourceMessage = (id: string, userId = TESTER, guildId = GUILD) => ({
    id,
    guild_id: guildId,
    channel_id: "200",
    type: 0,
    author: { id: userId, bot: true },
    member: { roles: [] },
    content: "<@&admin-role> help",
    mention_roles: ["admin-role"],
    mentions: [],
    mention_everyone: false,
    attachments: [],
    timestamp: "2026-11-07T00:00:00.000Z",
  });
  const deleted: string[] = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/channels/200/messages") && init?.method === "POST")
      return Response.json({ id: "reply", channel_id: "200", content: "warning" });
    if (path.includes("/channels/200/messages/") && init?.method === "DELETE") {
      deleted.push(path.split("/").at(-1)!);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/channels/200/messages/501")) {
      const { guild_id: _guild, ...fetched } = sourceMessage("501");
      return Response.json(fetched);
    }
    if (path.includes("/members/"))
      return Response.json({ user: { id: path.split("/").at(-1), bot: true }, roles: [] });
    if (path.endsWith("/channels/200"))
      return Response.json({ id: "200", guild_id: GUILD, parent_id: null, type: 0 });
    throw new Error(`Unexpected Discord request: ${init?.method} ${path}`);
  };
  const env = {
    HAF_DB: fixture.database.d1,
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_PUBLIC_KEY: "test-key",
    BOT_USER_ID: HAF,
    GATEWAY_SESSION_DO: {} as Env["GATEWAY_SESSION_DO"],
    GATEWAY_EVENT_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    STAGING_MODE: "true",
    DISABLE_BLOCKLIST: "true",
    DISABLE_SUGGESTIONS: "true",
  } satisfies Env;
  const e2eEnv = { ...env, discordE2eActors: actors() };
  const event = (sequence: number, data: unknown, type = "MESSAGE_CREATE") =>
    gatewayEnvelope({
      sessionId: "message-session",
      sequence,
      type,
      data,
    });
  const logger = {
    error: (...args: unknown[]) => assert.fail(JSON.stringify(args)),
    info: () => {},
  };
  await processGatewayEventQueueMessages([event(1, sourceMessage("normal"))], env, logger);
  assert.deepEqual(deleted, []);
  const source = event(2, sourceMessage("500"));
  await processGatewayEventQueueMessages([source, source], e2eEnv, logger);
  assert.deepEqual(deleted, ["500"], "retry must not repeat the Discord deletion");
  await processGatewayEventQueueMessages(
    [
      event(3, sourceMessage("other-bot", "100000000000000004")),
      event(4, sourceMessage("self", HAF)),
      event(5, { ...sourceMessage("webhook"), webhook_id: "webhook-id" }),
      event(6, {
        ...sourceMessage("foreign", TESTER, foreignGuild),
        author: { id: TESTER, bot: false },
      }),
      event(
        7,
        { id: "501", guild_id: GUILD, channel_id: "200", content: "<@&admin-role> edited" },
        "MESSAGE_UPDATE",
      ),
    ],
    e2eEnv,
    logger,
  );
  assert.deepEqual(deleted, ["500", "501"]);
});

test("the Gateway grants and removes a tester bot's reaction role only in the E2E version", async (t) => {
  const fixture = createProductionRuntimeStores({ botUserId: HAF });
  t.after(fixture.close);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let selected = true;
  const roles = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/guilds/${GUILD}/channels`)) {
      return Response.json([{ id: "200", name: "games", type: 0, position: 0 }]);
    }
    if (url.pathname.endsWith(`/guilds/${GUILD}/roles`))
      return Response.json([
        { id: GUILD, name: "@everyone", permissions: "68672", position: 0 },
        { id: "400", name: "HAF", permissions: String(1n << 28n), position: 10 },
        { id: "300", name: "Game", permissions: "0", position: 1 },
      ]);
    if (url.pathname.endsWith(`/members/${HAF}`))
      return Response.json({ user: { id: HAF, bot: true }, roles: ["400"] });
    if (url.pathname.endsWith(`/members/${TESTER}`))
      return Response.json({ user: { id: TESTER, bot: true }, roles: [...roles] });
    if (url.pathname.endsWith("/channels/200/messages") && init?.method === "POST")
      return Response.json({ id: "500", channel_id: "200", content: "" });
    if (url.pathname.includes("/reactions/"))
      return init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json(selected ? [{ id: TESTER, bot: true }] : []);
    if (url.pathname.endsWith(`/members/${TESTER}/roles/300`)) {
      if (init?.method === "PUT") roles.add("300");
      else if (init?.method === "DELETE") roles.delete("300");
      else assert.fail(`Unexpected role method ${init?.method}`);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected Discord request: ${init?.method} ${url.pathname}`);
  };
  const service = new ReactionRoleService(
    fixture.stores.reactionRoles!,
    createDiscordReactionRoleOperations("test-token"),
    HAF,
  );
  await service.save(GUILD, {
    channelId: "200",
    title: "Games",
    description: "Choose",
    options: [{ emoji: "🟢", roleId: "300", label: "Game" }],
  });
  await service.publish(GUILD);
  const env = {
    HAF_DB: fixture.database.d1,
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_PUBLIC_KEY: "test-key",
    BOT_USER_ID: HAF,
    GATEWAY_SESSION_DO: {} as Env["GATEWAY_SESSION_DO"],
    GATEWAY_EVENT_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    STAGING_MODE: "true",
    DISABLE_BLOCKLIST: "true",
    DISABLE_SUGGESTIONS: "true",
  } satisfies Env;
  const event = (sequence: number) =>
    gatewayEnvelope({
      sessionId: "e2e-session",
      sequence,
      type: selected ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE",
      data: {
        guild_id: GUILD,
        channel_id: "200",
        message_id: "500",
        user_id: TESTER,
        member: { user: { id: TESTER, bot: true }, roles: [] },
        emoji: { id: null, name: "🟢" },
      },
    });
  const logger = { error: (...args: unknown[]) => assert.fail(JSON.stringify(args)) };
  await processGatewayEventQueueMessages([event(1)], env, logger);
  assert.equal(roles.has("300"), false, "production must continue ignoring bot members");
  const e2eEnv = { ...env, discordE2eActors: actors() };
  const sourceEvent = event(2);
  await processGatewayEventQueueMessages([sourceEvent], e2eEnv, logger);
  assert.equal(roles.has("300"), true, "the real member REST read must allow the named tester");
  assert.equal(sourceEvent.data.member.user.bot, true, "stored event identity must be preserved");
  selected = false;
  await processGatewayEventQueueMessages([event(3)], e2eEnv, logger);
  assert.equal(roles.has("300"), false);
});
