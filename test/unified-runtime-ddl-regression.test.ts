/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

test("unified stores do not run schema DDL at request time", () => {
  const storeFiles = readdirSync("src/runtime")
    .filter((fileName) => /^cloudflare-.*-store\.ts$/.test(fileName))
    .map((fileName) => `src/runtime/${fileName}`)
    .sort();

  assert.ok(storeFiles.length > 0, "expected active Cloudflare stores");
  for (const filePath of storeFiles) {
    const source = readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, /database\.exec\(/, `${filePath} should not call database.exec()`);
    assert.doesNotMatch(
      source,
      /CREATE TABLE|CREATE INDEX|ALTER TABLE|PRAGMA table_info/i,
      `${filePath} should not contain runtime schema DDL`,
    );
    if (source.includes("createD1DrizzleDatabase(")) {
      assert.doesNotMatch(
        source,
        /createDrizzleD1Gateway|drizzle-d1-gateway/,
        `${filePath} should not use the raw-SQL Drizzle D1 gateway`,
      );
      assert.doesNotMatch(
        source,
        /schemaCache|SCHEMA_STATEMENTS|ensure\w*Schema|duplicate column/i,
        `${filePath} should not keep schema bootstrap helpers`,
      );
    }
  }
});
