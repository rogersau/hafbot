import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { CloudflareBillingDeliveryStore } from "../src/runtime/billing/cloudflare-delivery-store";
import {
  BillingDeliveryError,
  processBillingDelivery,
  type BillingDiscordDelivery,
} from "../src/runtime/billing/delivery";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const NOW = 1_800_000_000_000;
const postgresOptions = { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" };

test(
  "PostgreSQL nullable recovery: terminal owner delivery reuses its support case",
  postgresOptions,
  async () => {
    await withPostgres(async (database, store) => {
      await seedOperation(database);
      await store.markOwnerTerminal("operation-fixture", "fixture_permanent_failure", NOW + 1);
      assert.deepEqual(await readTerminal(database), {
        owner_dm_status: "terminal",
        terminal_reason: "fixture_permanent_failure",
        updated_at_ms: NOW + 1,
      });
      const cases = await readCases(database);
      assert.deepEqual(cases, [
        {
          id: "delivery:operation-fixture",
          owner_id: "owner-fixture",
          kind: "owner_delivery_terminal",
          status: "open",
          safe_provider_ids_json: '["operation-fixture"]',
          opened_at_ms: NOW + 1,
          updated_at_ms: NOW + 1,
        },
      ]);
      await store.markOwnerTerminal("operation-fixture", "fixture_permanent_failure", NOW + 2);
      assert.deepEqual(await readCases(database), [{ ...cases[0], updated_at_ms: NOW + 2 }]);
      assert.equal((await store.read("operation-fixture"))?.ownerDmStatus, "terminal");
    });
  },
);

test(
  "PostgreSQL nullable recovery: missing billing operation creates no orphan delivery or support case",
  postgresOptions,
  async () => {
    await withPostgres(async (database, store) => {
      await store.markOwnerTerminal("missing-operation", "fixture_permanent_failure", NOW);
      assert.equal(await store.read("missing-operation"), null);
      assert.deepEqual(await readCases(database), []);
      assert.equal(
        await database
          .prepare("SELECT COUNT(*) AS count FROM billing_operation_delivery")
          .first("count"),
        0,
      );
      assert.equal(
        await database
          .prepare("SELECT COUNT(*) AS count FROM billing_operations_ledger")
          .first("count"),
        0,
      );
    });
  },
);

test(
  "PostgreSQL nullable recovery: permanent owner DM failure persists terminal state before private audit and does not resend",
  postgresOptions,
  async () => {
    await withPostgres(async (database, store) => {
      await seedOperation(database);
      let ownerSends = 0;
      let auditSends = 0;
      let attemptId = 0;
      const discord: BillingDiscordDelivery = {
        async resolveOwnerDiscordIdentity(ownerId) {
          assert.equal(ownerId, "owner-fixture");
          return { discordUserId: "discord-owner-fixture", displayName: "Fixture Owner" };
        },
        async sendOwnerDm(userId) {
          assert.equal(userId, "discord-owner-fixture");
          ownerSends += 1;
          throw new BillingDeliveryError("fixture_permanent_failure", false);
        },
        async sendAudit() {
          auditSends += 1;
          assert.deepEqual(await readTerminal(database), {
            owner_dm_status: "terminal",
            terminal_reason: "fixture_permanent_failure",
            updated_at_ms: NOW + 1,
          });
          assert.equal((await readCases(database)).length, 1);
          return { id: "private-audit-fixture" };
        },
      };
      const deliver = () =>
        processBillingDelivery({
          operationId: "operation-fixture",
          store,
          discord,
          now: () => NOW + 1,
          createId: () => `attempt-fixture-${++attemptId}`,
        });
      assert.deepEqual(await deliver(), { result: "complete" });
      const completed = await store.read("operation-fixture");
      assert.ok(completed);
      assert.equal(completed.ownerDmStatus, "terminal");
      assert.equal(completed.ownerAttemptCount, 1);
      assert.equal(completed.auditStatus, "delivered");
      assert.equal(
        await database
          .prepare("SELECT audit_message_id FROM billing_operation_delivery WHERE operation_id = ?")
          .bind("operation-fixture")
          .first("audit_message_id"),
        "private-audit-fixture",
      );
      assert.deepEqual(
        (
          await database
            .prepare("SELECT destination, outcome FROM billing_delivery_attempts ORDER BY id")
            .all()
        ).results,
        [
          { destination: "owner_dm", outcome: "permanent_failure" },
          { destination: "audit", outcome: "delivered" },
        ],
      );
      const cases = await readCases(database);
      assert.equal(cases.length, 1);
      assert.equal(cases[0].owner_id, "owner-fixture");
      assert.equal(cases[0].safe_provider_ids_json, '["operation-fixture"]');
      assert.deepEqual(await deliver(), { result: "complete" });
      assert.equal(ownerSends, 1);
      assert.equal(auditSends, 1);
      assert.equal(attemptId, 2);
      assert.deepEqual(await store.read("operation-fixture"), completed);
      assert.deepEqual(await readCases(database), cases);
    });
  },
);

async function withPostgres(
  operation: (database: D1Database, store: CloudflareBillingDeliveryStore) => Promise<void>,
) {
  assert.ok(postgresUrl);
  const url = new URL(postgresUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.match(url.pathname, /_test$/);
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: postgresUrl,
    NODE_ENV: "test",
    PG_POOL_MAX: "4",
  });
  try {
    await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await applyPostgresMigrations(
      database,
      await readPostgresMigrations(resolve("migrations/postgres")),
    );
    const d1 = createPostgresD1CompatibilityDatabase(database);
    await operation(d1, new CloudflareBillingDeliveryStore(d1));
  } finally {
    await database.close();
  }
}

async function seedOperation(database: D1Database) {
  await database.batch([
    database
      .prepare(
        "INSERT INTO billing_operations_ledger(id, owner_id, kind, source, summary_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "operation-fixture",
        "owner-fixture",
        "payment_recovery_required",
        "scheduled",
        JSON.stringify({
          notifyOwner: true,
          summary: "fixture_payment_attention",
          resultingAccess: "premium",
          effectiveAtMs: NOW,
        }),
        NOW,
      ),
    database
      .prepare("INSERT INTO billing_operation_delivery(operation_id, updated_at_ms) VALUES (?, ?)")
      .bind("operation-fixture", NOW),
  ]);
}

function readTerminal(database: D1Database) {
  return database
    .prepare(
      "SELECT owner_dm_status, terminal_reason, updated_at_ms FROM billing_operation_delivery WHERE operation_id = ?",
    )
    .bind("operation-fixture")
    .first();
}

async function readCases(database: D1Database) {
  return (
    await database
      .prepare(
        "SELECT id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms FROM billing_support_cases ORDER BY id",
      )
      .all<Record<string, unknown>>()
  ).results;
}
