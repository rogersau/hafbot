import assert from "node:assert/strict";
import test from "node:test";

import {
  CommerceOfferingService,
  type CommerceOfferingProvider,
} from "../src/commerce/offering-service";
import {
  CommerceBuyerCheckoutService,
  type CommerceBuyerCheckoutProvider,
} from "../src/commerce/buyer-checkout";
import type { PostgresDatabaseCapability } from "../src/runtime/postgres/postgres-capability";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { PostgresCommerceBuyerCheckoutStore } from "../src/runtime/postgres/postgres-commerce-buyer-checkout-store";
import { PostgresCommerceOfferingStore } from "../src/runtime/postgres/postgres-commerce-offering-store";
import { PostgresPaidRoleStore } from "../src/runtime/postgres/postgres-commerce-paid-role-store";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const NOW = 1_900_000_000_000;
const TERMS = "seller-terms-2026-07";

test(
  "fresh schema stores one authoritative Offering lifecycle with no projection table",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database) => {
      const sideTable = await database.query<{ name: string | null }>(
        "SELECT to_regclass('public.commerce_offering_lifecycles')::text AS name",
      );
      assert.equal(sideTable[0]?.name, null);
      const sideIndexes = await database.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'commerce_offering_lifecycles'",
      );
      assert.deepEqual(sideIndexes, []);

      const columns = await database.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commerce_offerings' ORDER BY column_name",
      );
      assert.deepEqual(
        columns.map((column) => column.column_name),
        [
          "archived_at_ms",
          "connected_account_id",
          "created_at_ms",
          "description",
          "discord_role_id",
          "guild_id",
          "id",
          "included_benefits_json",
          "name",
          "published_at_ms",
          "purchase_type",
          "repair_deadline_at_ms",
          "repair_previous_state",
          "retire_at_ms",
          "role_manageable",
          "state",
          "support_contact",
          "terms_version",
          "updated_at_ms",
        ],
      );

      const constraints = await database.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conrelid = 'public.commerce_offerings'::regclass ORDER BY conname",
      );
      const names = constraints.map((constraint) => constraint.conname);
      for (const required of [
        "commerce_offerings_archived_check",
        "commerce_offerings_included_benefits_json_check",
        "commerce_offerings_purchase_type_check",
        "commerce_offerings_repair_previous_state_check",
        "commerce_offerings_repair_state_check",
        "commerce_offerings_retiring_check",
        "commerce_offerings_role_manageable_check",
        "commerce_offerings_state_check",
      ]) {
        assert.ok(names.includes(required), `missing ${required}`);
      }
      assert.equal(names.includes("commerce_offerings_status_check"), false);

      const indexes = await database.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'commerce_offerings'",
      );
      const publishedRole = indexes.find(
        (index) => index.indexname === "commerce_offerings_published_role",
      );
      assert.ok(publishedRole);
      assert.match(publishedRole.indexdef, /hidden|UNIQUE/i);
      assert.match(publishedRole.indexdef, /state = 'published'/);
      assert.match(publishedRole.indexdef, /state = 'repair_required'/);
      assert.match(publishedRole.indexdef, /repair_previous_state = 'published'/);
      const sellerState = indexes.find(
        (index) => index.indexname === "commerce_offerings_seller_state",
      );
      assert.ok(sellerState);
      assert.match(sellerState.indexdef, /connected_account_id, state/);
      assert.equal(
        indexes.some((index) => index.indexname === "commerce_offerings_active_role"),
        false,
      );

      await assert.rejects(
        () =>
          database.queryResult(
            `INSERT INTO commerce_offerings
              (id, connected_account_id, guild_id, discord_role_id, name, purchase_type, state, created_at_ms, updated_at_ms)
             VALUES ('retired-active', 'acct', 'guild', 'role', 'Old', 'subscription', 'active', 1, 1)`,
          ),
        /check constraint|commerce_offerings_state_check/i,
      );
      await assert.rejects(
        () =>
          database.queryResult(
            `INSERT INTO commerce_offerings
              (id, connected_account_id, guild_id, discord_role_id, name, purchase_type, state, created_at_ms, updated_at_ms)
             VALUES ('bad-repair', 'acct', 'guild', 'role', 'Repair', 'subscription', 'repair_required', 1, 1)`,
          ),
        /commerce_offerings_repair_state_check/i,
      );
      await assert.rejects(
        () =>
          database.queryResult(
            `INSERT INTO commerce_offerings
              (id, connected_account_id, guild_id, discord_role_id, name, purchase_type, state, created_at_ms, updated_at_ms)
             VALUES ('bad-archive', 'acct', 'guild', 'role', 'Archive', 'subscription', 'archived', 1, 1)`,
          ),
        /commerce_offerings_archived_check/i,
      );
      await assert.rejects(
        () =>
          database.queryResult(
            `INSERT INTO commerce_offerings
              (id, connected_account_id, guild_id, discord_role_id, name, purchase_type, state, created_at_ms, updated_at_ms)
             VALUES ('bad-retiring', 'acct', 'guild', 'role', 'Retiring', 'subscription', 'retiring', 1, 1)`,
          ),
        /commerce_offerings_retiring_check/i,
      );
      const inserted = await database.queryResult<{ state: string }>(
        `INSERT INTO commerce_offerings
          (id, connected_account_id, guild_id, discord_role_id, name, purchase_type, state, terms_version,
           included_benefits_json, support_contact, role_manageable, published_at_ms, created_at_ms, updated_at_ms)
         VALUES ('current-published', 'acct', 'guild', 'role', 'Current', 'subscription', 'published',
           'v1', '["Access"]', 'seller@example.test', 1, 10, 1, 1)
         RETURNING state`,
      );
      assert.equal(inserted.rows[0]?.state, "published");
    });
  },
);

