import assert from "node:assert/strict";
import test from "node:test";
import {
  reactionRoleMessage,
  reactionRoleSettingsSchema,
  parseReactionRoleEmoji,
  type ReactionRoleSettings,
} from "../src/reaction-roles";
import { ReactionRoleService } from "../src/services/reaction-role-service";
import { createCloudflareReactionRoleStore } from "../src/runtime/cloudflare-reaction-role-store";
import type { ReactionRoleDiscord } from "../src/discord/reaction-roles";
import type { GuildPermissionContext } from "../src/runtime/admin-permissions";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const settings: ReactionRoleSettings = {
  channelId: "200",
  title: "Choose your games",
  description: "React to unlock your game channels.",
  options: [
    { emoji: "🟢", roleId: "300", label: "DayZ" },
    { emoji: "🔵", roleId: "301", label: "Rust" },
  ],
};
const event = (overrides: object = {}) => ({
  guild_id: "100",
  channel_id: "200",
  message_id: "500",
  user_id: "800",
  emoji: { name: "🟢", id: null },
  ...overrides,
});

function fixture(
  now: () => number = Date.now,
  staffRoles?: Parameters<typeof createCloudflareReactionRoleStore>[1],
) {
  const database = new SqliteD1Database();
  const store = createCloudflareReactionRoleStore(database.d1, staffRoles);
  const context: GuildPermissionContext = {
    guildId: "100",
    botUserId: "900",
    channels: [{ id: "200", name: "welcome", type: 0, parent_id: null, position: 0 }],
    roles: [
      {
        id: "100",
        name: "@everyone",
        position: 0,
        permissions: String((1n << 10n) | (1n << 11n) | (1n << 6n) | (1n << 16n)),
      },
      { id: "400", name: "HAF", position: 10, permissions: String(1n << 28n) },
      { id: "300", name: "DayZ", position: 1, permissions: "0" },
      { id: "301", name: "Rust", position: 2, permissions: "0" },
    ],
    member: { user: { id: "900" }, roles: ["400"] },
  };
  const roles = new Set<string>();
  const reactions = new Set<string>();
  const changes: string[] = [];
  const messages: Parameters<ReactionRoleDiscord["createMessage"]>[1][] = [];
  const seeds: string[] = [];
  const discord: ReactionRoleDiscord = {
    loadPermissionContext: async () => context,
    createMessage: async (_channel, body) => {
      messages.push(body);
      return { id: String(499 + messages.length), channel_id: "200", content: body.content ?? "" };
    },
    editMessage: async () => ({ id: "500", channel_id: "200", content: "" }),
    deleteMessage: async () => {},
    seedReaction: async (_channel, _message, emoji) => {
      seeds.push(emoji);
    },
    clearReaction: async (_channel, _message, emoji) => {
      reactions.delete(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);
    },
    fetchMember: async () => ({ user: { id: "800" }, roles: [...roles] }),
    hasReaction: async (_channel, _message, emoji) => reactions.has(emoji),
    addRole: async (_guild, _user, role) => {
      roles.add(role);
      changes.push(`add:${role}`);
    },
    removeRole: async (_guild, _user, role) => {
      roles.delete(role);
      changes.push(`remove:${role}`);
    },
  };
  const service = new ReactionRoleService(store, discord, "900", now);
  return { database, store, context, roles, reactions, changes, messages, seeds, discord, service };
}

test("reaction-role choices validate single Unicode/custom emoji and reject duplicates and oversized messages", () => {
  for (const emoji of ["🟢", "👨‍👩‍👧‍👦", "🇦🇺", "1️⃣", "<:dayz:123456>", "<a:dayz:123456>", ":dayz:123456"])
    assert.ok(parseReactionRoleEmoji(emoji), emoji);
  for (const emoji of ["", "hello", "🟢🔵", "@everyone"])
    assert.equal(parseReactionRoleEmoji(emoji), null, emoji);
  for (const emoji of ["", "hello", "🟢🔵"]) {
    const result = reactionRoleSettingsSchema.safeParse({
      ...settings,
      options: [{ ...settings.options[0], emoji }],
    });
    assert.equal(result.success, false, emoji);
    if (!result.success)
      assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "options.0.emoji"));
  }
  assert.equal(
    parseReactionRoleEmoji("<a:dayz:123456>")?.key,
    parseReactionRoleEmoji(":renamed:123456")?.key,
  );
  assert.equal(
    reactionRoleSettingsSchema.safeParse({
      ...settings,
      options: [
        { emoji: "❤", roleId: "300", label: "A" },
        { emoji: "❤️", roleId: "301", label: "B" },
      ],
    }).success,
    false,
  );
  assert.equal(
    reactionRoleSettingsSchema.safeParse({
      ...settings,
      options: [...settings.options, { emoji: "🟠", roleId: "300", label: "Duplicate role" }],
    }).success,
    false,
  );
  assert.equal(
    reactionRoleSettingsSchema.safeParse({ ...settings, description: "x".repeat(1001) }).success,
    false,
  );
  assert.equal(reactionRoleSettingsSchema.safeParse({ ...settings, options: [] }).success, false);
  const body = reactionRoleMessage({ ...settings, description: "@everyone choose a game" });
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /🟢 — \*\*DayZ\*\*/);
});

