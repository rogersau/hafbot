import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("PostgreSQL contract gate refuses a missing test database instead of skipping", () => {
  const result = run("");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_POSTGRES_URL is required/);
});

test("PostgreSQL contract gate refuses remote or non-test databases without exposing credentials", () => {
  for (const url of [
    "postgresql://haf:private-password@remote.example/haf_test",
    "postgresql://haf:private-password@127.0.0.1/haf",
    "not-a-url:private-password",
  ]) {
    const result = run(url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local database ending in _test|valid PostgreSQL URL/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-password/);
  }
});

function run(url) {
  return spawnSync(process.execPath, ["scripts/run-postgres-tests.mjs"], {
    encoding: "utf8",
    env: { ...process.env, TEST_POSTGRES_URL: url },
  });
}
