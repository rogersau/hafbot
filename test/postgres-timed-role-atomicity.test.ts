import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresTimedRoleStore } from "../src/runtime/postgres/postgres-timed-role-store";
import type { PostgresDatabaseCapability } from "../src/runtime/postgres/postgres-capability";
import { withFreshPostgres } from "./support/postgres";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const postgresOptions = { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" };

test(
  "native timed-role rule replacement is scoped to one Guild and config type",
  postgresOptions,
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresTimedRoleStore(database);
      const newMemberRules = [
        { roleId: "role-new-a", durationInput: "2h" },
        { roleId: "role-new-b", durationInput: "1d", dmMessage: "Welcome {user}" },
      ];
      const manualRules = [{ roleId: "role-manual", durationInput: "3h" }];
      const otherGuildRules = [{ roleId: "role-other", durationInput: "4h" }];

      await store.upsertTimedRoleConfigRules("guild-1", "new-member", newMemberRules);
      await store.upsertTimedRoleConfigRules("guild-1", "manual-assignment", manualRules);
      await store.upsertTimedRoleConfigRules("guild-2", "new-member", otherGuildRules);

      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-1", "new-member"),
        newMemberRules,
      );
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-1", "manual-assignment"),
        manualRules,
      );
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-2", "new-member"),
        otherGuildRules,
      );
      assert.deepEqual(await store.readTimedRoleConfigRules("guild-2", "manual-assignment"), []);

      const replacement = [{ roleId: "role-new-c", durationInput: "30m" }];
      await store.upsertTimedRoleConfigRules("guild-1", "new-member", replacement);

      assert.deepEqual(await store.readTimedRoleConfigRules("guild-1", "new-member"), replacement);
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-1", "manual-assignment"),
        manualRules,
        "manual-assignment rules must remain independent of new-member replacement",
      );
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-2", "new-member"),
        otherGuildRules,
        "another Guild's rules must remain independent",
      );

      await store.upsertTimedRoleConfigRules("guild-1", "new-member", []);
      assert.deepEqual(await store.readTimedRoleConfigRules("guild-1", "new-member"), []);
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-1", "manual-assignment"),
        manualRules,
      );
    });
  },
);