test("independent panels retain legacy storage and reconcile the message that actually received the reaction", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  f.context.roles.push({ id: "302", name: "Europe", position: 3, permissions: "0" });
  const first = await f.service.save("100", settings);
  await f.service.publish("100", first.id);
  const second = await f.service.save(
    "100",
    {
      ...settings,
      title: "Choose your region",
      options: [{ emoji: "🟠", roleId: "302", label: "Europe" }],
    },
    null,
  );
  await f.service.publish("100", second.id);
  assert.equal((await f.store.listPanels("100")).length, 2);
  assert.equal((await f.store.readPanel("100"))?.id, first.id);
  assert.equal((await f.store.readPanel("100", second.id))?.messageId, "501");
  assert.equal(await f.store.readPanelByMessage("101", "200", "501"), null);
  f.reactions.add("🟠");
  await f.service.reconcile(event({ message_id: "501", emoji: { name: "🟠" } }));
  assert.deepEqual(f.changes, ["add:302"]);
  await f.service.setEnabled("100", false, first.id);
  assert.equal((await f.store.readPanel("100", second.id))?.enabled, true);
  await f.service.delete("100", first.id);
  assert.equal((await f.store.readPanel("100"))?.id, second.id);
  assert.equal(
    f.database.query<{ count: number }>("SELECT COUNT(*) AS count FROM reaction_role_panels")[0]
      .count,
    0,
  );
  assert.equal(
    f.database.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM reaction_role_additional_panels",
    )[0].count,
    1,
  );
});

test("a panel cannot reuse another panel's selectable role or select a panel from another server", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const panel = await f.service.save("100", settings);
  await assert.rejects(() => f.service.save("100", settings, null), /already used/);
  await assert.rejects(() => f.service.save("101", settings, panel.id), /no longer exists/);
  assert.equal((await f.store.listPanels("100")).length, 1);
});

test("single-choice panels clear previous reactions and roles before granting the new choice, including delayed deliveries", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await assert.rejects(
    () => f.service.save("100", { ...settings, mode: "single" }),
    /Manage Messages/,
  );
  f.context.roles[1].permissions = String((1n << 28n) | (1n << 13n));
  await f.service.save("100", { ...settings, mode: "single" });
  await f.service.publish("100");
  f.reactions.add("🟢");
  await f.service.reconcile(event());
  f.reactions.add("🔵");
  await f.service.reconcile(event({ emoji: { name: "🔵" } }));
  assert.deepEqual([...f.roles], ["301"]);
  assert.equal(f.reactions.has("🟢"), false);
  await f.service.reconcile(event());
  await f.service.reconcile(event({ emoji: { name: "🔵" } }));
  assert.deepEqual(f.changes, ["add:300", "remove:300", "add:301"]);
  f.reactions.delete("🔵");
  await f.service.reconcile(event({ emoji: { name: "🔵" } }));
  assert.deepEqual([...f.roles], []);
});

