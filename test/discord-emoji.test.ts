/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { parseButtonEmoji } from "../src/discord/emoji";

test("parseButtonEmoji returns undefined for null/undefined/empty", () => {
  assert.equal(parseButtonEmoji(null), undefined);
  assert.equal(parseButtonEmoji(undefined), undefined);
  assert.equal(parseButtonEmoji(""), undefined);
  assert.equal(parseButtonEmoji("   "), undefined);
});

test("parseButtonEmoji passes a unicode emoji through as { name }", () => {
  assert.deepEqual(parseButtonEmoji("✅"), { name: "✅" });
});

test("parseButtonEmoji parses a static custom emoji :name:id into { id, name, animated:false }", () => {
  assert.deepEqual(parseButtonEmoji(":verified:111"), {
    id: "111",
    name: "verified",
    animated: false,
  });
});

test("parseButtonEmoji parses an animated custom emoji :a:name:id", () => {
  assert.deepEqual(parseButtonEmoji(":a:party:222"), {
    id: "222",
    name: "party",
    animated: true,
  });
});

test("parseButtonEmoji falls back to { name } for a malformed custom form", () => {
  // Leading colon but no trailing id — not a valid custom reference.
  assert.deepEqual(parseButtonEmoji(":nope"), { name: ":nope" });
});

test("parseButtonEmoji trims surrounding whitespace before parsing", () => {
  assert.deepEqual(parseButtonEmoji("  ✅  "), { name: "✅" });
  assert.deepEqual(parseButtonEmoji("  :verified:111  "), {
    id: "111",
    name: "verified",
    animated: false,
  });
});
