/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? listTypeScriptFiles(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

test("Member Verification has one production construction path", () => {
  const constructorFiles = listTypeScriptFiles("src").filter((path) =>
    /new\s+MemberVerificationService\s*\(/.test(readFileSync(path, "utf8")),
  );

  assert.deepEqual(constructorFiles, ["src/services/member-verification-service.ts"]);
});
