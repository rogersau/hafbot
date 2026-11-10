import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ALL_SLASH_COMMAND_DEFINITIONS } from "../src/discord-commands";
test("public command reference covers each non-operator command", async () => {
  const commands = await readFile("docs-site/commands.md", "utf8");
  for (const command of ALL_SLASH_COMMAND_DEFINITIONS) {
    if (command.name === "haf-admin") continue;
    if (command.type === 3) {
      assert.ok(commands.includes(command.name));
      continue;
    }
    const subcommands = command.options?.filter((option) => option.type === 1) ?? [];
    if (!subcommands.length) assert.ok(commands.includes(`/${command.name}`), command.name);
    for (const subcommand of subcommands)
      assert.ok(commands.includes(`/${command.name} ${subcommand.name}`));
  }
  assert.doesNotMatch(commands, /^\s*-\s+`\/haf-admin/m);
});
test("independent install guide uses self-hosted mode and generic configuration", async () => {
  const guide = await readFile("docs-site/self-hosting.md", "utf8");
  assert.match(guide, /HAF_DEPLOYMENT_MODE=self-hosted/);
  assert.match(guide, /infra\/self-host/);
  assert.match(guide, /discord-command-sync/);
  assert.doesNotMatch(guide, /infra\/vps|192\.168\./);
});
