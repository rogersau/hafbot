/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { readGuildIdFromRequest } from "../src/runtime/app";

test("guild request extraction covers admin, interaction, billing, and nested queued payload shapes", async () => {
  assert.equal(
    await readGuildIdFromRequest(new Request("https://example.com/admin/guild-1/tickets")),
    "guild-1",
  );
  assert.equal(
    await readGuildIdFromRequest(
      new Request("https://example.com/admin/api/tickets?guildId=guild-2"),
    ),
    "guild-2",
  );
  assert.equal(
    await readGuildIdFromRequest(
      new Request("https://example.com/interactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guild_id: "guild-3" }),
      }),
    ),
    "guild-3",
  );
  assert.equal(
    await readGuildIdFromRequest(
      new Request("https://example.com/api/billing/assignment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignment: { guildId: "guild-4" } }),
      }),
    ),
    "guild-4",
  );
});
