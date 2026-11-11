import assert from "node:assert/strict";
import test from "node:test";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresBanAppealStore } from "../src/moderation-appeals/store";
import { defaultBanAppealConfig } from "../src/moderation-appeals/types";

const postgresUrl = process.env.TEST_POSTGRES_URL;
test(
  "PostgreSQL ban appeals enforce one open request, cooldowns, Guild scope, review revisions and durable operation receipts",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test"),
      "Use a disposable local database ending in _test.",
    );
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "4",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await initializePostgresSchema(database);
      const store = createPostgresBanAppealStore(database);
      const config = defaultBanAppealConfig("100");
      const id = crypto.randomUUID();
      const submission = {
        guildId: "100",
        id,
        userId: "101",
        displayName: "Appellant",
        text: "Please review the Discord server ban.",
        banReason: "Original ban reason",
        nowMs: 1_000,
      };
      assert.equal((await store.getConfig("100")).enabled, false);
      await assert.rejects(() => store.submit(submission), /not enabled/);
      await store.saveConfig("100", { ...config, enabled: true, cooldownHours: 1 }, 0);
      await store.saveConfig("110", { ...config, enabled: true, cooldownHours: 1 }, 0);
      await assert.rejects(() => store.saveConfig("100", config, 0), /changed/);
      const created = await Promise.all([
        store.submit(submission),
        store.submit({ ...submission, id: crypto.randomUUID() }),
      ]);
      assert.equal(created[0]!.id, created[1]!.id);
      const original = created[0]!;
      assert.equal((await store.list("100")).length, 1);
      assert.equal(await store.read("110", original.id), null);
      assert.equal(await store.latestForUser("100", "102"), null);
      await assert.rejects(
        () => store.submit({ ...submission, id: original.id, userId: "102" }),
        /identity is already in use/,
      );
      const reject = {
        guildId: "100",
        id: original.id,
        actorUserId: "303",
        reason: "Ban remains appropriate",
        action: "reject" as const,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        nowMs: 2_000,
      };
      await assert.rejects(() => store.claimReview({ ...reject, expectedRevision: 2 }), /changed/);
      assert.equal((await store.claimReview(reject)).appeal.status, "rejected");
      assert.equal((await store.claimReview(reject)).appeal.status, "rejected");
      assert.equal((await store.submit({ ...submission, id: original.id })).status, "rejected");
      await assert.rejects(
        () => store.submit({ ...submission, id: crypto.randomUUID(), nowMs: 3_000 }),
        /cooldown/,
      );
      const next = await store.submit({ ...submission, id: crypto.randomUUID(), nowMs: 3_601_000 });
      const unban = {
        ...reject,
        id: next.id,
        action: "unban" as const,
        operationId: crypto.randomUUID(),
        nowMs: 3_602_000,
      };
      const claims = await Promise.all([
        store.claimReview(unban),
        store.claimReview({ ...unban, actorUserId: "304", operationId: crypto.randomUUID() }),
      ]);
      assert.equal(claims.filter((claim) => claim.execute).length, 1);
      assert.equal(claims[0]!.operation?.id, claims[1]!.operation?.id);
      const operationId = claims[0]!.operation!.id;
      await assert.rejects(
        () =>
          store.claimReview({
            ...reject,
            id: next.id,
            expectedRevision: claims[0]!.appeal.revision,
            nowMs: 3_602_001,
          }),
        /still in progress/,
      );
      const pending = await store.finishUnban("100", next.id, operationId, "uncertain", 3_603_000);
      assert.equal(pending.status, "unban_pending");
      assert.equal(
        (await store.claimReview({ ...unban, expectedRevision: pending.revision })).execute,
        false,
      );
      const succeeded = await store.finishUnban(
        "100",
        next.id,
        operationId,
        "succeeded",
        3_604_000,
      );
      assert.equal(succeeded.status, "unbanned");
      assert.equal(
        (await store.finishUnban("100", next.id, operationId, "uncertain", 3_605_000)).status,
        "unbanned",
      );
      const operations = await store.operations("100", next.id);
      assert.equal(operations.length, 1);
      assert.equal(operations[0]?.outcome, "succeeded");
      assert.equal((await store.operations("110", next.id)).length, 0);
      await assert.rejects(
        () => store.claimReview({ ...reject, id: next.id, expectedRevision: succeeded.revision }),
        /already been resolved/,
      );
      await store.submit({ ...submission, guildId: "110", id: original.id });
      assert.equal((await store.list("110")).length, 1);
      assert.equal((await store.list("100")).length, 2);
    } finally {
      await database.close();
    }
  },
);
