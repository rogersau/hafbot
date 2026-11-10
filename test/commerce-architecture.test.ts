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
    readFileSync("src/db/commerce-schema.ts", "utf8") +
    readFileSync("src/db/commerce-game-access-schema.ts", "utf8");
  const migration = readdirSync("migrations/unified")
    .filter((name) => name.includes("commerce") && name.endsWith(".sql"))
    .map((name) => readFileSync(`migrations/unified/${name}`, "utf8"))
    .join("\n");
  for (const table of COMMERCE_TABLES) {
    assert.match(schema, new RegExp(`"${table}"`), `${table} must have a Drizzle schema`);
    assert.match(migration, new RegExp(`CREATE TABLE ${table}\\b`), `${table} must be migrated`);
  }
});

test("commerce code cannot write through premium billing or timed-role authority", () => {
  const commerceSources = [
    "src/commerce/types.ts",
    "src/commerce/store.ts",
    "src/runtime/cloudflare-commerce-store.ts",
    "src/db/commerce-schema.ts",
    ...readdirSync("src/runtime/commerce", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `src/runtime/commerce/${entry.name}`),
  ].map((file) => ({ file, source: readFileSync(file, "utf8") }));

  for (const { file, source } of commerceSources) {
    // Stripe names its connected-account customer portal endpoint
    // `billing_portal`; that provider path is not HAF's Premium billing domain.
    const withoutStripePortalPath = source.replaceAll("/v1/billing_portal/", "");
    assert.doesNotMatch(withoutStripePortalPath, /\bbilling_/, file);
    assert.doesNotMatch(source, /runtime\/billing|cloudflare-timed-role|guildEntitlements/, file);
    assert.doesNotMatch(source, /\btimedRoles\b/, file);
  }
});