test("single-choice reconciliation retries a partial replacement without granting two roles", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  f.context.roles[1].permissions = String((1n << 28n) | (1n << 13n));
  await f.service.save("100", { ...settings, mode: "single" });
  await f.service.publish("100");
  f.roles.add("300");
  f.reactions.add("🟢");
  f.reactions.add("🔵");
  const remove = f.discord.removeRole;
  let fails = true;
  f.discord.removeRole = async (...args) => {
    if (fails) {
      fails = false;
      throw new Error("Discord unavailable");
    }
    await remove(...args);
  };
  await assert.rejects(() => f.service.reconcile(event({ emoji: { name: "🔵" } })), /unavailable/);
  assert.deepEqual([...f.roles], ["300"]);
  assert.equal(f.reactions.has("🟢"), false);
  await f.service.reconcile(event({ emoji: { name: "🔵" } }));
  assert.deepEqual([...f.roles], ["301"]);
});

test("eligibility is checked against the current member before each grant and does not prevent role removal", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  f.context.roles.push(
    { id: "410", name: "Member", position: 3, permissions: "0" },
    { id: "411", name: "Restricted", position: 4, permissions: "0" },
  );
  await f.service.save("100", { ...settings, requiredRoleIds: ["410"], blockedRoleIds: ["411"] });
  await f.service.publish("100");
  f.reactions.add("🟢");
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
  f.roles.add("410");
  f.roles.add("411");
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
  f.roles.delete("411");
  await f.service.reconcile(event());
  assert.ok(f.roles.has("300"));
  f.roles.delete("410");
  f.reactions.delete("🟢");
  await f.service.reconcile(event());
  assert.equal(f.roles.has("300"), false);
  assert.equal(
    reactionRoleSettingsSchema.safeParse({
      ...settings,
      requiredRoleIds: ["410"],
      blockedRoleIds: ["410"],
    }).success,
    false,
  );
  assert.equal(
    reactionRoleSettingsSchema.safeParse({ ...settings, requiredRoleIds: ["300"] }).success,
    false,
  );
});

test("panels publish once, seed every choice, and survive store reconstruction", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  assert.equal((await f.store.readPanel("100"))?.enabled, false);
  await f.service.publish("100");
  await f.service.publish("100");
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].nonce);
  assert.equal(f.messages[0].enforce_nonce, true);
  assert.deepEqual(f.seeds, ["🟢", "🔵", "🟢", "🔵"]);
  assert.equal(
    (await createCloudflareReactionRoleStore(f.database.d1).readPanel("100"))?.messageId,
    "500",
  );
  assert.equal(await f.store.readPanel("101"), null);
});

test("partial publish keeps its message and can retry without creating another post", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  const seed = f.discord.seedReaction;
  f.discord.seedReaction = async (_channel, _message, emoji) => {
    if (emoji === "🔵") throw new Error("temporary Discord failure");
  };
  await assert.rejects(() => f.service.publish("100"), /temporary/);
  assert.equal((await f.store.readPanel("100"))?.messageId, "500");
  assert.equal((await f.store.readPanel("100"))?.enabled, false);
  f.discord.seedReaction = seed;
  await f.service.publish("100");
  assert.equal(f.messages.length, 1);
  assert.equal((await f.store.readPanel("100"))?.enabled, true);
});

test("members independently select multiple game roles and unreact to remove only the matching role", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  f.reactions.add("🔵");
  await f.service.reconcile(event());
  await f.service.reconcile(event({ emoji: { name: "🔵" } }));
  await f.service.reconcile(event()); // duplicate delivery
  assert.deepEqual([...f.roles].sort(), ["300", "301"]);
  f.reactions.delete("🟢");
  await f.service.reconcile(event());
  assert.deepEqual([...f.roles], ["301"]);
  assert.deepEqual(f.changes, ["add:300", "add:301", "remove:300"]);
});

test("delayed add and remove events use current Discord reactions instead of old payloads", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.roles.add("300"); // an old add arrives after the member already removed their reaction
  await f.service.reconcile(event());
  assert.equal(f.roles.has("300"), false);
  f.reactions.add("🟢"); // an old remove arrives after the member re-selected the game
  await f.service.reconcile(event());
  assert.equal(f.roles.has("300"), true);
});

test("unrelated messages, channels, guilds, emoji, bots, and paused panels do not change roles", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  for (const overrides of [
    { guild_id: "101" },
    { channel_id: "201" },
    { message_id: "501" },
    { emoji: { name: "🔴" } },
    { user_id: "900" },
    { user_id: "../800" },
  ])
    await f.service.reconcile(event(overrides));
  f.discord.fetchMember = async () => ({ user: { id: "800", bot: true }, roles: [] });
  await f.service.reconcile(event());
  await f.service.setEnabled("100", false);
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
});