test(
  "draft publication transitions and checkout gates use the one current lifecycle",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database) => {
      const seller = await seedSeller(database, "one");
      const service = offeringService(database);
      const created = await service.createDraft({
        connectedAccountId: seller.accountId,
        guildId: seller.guildId,
        discordRoleId: "role-main",
        name: "Gold",
        includedBenefits: ["Private role"],
        supportContact: "seller@example.test",
        currency: "AUD",
        unitAmountMinor: 500,
        recurringInterval: "month",
        roleManageable: true,
        termsVersion: TERMS,
      });
      assert.equal(created.offering.state, "draft");
      assert.equal(created.offering.publishedAtMs, null);

      const published = await service.publish(created.offering.id);
      assert.equal(published.state, "published");
      assert.equal(published.publishedAtMs, NOW);
      await assert.rejects(() => service.publish(created.offering.id), /publish_invalid_state/);

      const checkoutStore = new PostgresCommerceBuyerCheckoutStore(database, {
        async isPremium() {
          return true;
        },
      });
      const buyer = new CommerceBuyerCheckoutService(
        checkoutStore,
        {} as CommerceBuyerCheckoutProvider,
        { async request() {} },
        undefined,
        () => NOW,
      );
      assert.deepEqual(
        (await buyer.storefrontsForGuild(seller.guildId)).map((sf) => sf.offering.id),
        [created.offering.id],
      );
      const otherSeller = await seedSeller(database, "other");
      const otherOffering = await createDraftFor(
        service,
        otherSeller,
        "role-other-guild",
        "Other guild",
      );
      await service.publish(otherOffering.offering.id);
      assert.deepEqual(
        (await buyer.storefrontsForGuild(otherSeller.guildId)).map((sf) => sf.offering.id),
        [otherOffering.offering.id],
      );
      assert.equal(
        (await buyer.storefrontsForGuild(seller.guildId)).some(
          (sf) => sf.offering.id === otherOffering.offering.id,
        ),
        false,
      );
      const publishContextStore = new PostgresCommerceOfferingStore(database, {
        async isPremium() {
          return true;
        },
      });
      assert.equal(
        (
          await publishContextStore.readPublishContext(
            seller.accountId,
            seller.guildId,
            created.offering.id,
          )
        ).sellerEligible,
        true,
      );
      assert.equal(
        (
          await publishContextStore.readPublishContext(
            otherSeller.accountId,
            otherSeller.guildId,
            created.offering.id,
          )
        ).sellerEligible,
        false,
      );

      for (const state of ["suspended", "retiring"] as const) {
        await database.queryResult(
          `UPDATE commerce_offerings SET state = $1, retire_at_ms = $2 WHERE id = $3`,
          [state, state === "retiring" ? NOW + 60_000 : null, created.offering.id],
        );
        assert.deepEqual(await buyer.storefrontsForGuild(seller.guildId), []);
        await assert.rejects(
          () =>
            buyer.startSubscriptionCheckout({
              offeringId: created.offering.id,
              discordUserId: "123456789012345678",
              checkoutAttemptId: "attempt-unavailable",
              successUrl: "https://example.test/return",
              cancelUrl: "https://example.test/cancel",
              preflight: VALID_PREFLIGHT,
            }),
          /commerce_offering_not_purchasable/,
        );
      }
      await database.queryResult(
        `UPDATE commerce_offerings
            SET state = 'repair_required', repair_previous_state = 'published', retire_at_ms = NULL,
                repair_deadline_at_ms = $1
          WHERE id = $2`,
        [NOW + 60_000, created.offering.id],
      );
      assert.deepEqual(await buyer.storefrontsForGuild(seller.guildId), []);

      await database.queryResult(
        `UPDATE commerce_offerings
            SET state = 'published', repair_previous_state = NULL, repair_deadline_at_ms = NULL
          WHERE id = $1`,
        [created.offering.id],
      );
      const unpublished = await service.unpublish(created.offering.id);
      assert.equal(unpublished.state, "unpublished");
      assert.equal(unpublished.publishedAtMs, NOW);
      await assert.rejects(() => service.unpublish(created.offering.id), /invalid_state/);
      const retiring = await service.retire({
        offeringId: created.offering.id,
        actorUserId: "seller-owner",
        reasonCode: "seller_requested",
        actionId: "retire-transition",
        retireAtMs: NOW + 60_000,
      });
      assert.equal(retiring.state, "retiring");
      await assert.rejects(() => service.archive(created.offering.id), /active_subscriptions/);
      await database.queryResult(
        "UPDATE commerce_offering_retirements SET status = 'complete', completed_at_ms = $1 WHERE offering_id = $2",
        [NOW + 1, created.offering.id],
      );
      assert.equal((await service.archive(created.offering.id)).state, "archived");

      const archivedDraft = await service.createDraft({
        connectedAccountId: seller.accountId,
        guildId: seller.guildId,
        discordRoleId: "role-draft-archive",
        name: "Draft archive",
        includedBenefits: ["Access"],
        supportContact: "seller@example.test",
        currency: "AUD",
        unitAmountMinor: 500,
        recurringInterval: "month",
        roleManageable: true,
        termsVersion: TERMS,
      });
      assert.equal((await service.archive(archivedDraft.offering.id)).state, "archived");

      const guarded = await service.createDraft({
        connectedAccountId: seller.accountId,
        guildId: seller.guildId,
        discordRoleId: "role-guarded-archive",
        name: "Guarded archive",
        includedBenefits: ["Access"],
        supportContact: "seller@example.test",
        currency: "AUD",
        unitAmountMinor: 500,
        recurringInterval: "month",
        roleManageable: true,
        termsVersion: TERMS,
      });
      await seedSubscription(database, seller, guarded.offering.id, "sub-guarded");
      await assert.rejects(() => service.archive(guarded.offering.id), /active_subscriptions/);
      await database.queryResult(
        "UPDATE commerce_subscriptions SET status = 'canceled', ended_at_ms = $1 WHERE id = 'sub-guarded'",
        [NOW],
      );
      assert.equal((await service.archive(guarded.offering.id)).state, "archived");
    });
  },
);

