import assert from "node:assert/strict";
import test from "node:test";

import { processCommerceFinancialProviderActions } from "../src/runtime/postgres/postgres-commerce-financial-provider-actions";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const NOW = 1_800_000_000_000;

test(
  "PostgreSQL financial sweeps type conditional timestamps and preserve completed cancellations",
  {
    skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured",
  },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    assert.ok(url.hostname === "127.0.0.1" || url.hostname === "localhost");
    assert.match(url.pathname, /_test$/);
    const postgres = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    try {
      await initializePostgresSchema(postgres);
      const database = postgres;
      const scope = crypto.randomUUID();
      const providerCalls: string[] = [];
      let reconciliationCalls = 0;
      const run = (limit: number) =>
        processCommerceFinancialProviderActions({
          database,
          now: () => NOW,
          limit,
          provider: {
            async cancelAtPeriodEnd(input) {
              providerCalls.push(input.stripeSubscriptionId);
            },
            async cancelImmediately() {
              assert.fail("unexpected immediate cancellation");
            },
          },
          async requestReconciliation() {
            reconciliationCalls += 1;
          },
        });
      // PostgreSQL validates expression types even when the INSERT SELECT finds no rows.
      assert.equal(await run(0), 0);
      const execute = (sql: string, ...values: (string | number)[]) =>
        database.queryResult(sql, [...values]);
      await execute(
        `INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
      VALUES ($1, $2, $3, 'active',1,1,1,1,1)`,
        scope,
        scope,
        scope,
      );
      await execute(
        `INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
      VALUES ($1, $2, $3, 'role', 'Gold','subscription','draft',1,1)`,
        scope,
        scope,
        scope,
      );
      await execute(
        `INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,retire_at_ms,created_at_ms,updated_at_ms)
      VALUES ($1, $2, $3, 'retiring','[]','seller@example.test',1,2,1,1)`,
        scope,
        scope,
        scope,
      );
      await execute(
        `INSERT INTO commerce_offering_retirements(id,connected_account_id,guild_id,offering_id,requested_by_user_id,reason_code,status,active_subscription_count,scheduled_cancellation_count,failed_cancellation_count,created_at_ms,updated_at_ms)
      VALUES ($1, $2, $3, $4, 'seller','seller_requested','scheduling_cancellations',2,0,0,1,1)`,
        scope,
        scope,
        scope,
        scope,
      );
      await execute(
        `INSERT INTO commerce_seller_offboarding(connected_account_id,guild_id,status,reason_code,actor_user_id,active_subscription_count,started_at_ms,updated_at_ms)
      VALUES ($1, $2, 'canceling','seller_requested','seller',2,1,1)`,
        scope,
        scope,
      );
      await execute(
        `INSERT INTO commerce_financial_actions(id,connected_account_id,guild_id,action_type,entity_type,entity_id,actor_user_id,reason_code,status,access_action,created_at_ms,updated_at_ms)
      VALUES ($1, $2, $3, 'seller.offboarding_started','seller',$4,'seller','seller_requested','processing','remove_at_period_end',1,1)`,
        scope,
        scope,
        scope,
        scope,
      );
      await execute(
        `INSERT INTO commerce_operational_controls(id,scope_type,scope_id,control_type,enabled,reason_code,actor_user_id,created_at_ms,updated_at_ms)
      VALUES ($1, 'seller', $2, 'renewal_shutdown',1,'risk_review','seller',1,1)`,
        scope,
        scope,
      );
      for (const canceled of [0, 1]) {
        await execute(
          `INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ($1, $2, 'customer',$3,$4,'price',$5,'active',$6, $7,1,1)`,
          `${scope}:${canceled}`,
          scope,
          `${scope}:buyer:${canceled}`,
          scope,
          `${scope}:${canceled}`,
          canceled,
          NOW + 1000,
        );
      }
      assert.equal(await run(0), 0);
      const read = async () =>
        (
          await database.queryResult<{
            workflow_type: string;
            subscription_id: string;
            status: string;
            provider_completed_at_ms: number | null;
            reconciliation_requested_at_ms: number | null;
            completed_at_ms: number | null;
          }>(
            "SELECT workflow_type, subscription_id, status, provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms FROM commerce_financial_provider_actions WHERE connected_account_id=$1 ORDER BY workflow_type,subscription_id",
            [scope],
          )
        ).rows;
      const seeded = await read();
      assert.equal(seeded.length, 6);
      assert.deepEqual([...new Set(seeded.map((row) => row.workflow_type))].sort(), [
        "offering_retirement",
        "renewal_shutdown",
        "seller_offboarding",
      ]);
      for (const row of seeded) {
        const completed = row.subscription_id.endsWith(":1");
        assert.equal(row.status, completed ? "completed" : "pending");
        for (const timestamp of [
          row.provider_completed_at_ms,
          row.reconciliation_requested_at_ms,
          row.completed_at_ms,
        ]) {
          assert.equal(timestamp, completed ? NOW : null);
        }
      }
      assert.equal(await run(100), 3);
      assert.deepEqual(providerCalls, Array(3).fill(`${scope}:0`));
      assert.equal(reconciliationCalls, 3);
      const completed = await read();
      for (const row of completed) {
        assert.equal(row.status, "completed");
        assert.equal(row.provider_completed_at_ms, NOW);
        assert.equal(row.reconciliation_requested_at_ms, NOW);
        assert.equal(row.completed_at_ms, NOW);
      }
      assert.equal(await run(100), 0);
      assert.deepEqual(await read(), completed);
      assert.equal(providerCalls.length, 3);
      assert.equal(reconciliationCalls, 3);
    } finally {
      await postgres.close();
    }
  },
);