test("role validation rejects staff permissions, channel staff overwrites, managed roles, hierarchy, and foreign resources", async (t) => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.context.roles[2].permissions = "8";
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.roles[2].managed = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.roles[2].position = 10;
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.roles[1].permissions = "0";
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.roles = f.context.roles.filter((role) => role.id !== "300");
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.channels = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.channels[0].permission_overwrites = [
        { id: "300", type: 0, allow: String(1n << 13n), deny: "0" },
      ];
    },
  ]) {
    const f = fixture();
    t.after(() => f.database.close());
    mutate(f);
    await assert.rejects(() => f.service.save("100", settings));
    assert.equal(await f.store.readPanel("100"), null);
  }
});

test("HAF staff roles with no Discord permissions cannot be offered or granted after a config change", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  f.database.execRaw(
    "INSERT INTO guild_rbac_settings (guild_id, guild_admin_role_id) VALUES ('100', '300')",
  );
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
  await assert.rejects(() => f.service.publish("100"), /staff/);
  assert.equal((await f.store.readRestrictedRoleIds("101")).has("300"), false);
});

test("Discord permission changes after publication prevent self-assignment", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  f.context.roles[2].permissions = "8";
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
});

test("reaction removal revokes a manageable role after assignment safety changes", async (t) => {
  for (const change of ["staff-permission", "staff-overwrite", "restricted-workflow"]) {
    await t.test(change, async (t) => {
      const f = fixture();
      t.after(() => f.database.close());
      await f.service.save("100", settings);
      await f.service.publish("100");
      f.reactions.add("🟢");
      f.reactions.add("🔵");
      await f.service.reconcile(event());
      await f.service.reconcile(event({ emoji: { name: "🔵" } }));
      if (change === "staff-permission") f.context.roles[2].permissions = "8";
      else if (change === "staff-overwrite")
        f.context.channels[0].permission_overwrites = [
          { id: "300", type: 0, allow: String(1n << 13n), deny: "0" },
        ];
      else
        f.database.execRaw(
          "INSERT INTO guild_rbac_settings (guild_id, guild_admin_role_id) VALUES ('100', '300')",
        );
      f.reactions.delete("🟢");
      await f.service.reconcile(event()); // also represents a delayed add
      await f.service.reconcile(event()); // duplicate removal
      assert.deepEqual([...f.roles], ["301"]);
      f.reactions.add("🟢");
      await f.service.reconcile(event()); // a delayed removal cannot grant the unsafe role
      assert.deepEqual(f.changes, ["add:300", "add:301", "remove:300"]);
    });
  }
});

test("reaction removal respects role management, panel lifecycle, member, and identity constraints", async (t) => {
  for (const constraint of [
    "managed",
    "hierarchy",
    "permissions",
    "missing",
    "paused",
    "deleted",
    "bot",
    "identity",
  ]) {
    await t.test(constraint, async (t) => {
      const f = fixture();
      t.after(() => f.database.close());
      await f.service.save("100", settings);
      await f.service.publish("100");
      f.roles.add("300");
      f.context.roles[2].permissions = "8";
      if (constraint === "managed") f.context.roles[2].managed = true;
      if (constraint === "hierarchy") f.context.roles[2].position = 10;
      if (constraint === "permissions") f.context.roles[1].permissions = "0";
      if (constraint === "missing") f.context.roles.splice(2, 1);
      if (constraint === "paused") await f.service.setEnabled("100", false);
      if (constraint === "deleted") await f.service.delete("100");
      if (constraint === "bot")
        f.discord.fetchMember = async () => ({ user: { id: "800", bot: true }, roles: ["300"] });
      const service =
        constraint === "identity" ? new ReactionRoleService(f.store, f.discord, "901") : f.service;
      await service.reconcile(event());
      assert.deepEqual([...f.roles], ["300"]);
      assert.deepEqual(f.changes, []);
    });
  }
});

test("reaction removal cannot change roles after losing the guild lease", async (t) => {
  let now = 1000;
  const f = fixture(() => now);
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.roles.add("300");
  f.context.roles[2].permissions = "8";
  f.discord.hasReaction = async () => {
    now += 120_001;
    await f.service.setEnabled("100", false);
    return false;
  };
  await assert.rejects(() => f.service.reconcile(event()), /lease expired/);
  assert.deepEqual(f.changes, []);
  assert.equal((await f.store.readPanel("100"))?.enabled, false);
});