test(
  "repair records the original state once and restores published and unpublished exactly",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database) => {
      const seller = await seedSeller(database, "repair");
      const service = offeringService(database);
      const paidRole = new PostgresPaidRoleStore(database);

      const repairPublished = await service.createDraft({
        connectedAccountId: seller.accountId,
        guildId: seller.guildId,
        discordRoleId: "role-published",
        name: "Published repair",
        includedBenefits: ["Access"],
        supportContact: "seller@example.test",
        currency: "AUD",
        unitAmountMinor: 500,
        recurringInterval: "month",
        roleManageable: true,
        termsVersion: TERMS,
      });
      await service.publish(repairPublished.offering.id);
      await seedAssignment(
        database,
        seller,
        repairPublished.offering.id,
        "role-published",
        "ent-published",
      );

      const first = await service.replaceRole({
        offeringId: repairPublished.offering.id,
        discordRoleId: "role-published-2",
      });
      assert.equal(first.status, "replacement_pending");
      assert.equal(first.offering.state, "repair_required");
      assert.equal(first.offering.repairPreviousState, "published");
      const firstRepair = (await paidRole.listPendingRoleRepairs()).find(
        (repair) => repair.offeringId === repairPublished.offering.id,
      );
      assert.ok(firstRepair);
      await paidRole.enqueueRoleRepair({ ...firstRepair, updatedAtMs: NOW + 1 });
      const afterRepairProgress = await service.dashboard(seller.accountId);
      assert.equal(
        afterRepairProgress.offerings.find((row) => row.offering.id === repairPublished.offering.id)
          ?.offering.repairPreviousState,
        "published",
      );
      const repeated = await service.replaceRole({
        offeringId: repairPublished.offering.id,
        discordRoleId: "role-published-3",
      });
      assert.equal(repeated.status, "replacement_pending");
      assert.equal(repeated.offering.repairPreviousState, "published");
      assert.equal(repeated.offering.state, "repair_required");
      const publishedRepair = (await paidRole.listPendingRoleRepairs()).find(
        (repair) => repair.offeringId === repairPublished.offering.id,
      );
      assert.ok(publishedRepair);
      assert.equal(publishedRepair.replacementRoleId, "role-published-3");
      await paidRole.completeRoleRepair({ ...publishedRepair, repairedCount: 1 }, NOW + 1);
      const restoredPublished = await service.dashboard(seller.accountId);
      const publishedRow = restoredPublished.offerings.find(
        (row) => row.offering.id === repairPublished.offering.id,
      );
      assert.equal(publishedRow?.offering.state, "published");
      assert.equal(publishedRow?.offering.discordRoleId, "role-published-3");
      assert.equal(publishedRow?.offering.repairPreviousState, null);
      assert.equal(publishedRow?.offering.repairDeadlineAtMs, null);

      const repairUnpublished = await service.createDraft({
        connectedAccountId: seller.accountId,
        guildId: seller.guildId,
        discordRoleId: "role-unpublished",
        name: "Unpublished repair",
        includedBenefits: ["Access"],
        supportContact: "seller@example.test",
        currency: "AUD",
        unitAmountMinor: 500,
        recurringInterval: "month",
        roleManageable: true,
        termsVersion: TERMS,
      });
      await service.publish(repairUnpublished.offering.id);
      const unpublished = await service.unpublish(repairUnpublished.offering.id);
      assert.equal(unpublished.publishedAtMs, NOW);
      await seedAssignment(
        database,
        seller,
        repairUnpublished.offering.id,
        "role-unpublished",
        "ent-unpublished",
      );
      const pending = await service.replaceRole({
        offeringId: repairUnpublished.offering.id,
        discordRoleId: "role-unpublished-2",
      });
      assert.equal(pending.offering.state, "repair_required");
      assert.equal(pending.offering.repairPreviousState, "unpublished");
      assert.equal(pending.offering.publishedAtMs, NOW);
      const unpublishedRepair = (await paidRole.listPendingRoleRepairs()).find(
        (repair) => repair.offeringId === repairUnpublished.offering.id,
      );
      assert.ok(unpublishedRepair);
      await paidRole.completeRoleRepair({ ...unpublishedRepair, repairedCount: 1 }, NOW + 2);
      const restoredUnpublished = await service.dashboard(seller.accountId);
      const unpublishedRow = restoredUnpublished.offerings.find(
        (row) => row.offering.id === repairUnpublished.offering.id,
      );
      assert.equal(unpublishedRow?.offering.state, "unpublished");
      assert.equal(unpublishedRow?.offering.publishedAtMs, NOW);
      assert.equal(unpublishedRow?.offering.discordRoleId, "role-unpublished-2");
    });
  },
);

