/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json.
import test from "node:test";

import { discordGuildIconUrl } from "../src/admin/lib/discord-guild-icon";

test("discordGuildIconUrl returns a cdn.discordapp.com URL when an icon hash is present", () => {
  assert.equal(
    discordGuildIconUrl("guild-1", "abc123"),
    "https://cdn.discordapp.com/icons/guild-1/abc123.png",
  );
});

test("discordGuildIconUrl returns null for an empty or missing icon hash", () => {
  assert.equal(discordGuildIconUrl("guild-1", null), null);
  assert.equal(discordGuildIconUrl("guild-1", undefined), null);
  assert.equal(discordGuildIconUrl("guild-1", ""), null);
});

test("discordGuildIconUrl returns null when the guild id is empty", () => {
  assert.equal(discordGuildIconUrl("", "abc123"), null);
  assert.equal(discordGuildIconUrl("   ", "abc123"), null);
});

test("discordGuildIconUrl URL-encodes the guild id and icon hash", () => {
  assert.equal(
    discordGuildIconUrl("guild/with/slash", "icon hash"),
    "https://cdn.discordapp.com/icons/guild%2Fwith%2Fslash/icon%20hash.png",
  );
});