test(
  "native timed-role rule replacement preserves prior rules when the insert fails",
  postgresOptions,
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresTimedRoleStore(database);
      const previousRules = [
        { roleId: "role-old-a", durationInput: "2h" },
        { roleId: "role-old-b", durationInput: "1h", enabled: false },
      ];
      const manualRules = [{ roleId: "role-manual", durationInput: "3h" }];
      const otherGuildRules = [{ roleId: "role-other", durationInput: "4h" }];

      await store.upsertTimedRoleConfigRules("guild-1", "new-member", previousRules);
      await store.upsertTimedRoleConfigRules("guild-1", "manual-assignment", manualRules);
      await store.upsertTimedRoleConfigRules("guild-2", "new-member", otherGuildRules);

      await database.execute(`
        CREATE FUNCTION haf_test_reject_timed_role_rule() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.role_id = 'reject-role' THEN
            RAISE EXCEPTION 'injected timed-role rule insert failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await database.execute(`
        CREATE TRIGGER haf_test_reject_timed_role_rule
        BEFORE INSERT ON timed_role_config_rules
        FOR EACH ROW EXECUTE FUNCTION haf_test_reject_timed_role_rule()
      `);
      try {
        await assert.rejects(
          store.upsertTimedRoleConfigRules("guild-1", "new-member", [
            { roleId: "replacement-role", durationInput: "30m" },
            { roleId: "reject-role", durationInput: "30m" },
          ]),
          (error: unknown) => {
            const message =
              error instanceof Error
                ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
                : String(error);
            return /injected timed-role rule insert failure/.test(message);
          },
        );
      } finally {
        await database.execute(
          "DROP TRIGGER haf_test_reject_timed_role_rule ON timed_role_config_rules",
        );
        await database.execute("DROP FUNCTION haf_test_reject_timed_role_rule()");
      }

      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-1", "new-member"),
        previousRules,
        "a failed insert must roll back the delete instead of leaving an empty or partial set",
      );
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-1", "manual-assignment"),
        manualRules,
      );
      assert.deepEqual(
        await store.readTimedRoleConfigRules("guild-2", "new-member"),
        otherGuildRules,
      );

      const replacement = [{ roleId: "replacement-role", durationInput: "30m" }];
      await store.upsertTimedRoleConfigRules("guild-1", "new-member", replacement);
      assert.deepEqual(await store.readTimedRoleConfigRules("guild-1", "new-member"), replacement);
    });
  },
);

test(
  "native timed-role rule replacement serializes competing whole-set writers",
  postgresOptions,
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresTimedRoleStore(database);
      const guildId = "guild-timed-role-race";
      const manualRules = [{ roleId: "role-manual", durationInput: "3h" }];
      const firstRules = [
        { roleId: "role-first-a", durationInput: "1h" },
        { roleId: "role-first-b", durationInput: "2h" },
      ];
      const secondRules = [
        { roleId: "role-second-a", durationInput: "3h" },
        { roleId: "role-second-b", durationInput: "4h" },
      ];

      await store.upsertTimedRoleConfigRules(guildId, "manual-assignment", manualRules);
      await database.execute(`
        CREATE FUNCTION haf_test_pause_timed_role_rule() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(73198211, 1);
          RETURN NEW;
        END;
        $$
      `);
      await database.execute(`
        CREATE TRIGGER haf_test_pause_timed_role_rule
        BEFORE INSERT ON timed_role_config_rules
        FOR EACH ROW EXECUTE FUNCTION haf_test_pause_timed_role_rule()
      `);

      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let markGateReady!: () => void;
      const gateReady = new Promise<void>((resolve) => {
        markGateReady = resolve;
      });
      const blocker = database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(73198211, 1)");
        markGateReady();
        await gate;
      });

      let firstWriter: Promise<void> | undefined;
      let secondWriter: Promise<void> | undefined;
      try {
        await Promise.race([gateReady, blocker]);
        firstWriter = store.upsertTimedRoleConfigRules(guildId, "new-member", firstRules);
        const firstWaiting = await waitForTimedRoleRuleWait(database, "rule insert");
        assert.equal(firstWaiting, true);
        assert.deepEqual(await store.readTimedRoleConfigRules(guildId, "new-member"), []);

        secondWriter = store.upsertTimedRoleConfigRules(guildId, "new-member", secondRules);
        const secondWaiting = await waitForTimedRoleRuleWait(database, "replacement lock");
        assert.equal(
          secondWaiting,
          true,
          "the competing replacement must wait for the first replacement's transaction",
        );
      } finally {
        releaseGate();
        await Promise.allSettled([blocker, firstWriter, secondWriter]);
        await database.execute(
          "DROP TRIGGER haf_test_pause_timed_role_rule ON timed_role_config_rules",
        );
        await database.execute("DROP FUNCTION haf_test_pause_timed_role_rule()");
      }

      await firstWriter;
      await secondWriter;
      assert.deepEqual(
        await store.readTimedRoleConfigRules(guildId, "new-member"),
        secondRules,
        "competing replacements must leave one complete rule set, not a mixture",
      );
      assert.deepEqual(
        await store.readTimedRoleConfigRules(guildId, "manual-assignment"),
        manualRules,
      );
      const rows = await database.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM timed_role_config_rules WHERE guild_id = $1",
        [guildId],
      );
      assert.equal(rows[0]?.count, "3");
    });
  },
);

async function waitForTimedRoleRuleWait(
  database: PostgresDatabaseCapability,
  expected: "rule insert" | "replacement lock",
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  const pattern =
    expected === "rule insert" ? "%timed_role_config_rules%" : "%pg_advisory_xact_lock%";
  while (Date.now() < deadline) {
    const rows = await database.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE $1
       ) AS blocked`,
      [pattern],
    );
    if (rows[0]?.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected the timed-role ${expected} to wait for a database lock`);
}
