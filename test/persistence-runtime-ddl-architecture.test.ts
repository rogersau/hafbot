/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

test("persistence stores do not run schema DDL at request time", () => {
  const storeFiles = readdirSync("src/runtime/postgres")
    .filter((fileName) => /^postgres-.*-store\.ts$/.test(fileName))
    .map((fileName) => `src/runtime/postgres/${fileName}`);
  assert.ok(storeFiles.length > 0);
  for (const path of storeFiles) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /CREATE TABLE|CREATE INDEX|ALTER TABLE|PRAGMA table_info/i,
      path,
    );
  }
});