test(
  "competing publications for one Guild and role admit exactly one owner",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database) => {
      const seller = await seedSeller(database, "race");
      const service = offeringService(database);
      const first = await createDraftFor(service, seller, "role-race", "First race");
      const second = await createDraftFor(service, seller, "role-race", "Second race");
      const results = await Promise.allSettled([
        database.queryResult(
          "UPDATE commerce_offerings SET state = 'published', published_at_ms = $1 WHERE id = $2",
          [NOW, first.offering.id],
        ),
        database.queryResult(
          "UPDATE commerce_offerings SET state = 'published', published_at_ms = $1 WHERE id = $2",
          [NOW, second.offering.id],
        ),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const rows = await database.query<{
        id: string;
        state: string;
        published_at_ms: number | null;
      }>(
        "SELECT id, state, published_at_ms FROM commerce_offerings WHERE id = $1 OR id = $2 ORDER BY id",
        [first.offering.id, second.offering.id],
      );
      assert.equal(rows.filter((row) => row.state === "published").length, 1);
      assert.equal(rows.filter((row) => row.state === "draft").length, 1);
      const winner = rows.find((row) => row.state === "published");
      const loser = rows.find((row) => row.state === "draft");
      assert.ok(winner && loser);
      assert.equal(Number(winner.published_at_ms), NOW);
      assert.equal(loser.published_at_ms, null);
      await assert.rejects(
        () => service.publish(loser.id),
        /commerce_offering_role_already_published/,
      );
    });
  },
);

