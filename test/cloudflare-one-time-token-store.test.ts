/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareOneTimeTokenStore } from "../src/runtime/cloudflare-one-time-token-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("one-time token consumption succeeds exactly once under concurrency", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareOneTimeTokenStore(database.d1);
  const input = { nonce: "nonce-1", expiresAtMs: 2_000, consumedAtMs: 1_000 };

  const results = await Promise.all(Array.from({ length: 20 }, () => store.consume(input)));

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((consumed) => !consumed).length, 19);
  database.close();
});

test("one-time token consumption is independent by nonce", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareOneTimeTokenStore(database.d1);

  assert.equal(
    await store.consume({ nonce: "nonce-1", expiresAtMs: 2_000, consumedAtMs: 1_000 }),
    true,
  );
  assert.equal(
    await store.consume({ nonce: "nonce-2", expiresAtMs: 2_000, consumedAtMs: 1_000 }),
    true,
  );
  assert.equal(
    await store.consume({ nonce: "nonce-1", expiresAtMs: 3_000, consumedAtMs: 1_500 }),
    false,
  );
  database.close();
});

test("expired one-time tokens are not consumed", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareOneTimeTokenStore(database.d1);

  assert.equal(
    await store.consume({ nonce: "expired", expiresAtMs: 1_000, consumedAtMs: 1_000 }),
    false,
  );
  database.close();
});