test("published mappings are stable, labels can change, and new choices can be appended", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  await assert.rejects(() => f.service.save("100", { ...settings, channelId: "201" }), /cannot/);
  await assert.rejects(
    () => f.service.save("100", { ...settings, options: [settings.options[0]] }),
    /cannot/,
  );
  await assert.rejects(
    () =>
      f.service.save("100", {
        ...settings,
        options: [{ ...settings.options[0], emoji: "🟠" }, settings.options[1]],
      }),
    /cannot/,
  );
  await f.service.save("100", {
    ...settings,
    options: settings.options.map((option) => ({ ...option, label: `${option.label} players` })),
  });
  assert.equal((await f.store.readPanel("100"))?.enabled, false);
  assert.equal((await f.store.readPanel("100"))?.options[0].label, "DayZ players");
  f.context.roles.push({ id: "302", name: "Music", position: 3, permissions: "0" });
  await f.service.save("100", {
    ...settings,
    options: [...settings.options, { emoji: "🟠", roleId: "302", label: "Music" }],
  });
  assert.equal((await f.store.readPanel("100"))?.options.length, 3);
});

test("reaction roles cannot restore a member's role while a timed assignment suspends it", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  f.database
    .execRaw(`INSERT INTO timed_roles (guild_id, user_id, role_id, duration_input, expires_at_ms, created_at_ms, updated_at_ms, suspended_role_ids_json)
    VALUES ('100', '800', '600', '1h', 9999999999999, 1, 1, '["300"]')`);
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
  assert.equal(await f.store.isRoleSuspended("100", "801", "300"), false);
  f.database.execRaw("DELETE FROM timed_roles WHERE guild_id = '100' AND user_id = '800'");
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, ["add:300"]);
});

test("custom emoji match by ID even when renamed or animated", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", {
    ...settings,
    options: [{ emoji: "<a:dayz:123456>", roleId: "300", label: "DayZ" }],
  });
  await f.service.publish("100");
  f.reactions.add("dayz:123456");
  await f.service.reconcile(event({ emoji: { id: "123456", name: "renamed", animated: true } }));
  assert.deepEqual(f.changes, ["add:300"]);
});

test("per-guild leases prevent concurrent panel and role mutations and can recover after expiry", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  assert.equal(await f.store.claimLease("100", "first", 1000), true);
  assert.equal(await f.store.claimLease("100", "second", 1001), false);
  await f.store.releaseLease("100", "second");
  assert.equal(await f.store.claimLease("100", "second", 1002), false);
  assert.equal(await f.store.claimLease("101", "other-guild", 1002), true);
  assert.equal(await f.store.claimLease("100", "second", 121001), true);
  await f.store.releaseLease("100", "first");
  assert.equal(await f.store.claimLease("100", "third", 121002), false);
});

test("a bot identity change can reset configuration without editing the previous bot's message", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  const other = new ReactionRoleService(f.store, f.discord, "901");
  await assert.rejects(() => other.publish("100"), /different bot/);
  await other.reconcile(event());
  assert.deepEqual(f.changes, []);
  let deletedMessages = 0;
  f.discord.deleteMessage = async () => {
    deletedMessages++;
  };
  await other.setEnabled("100", false);
  await other.delete("100");
  assert.equal(deletedMessages, 0);
  assert.equal(await f.store.readPanel("100"), null);
  assert.equal((await other.save("100", settings)).botUserId, "901");
});

test("pinning and slowmode-bypass permissions cannot become self-assigned", async (t) => {
  for (const bit of [51, 52]) {
    const f = fixture();
    t.after(() => f.database.close());
    f.context.roles[2].permissions = String(1n << BigInt(bit));
    await assert.rejects(() => f.service.save("100", settings), /staff or management/);
    f.context.roles[2].permissions = "0";
    f.context.channels[0].permission_overwrites = [
      { id: "300", type: 0, allow: String(1n << BigInt(bit)), deny: "0" },
    ];
    await assert.rejects(() => f.service.save("100", settings), /staff or management/);
    f.context.channels[0].permission_overwrites = [];
    await f.service.save("100", settings);
    await f.service.publish("100");
    f.context.roles[2].permissions = String(1n << BigInt(bit));
    f.reactions.add("🟢");
    await f.service.reconcile(event());
    assert.deepEqual(f.changes, []);
  }
});