test(
  "a late retirement write failure rolls back the Offering, retirement and outbox before retry",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database) => {
      const seller = await seedSeller(database, "rollback");
      const service = offeringService(database);
      const created = await createDraftFor(service, seller, "role-rollback", "Rollback");
      await service.publish(created.offering.id);
      await seedSubscription(database, seller, created.offering.id, "sub-rollback");
      await database.execute(`
        CREATE FUNCTION haf_c23_fail_provider_action() RETURNS trigger
          LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected late provider-action failure';
        END;
        $$;
        CREATE TRIGGER haf_c23_fail_provider_action
          BEFORE INSERT ON commerce_financial_provider_actions
          FOR EACH ROW EXECUTE FUNCTION haf_c23_fail_provider_action();
      `);
      await assert.rejects(
        () =>
          service.retire({
            offeringId: created.offering.id,
            actorUserId: "seller-owner",
            reasonCode: "seller_requested",
            actionId: "retire-rollback",
            retireAtMs: NOW + 60_000,
          }),
        /injected late provider-action failure/,
      );
      const afterFailure = await database.query<{
        state: string;
        retire_at_ms: number | null;
        published_at_ms: number | null;
      }>("SELECT state, retire_at_ms, published_at_ms FROM commerce_offerings WHERE id = $1", [
        created.offering.id,
      ]);
      assert.deepEqual(afterFailure[0], {
        state: "published",
        retire_at_ms: null,
        published_at_ms: NOW,
      });
      assert.equal(await countRows(database, "commerce_offering_retirements"), 0);
      assert.equal(await countRows(database, "commerce_financial_provider_actions"), 0);
      assert.equal(await countRows(database, "commerce_operations_ledger"), 0);

      await database.execute(
        "DROP TRIGGER haf_c23_fail_provider_action ON commerce_financial_provider_actions; DROP FUNCTION haf_c23_fail_provider_action();",
      );
      const retired = await service.retire({
        offeringId: created.offering.id,
        actorUserId: "seller-owner",
        reasonCode: "seller_requested",
        actionId: "retire-rollback",
        retireAtMs: NOW + 60_000,
      });
      assert.equal(retired.state, "retiring");
      assert.equal(retired.retireAtMs, NOW + 60_000);
      assert.equal(await countRows(database, "commerce_offering_retirements"), 1);
      assert.equal(await countRows(database, "commerce_financial_provider_actions"), 1);
    });
  },
);

async function withPostgres(operation: (database: PostgresDatabaseCapability) => Promise<void>) {
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
    await initializePostgresSchema(database);
    await operation(database);
  } finally {
    await database.close();
  }
}

function offeringService(database: PostgresDatabaseCapability): CommerceOfferingService {
  return new CommerceOfferingService(
    new PostgresCommerceOfferingStore(database, {
      async isPremium() {
        return true;
      },
    }),
    new FixtureOfferingProvider(),
    () => NOW,
    idSequence(),
  );
}

class FixtureOfferingProvider implements CommerceOfferingProvider {
  private sequence = 0;
  async createProduct() {
    return { id: `prod_${++this.sequence}`, createdAtMs: NOW };
  }
  async createPrice() {
    return { id: `price_${++this.sequence}`, createdAtMs: NOW };
  }
}

