/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { spawnSync } from "node:child_process";

test("the Worker TypeScript program compiles with its configured Cloudflare boundaries", () => {
  const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
