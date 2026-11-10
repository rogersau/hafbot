import assert from "node:assert/strict";
import test from "node:test";

import { syncDiscordCommands } from "../src/node/discord-command-sync";

const applicationId = "123456789012345678";
const adminGuildId = "223456789012345678";
const adminRoleId = "323456789012345678";

test("fresh installation registers customer commands globally and operator commands only in its private Guild", async () => {
  const calls: Array<{ scope: string; names: string[] }> = [];
  const transport = {
    async syncApplicationCommands(id: string, token: string, commands: unknown[]) {
      assert.equal(id, applicationId);
      assert.equal(token, "test-bot-token");
      calls.push({ scope: "global", names: commandNames(commands) });
    },
    async syncGuildApplicationCommands(
      id: string,
      guild: string,
      token: string,
      commands: unknown[],
    ) {
      assert.equal(id, applicationId);
      assert.equal(guild, adminGuildId);
      assert.equal(token, "test-bot-token");
      calls.push({ scope: "private-guild", names: commandNames(commands) });
    },
  };
  await syncDiscordCommands(
    {
      DISCORD_APPLICATION_ID: applicationId,
      DISCORD_BOT_TOKEN: "test-bot-token",
      HAF_ADMIN_GUILD_ID: adminGuildId,
      HAF_ADMIN_ROLE_ID: adminRoleId,
      DISABLE_BLOCKLIST: "true",
    },
    transport,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].names.includes("help"));
  assert.ok(!calls[0].names.includes("haf-admin"));
  assert.ok(!calls[0].names.includes("blocklist"));
  assert.deepEqual(calls[1], { scope: "private-guild", names: ["haf-admin"] });
});

test("registration rejects missing credentials and incomplete operator configuration before contacting Discord", async () => {
  const transport = {
    async syncApplicationCommands() {
      assert.fail("Unexpected Discord write");
    },
    async syncGuildApplicationCommands() {
      assert.fail("Unexpected Discord write");
    },
  };
  for (const environment of [
    {},
    { DISCORD_APPLICATION_ID: applicationId },
    { DISCORD_APPLICATION_ID: "invalid", DISCORD_BOT_TOKEN: "test-bot-token" },
    {
      DISCORD_APPLICATION_ID: applicationId,
      DISCORD_BOT_TOKEN: "test-bot-token",
      HAF_ADMIN_GUILD_ID: adminGuildId,
    },
  ]) {
    await assert.rejects(syncDiscordCommands(environment, transport));
  }
});

test("installation without operator configuration makes no Guild command write", async () => {
  let globalWrites = 0;
  await syncDiscordCommands(
    { DISCORD_APPLICATION_ID: applicationId, DISCORD_BOT_TOKEN: "test-bot-token" },
    {
      async syncApplicationCommands() {
        globalWrites += 1;
      },
      async syncGuildApplicationCommands() {
        assert.fail("Unexpected private Guild write");
      },
    },
  );
  assert.equal(globalWrites, 1);
});

function commandNames(commands: unknown[]): string[] {
  return commands.map((command) => (command as { name: string }).name);
}
