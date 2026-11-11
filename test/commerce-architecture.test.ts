/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

const COMMERCE_TABLES = [
  "commerce_game_fulfillments",
  "commerce_game_selections",
  "commerce_game_assignments",
  "commerce_game_audit",
  "commerce_store_branding",
  "commerce_connected_accounts",
  "commerce_sales_panels",
  "commerce_seller_acceptances",
  "commerce_offerings",
  "commerce_prices",
  "commerce_buyers",
  "commerce_customers",
  "commerce_checkout_attempts",
  "commerce_checkout_rate_limits",
  "commerce_support_configs",
  "commerce_support_checkout_attempts",
  "commerce_support_rate_limits",
  "commerce_support_payments",
  "commerce_support_refunds",
  "commerce_subscriptions",
  "commerce_entitlements",
  "commerce_role_assignments",
  "commerce_payments",
  "commerce_refunds",
  "commerce_disputes",
  "commerce_webhook_events",
  "commerce_sync_state",
  "commerce_operations_ledger",
  "commerce_delivery_outbox",
  "commerce_incidents",
  "commerce_financial_actions",
  "commerce_seller_offboarding",
  "commerce_support_disputes",
  "commerce_operational_controls",
  "commerce_checkout_capacity_claims",
  "commerce_limit_alerts",
  "commerce_reporting_ledger",
  "commerce_paid_role_provider_actions",
  "commerce_guild_deletion_refund_reviews",
] as const;

test("commerce persistence has its own complete table namespace", () => {
  const schema =
    readFileSync("src/db/postgres/commerce-schema.ts", "utf8") +
    readFileSync("src/db/postgres/commerce-game-access-schema.ts", "utf8");
  const schemaSql = readFileSync("schema/postgres.sql", "utf8");
  for (const table of COMMERCE_TABLES) {
    assert.match(schema, new RegExp(`"${table}"`), `${table} must have a Drizzle schema`);
    assert.match(
      schemaSql,
      new RegExp(`CREATE TABLE public\\.${table}\\b`),
      `${table} must be in the public schema`,
    );
  }
});

test("commerce code cannot write through premium billing or timed-role authority", () => {
  const commerceSources = [
    "src/commerce/types.ts",
    "src/commerce/store.ts",
    "src/runtime/postgres/postgres-commerce-store.ts",
    "src/db/postgres/commerce-schema.ts",
    ...readdirSync("src/runtime/commerce", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `src/runtime/commerce/${entry.name}`),
    ...readdirSync("src/runtime/postgres")
      .filter((name) => name.startsWith("postgres-commerce-") && name.endsWith(".ts"))
      .map((name) => `src/runtime/postgres/${name}`),
  ].map((file) => ({ file, source: readFileSync(file, "utf8") }));

  for (const { file, source } of commerceSources) {
    // Stripe names its connected-account customer portal endpoint
    // `billing_portal`; that provider path is not HAF's Premium billing domain.
    const withoutStripePortalPath = source.replaceAll("/v1/billing_portal/", "");
    assert.doesNotMatch(withoutStripePortalPath, /\bbilling_/, file);
    assert.doesNotMatch(source, /runtime\/billing|postgres-timed-role|guildEntitlements/, file);
    assert.doesNotMatch(source, /\btimedRoles\b/, file);
  }
});
