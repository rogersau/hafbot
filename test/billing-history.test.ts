/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { CloudflareBillingHistoryStore } from "../src/runtime/billing/history";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Billing history is owner-authorized by query and retains immutable safe operation summaries", async () => {
  const database = new SqliteD1Database();
  await insert(database, "op-1", "owner-1", "subscription_started");
  await insert(database, "op-2", "owner-2", "subscription_cancelled");
  const history = new CloudflareBillingHistoryStore(database as unknown as D1Database);
  const ownerOne = await history.listOwnerHistory("owner-1");
  assert.equal(ownerOne.length, 1);
  assert.equal(ownerOne[0]?.id, "op-1");
  assert.deepEqual(JSON.parse(ownerOne[0]?.summaryJson ?? "{}"), {
    summary: "subscription started",
    resultingAccess: "premium",
    effectiveAtMs: 1,
    requiredAction: null,
    billingPath: "/admin/billing",
  });
});

async function insert(database: SqliteD1Database, id: string, ownerId: string, kind: string) {
  await database
    .prepare(
      "INSERT INTO billing_operations_ledger(id, owner_id, kind, source, summary_json, created_at_ms) VALUES (?, ?, ?, 'webhook', ?, 1)",
    )
    .bind(
      id,
      ownerId,
      kind,
      JSON.stringify({
        summary: kind.replaceAll("_", " "),
        resultingAccess: "premium",
        effectiveAtMs: 1,
        requiredAction: null,
        billingPath: "/admin/billing",
      }),
    )
    .run();
}