function idSequence(): () => string {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

async function createDraftFor(
  service: CommerceOfferingService,
  seller: { accountId: string; guildId: string },
  discordRoleId: string,
  name: string,
) {
  return service.createDraft({
    connectedAccountId: seller.accountId,
    guildId: seller.guildId,
    discordRoleId,
    name,
    includedBenefits: ["Access"],
    supportContact: "seller@example.test",
    currency: "AUD",
    unitAmountMinor: 500,
    recurringInterval: "month",
    roleManageable: true,
    termsVersion: TERMS,
  });
}

async function seedSeller(
  database: PostgresDatabaseCapability,
  suffix: string,
): Promise<{ accountId: string; guildId: string }> {
  const accountId = `acct-${suffix}`;
  const guildId = `guild-${suffix}`;
  await database.queryResult(
    `INSERT INTO commerce_connected_accounts
      (id, guild_id, stripe_account_id, status, country, default_currency,
       charges_enabled, payouts_enabled, details_submitted, created_at_ms, updated_at_ms)
     VALUES ($1, $2, $1, 'active', 'AU', 'AUD', 1, 1, 1, $3, $3)`,
    [accountId, guildId, NOW],
  );
  await database.queryResult(
    `INSERT INTO commerce_seller_profiles
      (connected_account_id, guild_id, lifecycle_state, approval_state, support_contact,
       adult_attested_at_ms, two_factor_evidence, guild_created_at_ms, ownership_transferred_at_ms,
       guild_good_standing, seller_good_standing, requirements_currently_due_json,
       requirements_eventually_due_json, requirements_pending_verification_json, disabled_reason,
       reviewed_by_user_id, reviewed_at_ms, capabilities_updated_at_ms, created_at_ms, updated_at_ms)
     VALUES ($1, $2, 'active', 'approved', 'seller@example.test', $3, 'discord_verified',
       $3, NULL, 1, 1, '[]', '[]', '[]', NULL, 'operator', $3, $3, $3, $3)`,
    [accountId, guildId, NOW],
  );
  await database.queryResult(
    `INSERT INTO commerce_seller_acceptances
      (id, connected_account_id, terms_version, accepted_by_user_id, accepted_at_ms, created_at_ms)
     VALUES ($1, $2, $3, 'seller-owner', $4, $4)`,
    [`acceptance-${suffix}`, accountId, TERMS, NOW],
  );
  return { accountId, guildId };
}

async function seedAssignment(
  database: PostgresDatabaseCapability,
  seller: { accountId: string; guildId: string },
  offeringId: string,
  discordRoleId: string,
  entitlementId: string,
) {
  const buyerId = `buyer-${entitlementId}`;
  await database.queryResult(
    `INSERT INTO commerce_buyers(id, discord_user_id, created_at_ms, updated_at_ms)
     VALUES ($1, $1, $2, $2)`,
    [buyerId, NOW],
  );
  await database.queryResult(
    `INSERT INTO commerce_entitlements
      (id, connected_account_id, buyer_id, offering_id, source_type, source_id, status,
       effective_at_ms, created_at_ms, updated_at_ms)
     VALUES ($1, $2, $3, $4, 'subscription', $1, 'active', $5, $5, $5)`,
    [entitlementId, seller.accountId, buyerId, offeringId, NOW],
  );
  await database.queryResult(
    `INSERT INTO commerce_role_assignments
      (id, entitlement_id, guild_id, discord_user_id, discord_role_id, status,
       attempt_count, assigned_at_ms, created_at_ms, updated_at_ms)
     VALUES ($1, $2, $3, $4, $5, 'assigned', 1, $6, $6, $6)`,
    [`assignment-${entitlementId}`, entitlementId, seller.guildId, buyerId, discordRoleId, NOW],
  );
}

async function seedSubscription(
  database: PostgresDatabaseCapability,
  seller: { accountId: string; guildId: string },
  offeringId: string,
  subscriptionId: string,
) {
  await database.queryResult(
    `INSERT INTO commerce_subscriptions
      (id, connected_account_id, customer_id, buyer_id, offering_id, price_id,
       stripe_subscription_id, status, cancel_at_period_end, current_period_end_ms,
       created_at_ms, updated_at_ms)
     VALUES ($1, $2, $1, $1, $3, $1, $1, 'active', 0, $4, $5, $5)`,
    [subscriptionId, seller.accountId, offeringId, NOW + 86_400_000, NOW],
  );
}

async function countRows(database: PostgresDatabaseCapability, table: string): Promise<number> {
  const rows = await database.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(rows[0]?.count ?? 0);
}

const VALID_PREFLIGHT = {
  memberPresent: true,
  memberIsBot: false,
  memberBanned: false,
  roleManageable: true,
};
