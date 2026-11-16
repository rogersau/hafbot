/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

const opaqueOrPendingDeleteExceptions = new Map([
  [
    "member-verification-store.ts:deleteVerificationAttempt",
    "Verification attempt IDs are opaque single-use capabilities.",
  ],
  [
    "platform-link-store.ts:deletePendingPlatformLink",
    "Pending platform links are keyed by opaque OAuth state.",
  ],
  [
    "suggestion-store.ts:deletePendingSubmission",
    "Pending suggestion submissions are keyed by opaque confirmation IDs.",
  ],
]);

test("tenant-owned store deletes require Guild scope", () => {
  const observedExceptions = new Set<string>();
  const contractDirectory = "src/runtime/contracts";
  for (const fileName of readdirSync(contractDirectory).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(contractDirectory, fileName), "utf8");
    for (const match of source.matchAll(
      /^\s*(delete(?:[A-Z][A-Za-z0-9_]*)?)\s*\(([^)]*)\)\s*:\s*Promise/gm,
    )) {
      const methodName = match[1];
      const parameters = match[2];
      const key = `${fileName}:${methodName}`;
      if (opaqueOrPendingDeleteExceptions.has(key)) {
        observedExceptions.add(key);
        continue;
      }
      assert.match(
        parameters,
        /\bguildId\b/,
        `${key} must require guildId or document why its key is not tenant-owned`,
      );
    }
  }

  assert.deepEqual(
    [...observedExceptions].sort(),
    [...opaqueOrPendingDeleteExceptions.keys()].sort(),
    "Delete exceptions must remain explicit and correspond to a current store method",
  );
});