test("support roles retained by existing Tickets stay protected after panel changes", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.reactions.add("🟢");
  f.database.execRaw(`INSERT INTO ticket_instances
    (guild_id, channel_id, ticket_type_id, ticket_type_label, opener_user_id, support_role_id, status, answers_json, opened_at_ms)
    VALUES ('100', '700', 'old-type', 'Support', '800', '300', 'open', '[]', 1)`);
  assert.equal((await f.store.readRestrictedRoleIds("100")).has("300"), true);
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
  await assert.rejects(() => f.service.save("100", settings), /ticket/);
});

test("environment-configured HAF admin and billing support roles remain protected without Discord permissions", async (t) => {
  const staffRoles = { guildId: "100", roleIds: ["300", "301", undefined] };
  const f = fixture(Date.now, staffRoles);
  t.after(() => f.database.close());
  assert.deepEqual(await f.store.readRestrictedRoleIds("100"), new Set(["300", "301"]));
  assert.deepEqual(await f.store.readRestrictedRoleIds("101"), new Set());
  await assert.rejects(() => f.service.save("100", settings), /staff|protected|verification/);

  const originalService = new ReactionRoleService(
    createCloudflareReactionRoleStore(f.database.d1),
    f.discord,
    "900",
  );
  await originalService.save("100", settings);
  await originalService.publish("100");
  await assert.rejects(() => f.service.publish("100"), /staff|protected|verification/);
  f.reactions.add("🟢");
  await f.service.reconcile(event());
  assert.deepEqual(f.changes, []);
});

test("saved but unpublished appended choices can still be corrected or removed", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", { ...settings, options: [settings.options[0]] });
  await f.service.publish("100");
  await f.service.save("100", settings);
  assert.equal((await f.store.readPanel("100"))?.publishedOptions.length, 1);
  await f.service.save("100", {
    ...settings,
    options: [settings.options[0], { ...settings.options[1], emoji: "🟠" }],
  });
  await f.service.save("100", { ...settings, options: [settings.options[0]] });
  assert.equal((await f.store.readPanel("100"))?.options.length, 1);
  await assert.rejects(
    () =>
      f.service.save("100", { ...settings, options: [{ ...settings.options[0], emoji: "🔴" }] }),
    /cannot/,
  );
});

test("a publisher that loses its lease cannot undo a concurrent pause", async (t) => {
  let now = 1000;
  const f = fixture(() => now);
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.discord.seedReaction = async (_channel, _message, emoji) => {
    if (emoji !== "🔵") return;
    now += 120_001;
    await f.service.setEnabled("100", false);
  };
  await assert.rejects(() => f.service.publish("100"), /lease expired/);
  assert.equal((await f.store.readPanel("100"))?.enabled, false);
});

test("panel writes and deletes reject an obsolete lease even after the successor releases it", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const panel = await f.service.save("100", settings);
  await f.store.claimLease("100", "old", 1000);
  await f.store.claimLease("100", "new", 121001);
  await f.store.releaseLease("100", "new");
  assert.equal(await f.store.renewLease("100", "old", 121002), false);
  assert.equal(
    await f.store.savePanel(
      { ...panel, title: "Stale publisher" },
      { token: "old", nowMs: 121002 },
    ),
    false,
  );
  assert.equal(await f.store.deletePanel("100", { token: "old", nowMs: 121002 }), false);
  assert.equal((await f.store.readPanel("100"))?.title, settings.title);
});

test("queued events from a paused period do not grant roles after resume", async (t) => {
  let now = 1000;
  const f = fixture(() => now);
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  now = 2000;
  await f.service.setEnabled("100", false);
  f.reactions.add("🟢");
  now = 3000;
  await f.service.publish("100");
  await f.service.reconcile(event(), 2500);
  assert.deepEqual(f.changes, []);
  await f.service.reconcile(event(), 3001);
  assert.deepEqual(f.changes, ["add:300"]);
});

test("deleting a panel stops processing and retains members' existing game roles", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  await f.service.save("100", settings);
  await f.service.publish("100");
  f.roles.add("300");
  await f.service.delete("100");
  await f.service.reconcile(event());
  assert.equal(await f.store.readPanel("100"), null);
  assert.deepEqual([...f.roles], ["300"]);
});
