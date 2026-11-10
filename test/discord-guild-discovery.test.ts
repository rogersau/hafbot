/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createGuildDiscoveryService } from "../src/runtime/discord-guild-discovery";

test("Guild discovery returns manageable installed Guilds without role-derived authority", async () => {
  const service = createGuildDiscoveryService({
    discordAccounts: { readDiscordAccessToken: async () => "oauth-token" },
    listUserGuilds: async () => [
      { guildId: "owner", name: "Owner", owner: true, permissions: "0", icon: null },
      { guildId: "admin", name: "Admin", owner: false, permissions: "32", icon: null },
      { guildId: "missing", name: "Missing", owner: true, permissions: "0", icon: null },
    ],
    listBotGuilds: async () => [
      { guildId: "owner", name: "Owner", icon: null },
      { guildId: "admin", name: "Admin", icon: null },
    ],
  });
  assert.deepEqual(
    (await service.discoverGuildsForUser("owner-id", "discord-id")).map((guild) => guild.guildId),
    ["owner", "admin"],
  );
});

test("Guild discovery requires the signed-in Discord OAuth token", async () => {
  const service = createGuildDiscoveryService({
    discordAccounts: { readDiscordAccessToken: async () => null },
    listUserGuilds: async () => [],
    listBotGuilds: async () => [],
  });
  await assert.rejects(() => service.discoverGuildsForUser("owner", "discord"), /OAuth/);
});
