import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresExecutor,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { createPostgresObservationStore } from "../src/runtime/attendance-observation-runtime";
import { createPostgresWardogsStore } from "../src/runtime/postgres/postgres-wardogs-store";
import { WardogsService } from "../src/wardogs/service";
import {
  emptyTotals,
  observationMemberKey,
  type ObservationRun,
  type Observation,
} from "../src/server-levels/observations/model";
const url = process.env.TEST_POSTGRES_URL;
test(
  "native PostgreSQL observation claims, sample commits, generation fences and retention",
  { skip: !url },
  async (t) => {
    assert.ok(url);
    assert.match(new URL(url).pathname, /_test$/);
    const db = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: url,
      NODE_ENV: "test",
    });
    try {
      await applyPostgresMigrations(
        db,
        await readPostgresMigrations(resolve("migrations/postgres")),
      );
      const effectTables = [
        "server_level_earning_sessions",
        "server_level_awards",
        "server_level_member_totals",
        "server_level_daily_summaries",
        "server_level_announcement_outbox",
        "commerce_game_assignments",
        "commerce_game_fulfillments",
        "commerce_role_assignments",
      ];
      const effectsBefore = await Promise.all(
        effectTables.map(
          async (table) =>
            (await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`))[0].count,
        ),
      );
      const targets = createPostgresWardogsStore(db);
      const wardogs = new WardogsService({ store: targets, runtime: "portable" });
      const guildId = crypto.randomUUID();
      const target = await wardogs.create(guildId, "Fixture", null);
      const store = createPostgresObservationStore(db);
      const run: ObservationRun = {
        id: crypto.randomUUID(),
        guildId,
        targetId: target.id,
        generation: target.generation,
        actorId: "synthetic-admin",
        createdAtMs: 100000,
        expiresAtMs: 1000000,
        deleteAtMs: 2000000,
        stoppedAtMs: null,
        state: "running",
        stopReason: null,
        nextAtMs: 100000,
        revision: 1,
        lease: null,
        slot: null,
        configuredCapacity: null,
        evidence: {
          sourceRevision: "cb899a1e4f5430d4e14f2e545877894b3cf50418",
          serverBuild: "fixture",
          hostEvidence: "synthetic-fixture",
        },
        totals: emptyTotals(),
      };
      await store.start(run);
      const claims = await Promise.all([store.claim(run, 100000), store.claim(run, 100000)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claim = claims.find(Boolean)!;
      const sample: Observation = {
        id: `${run.id}:${claim.slot}`,
        runId: run.id,
        guildId,
        targetId: target.id,
        generation: target.generation,
        slot: claim.slot!,
        observedAtMs: 105000,
        status: {
          startedAtMs: 100000,
          finishedAtMs: 100000,
          population: 0,
          capacity: 64,
          error: null,
        },
        roster: {
          startedAtMs: 105000,
          finishedAtMs: 105000,
          count: 0,
          completeness: "complete",
          error: null,
        },
        linkedSubjects: [
          {
            steamId: "76561198000000001",
            assurance: "administrative",
            memberKey: await observationMemberKey(guildId, "synthetic-admin"),
          },
        ],
        identityCoverage: "complete",
        queue: { state: "unknown", count: null },
        continuity: { state: "unknown", sessionId: null },
        countDisagreement: false,
        capacityMismatch: false,
        matchSeconds: 0,
        map: null,
        possibleMatchBoundary: false,
      };
      assert.equal(
        await store.finish({ ...claim, totals: { ...claim.totals, samples: 1 } }, sample, 105000),
        true,
      );
      assert.equal((await store.samples(run.id, 105000)).length, 1);
      const fresh = (await store.read(run.id))!;
      const next = await store.claim(fresh, 200000);
      assert.ok(next);
      let entered!: () => void, resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const gatedDatabase: PostgresDatabaseCapability = {
        kind: db.kind,
        drizzle: db.drizzle,
        query: db.query.bind(db),
        queryResult: db.queryResult.bind(db),
        execute: db.execute.bind(db),
        isReady: db.isReady.bind(db),
        close: db.close.bind(db),
        transaction: <T>(operation: (tx: PostgresExecutor) => Promise<T>) =>
          db.transaction(async (tx) =>
            operation({
              query: tx.query.bind(tx),
              queryResult: tx.queryResult.bind(tx),
              async execute(sql, values) {
                const result = await tx.execute(sql, values);
                if (sql.startsWith("UPDATE attendance_observation_samples")) {
                  entered();
                  await released;
                }
                return result;
              },
            }),
          ),
      };
      const committing = createPostgresObservationStore(gatedDatabase).finish(
        { ...next, totals: { ...next.totals, samples: 2 } },
        { ...sample, id: `${run.id}:${next.slot}`, slot: next.slot! },
        205000,
      );
      await paused;
      const changing = wardogs.change({
        guildId,
        targetId: target.id,
        generation: target.generation,
        name: "Changed generation",
      });
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (
            await db.query<{ blocked: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE wardogs_targets SET%') AS blocked",
            )
          )[0].blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          blocked,
          true,
          "target generation must remain locked through both observation writes",
        );
        assert.equal(
          (await store.samples(run.id, 205000)).length,
          1,
          "partial transaction remains invisible",
        );
      } finally {
        resume();
      }
      assert.equal(await committing, true);
      await changing;
      const third = await store.claim((await store.read(run.id))!, 300000);
      assert.ok(third);
      assert.equal(
        await store.finish(
          { ...third, totals: { ...third.totals, samples: 3 } },
          { ...sample, id: `${run.id}:${third.slot}`, slot: third.slot! },
          305000,
        ),
        false,
      );
      assert.equal((await store.samples(run.id, 305000)).length, 2);
      assert.equal((await store.report(run.id))?.totals.lateResultsDiscarded, 1);
      await store.eraseMember(
        guildId,
        "synthetic-admin",
        await observationMemberKey(guildId, "synthetic-admin"),
      );
      assert.deepEqual(await store.samples(run.id, 305000), []);
      assert.equal((await store.read(run.id))?.actorId, null);
      await store.cleanup(1e9);
      assert.equal(await store.read(run.id), null);
      assert.equal((await store.report(run.id))?.totals.samples, 2);
      await store.eraseGuild(guildId);
      assert.equal(await store.report(run.id), null);
      const startRun = async (targetId: string, generation: number, at: number) =>
        store.start({
          ...run,
          id: crypto.randomUUID(),
          targetId,
          generation,
          createdAtMs: at,
          nextAtMs: at,
          expiresAtMs: at + 3600000,
          deleteAtMs: at + 604800000,
        });
      await t.test(
        "concurrent durable admission preserves cadence across stop, lease expiry and generation changes",
        async () => {
          const source = await wardogs.create(guildId, "Cadence fixture", null);
          const first = await startRun(source.id, source.generation, 110000);
          const claims = await Promise.all([
            store.claim(first, 110000),
            createPostgresObservationStore(db).claim(first, 110000),
          ]);
          assert.equal(claims.filter(Boolean).length, 1);
          // Abandon the claim; explicit stop must not reset its logical cadence.
          assert.ok(await store.stop((await store.read(first.id))!, 115000, "admin_stopped"));
          const second = await startRun(source.id, source.generation, 120000);
          assert.deepEqual(
            await Promise.all([
              store.claim(second, 120000),
              createPostgresObservationStore(db).claim(second, 120000),
              store.claim(first, 120000),
            ]),
            [null, null, null],
          );
          assert.equal(await store.claim(second, 169999), null);
          const allowed = await Promise.all([
            store.claim(second, 170000),
            createPostgresObservationStore(db).claim(second, 170000),
          ]);
          assert.equal(allowed.filter(Boolean).length, 1);
          const abandoned = allowed.find(Boolean)!;
          assert.equal(
            await store.claim(abandoned, 230000),
            null,
            "the current run lease still applies",
          );
          const recovered = await createPostgresObservationStore(db).claim(abandoned, 260000);
          assert.ok(recovered, "an expired abandoned lease permits a later slot");
          assert.equal(
            await store.claim(abandoned, 260000),
            null,
            "stale revisions cannot reclaim",
          );
          assert.ok(await store.stop((await store.read(second.id))!, 265000, "admin_stopped"));
          const third = await startRun(source.id, source.generation, 270000);
          assert.equal(await store.claim(third, 270000), null);
          assert.ok(await store.claim(third, 320000));
          assert.ok(await store.stop((await store.read(third.id))!, 325000, "admin_stopped"));
          const changed = await wardogs.change({
            guildId,
            targetId: source.id,
            generation: source.generation,
            name: "New generation",
          });
          const nextGeneration = await startRun(source.id, changed.generation, 330000);
          assert.ok(
            await store.claim(nextGeneration, 330000),
            "old generation cadence is independent",
          );
          assert.ok(
            await store.stop((await store.read(nextGeneration.id))!, 335000, "admin_stopped"),
          );
          assert.equal(await store.claim((await store.read(nextGeneration.id))!, 400000), null);
        },
      );
      await t.test(
        "delayed and abandoned dispatch guards preserve actual cadence across concurrent restarts",
        async () => {
          const source = await wardogs.create(guildId, "Delayed read fixture", null);
          const first = await startRun(source.id, source.generation, 110000);
          const claim = (await store.claim(first, 110000))!;
          assert.deepEqual(
            (
              await Promise.all([
                store.guardRead(claim, 130000, 131000, true),
                createPostgresObservationStore(db).guardRead(claim, 130000, 131000, true),
              ])
            ).sort(),
            [false, true],
            "only one caller may reserve this read",
          );
          assert.equal(await store.guardRead(claim, 131001, 131000, false), false);
          assert.ok(await store.stop(claim, 135000, "admin_stopped"));
          // Record the actual read start after stop: no completed sample is needed.
          await store.recordReadStart(claim, 130500, 131000);
          assert.deepEqual(await store.samples(first.id, 135000), []);
          const second = await startRun(source.id, source.generation, 170000);
          assert.deepEqual(
            await Promise.all([
              store.claim(second, 170000),
              createPostgresObservationStore(db).claim(second, 170000),
            ]),
            [null, null],
          );
          assert.equal(await store.claim(second, 190499), null);
          const admitted = await Promise.all([
            store.claim(second, 190500),
            createPostgresObservationStore(db).claim(second, 190500),
          ]);
          assert.equal(admitted.filter(Boolean).length, 1);
          const live = admitted.find(Boolean)!;
          assert.equal(await store.guardRead(claim, 190500, 191500, false), false);
          // A lost worker never records its start; keep its latest-send bound.
          assert.equal(await store.guardRead(live, 200000, 201000, true), true);
          assert.ok(await store.stop(live, 200500, "admin_stopped"));
          const third = await startRun(source.id, source.generation, 250500);
          assert.equal(await store.claim(third, 260999), null);
          const pending = (await store.claim(third, 261000))!;
          assert.ok(pending);
          const recovered = (await store.claim(pending, 351000))!;
          assert.ok(recovered);
          assert.equal(await store.guardRead(pending, 351000, 352000, true), false);
          assert.equal(await store.guardRead(recovered, 351000, 352000, true), true);
          await wardogs.change({
            guildId,
            targetId: source.id,
            generation: source.generation,
            name: "Changed before roster",
          });
          assert.equal(await store.guardRead(recovered, 351500, 352000, false), false);
          await store.eraseGuild(guildId);
        },
      );
      await t.test(
        "dispatch reservation holds native run and generation locks through its write",
        async () => {
          const source = await wardogs.create(guildId, "Dispatch lock fixture", null);
          const first = await startRun(source.id, source.generation, 1000000);
          const claim = (await store.claim(first, 1000000))!;
          let entered!: () => void, resume!: () => void;
          const paused = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const released = new Promise<void>((resolve) => {
            resume = resolve;
          });
          const gated: PostgresDatabaseCapability = {
            ...gatedDatabase,
            transaction: <T>(operation: (tx: PostgresExecutor) => Promise<T>) =>
              db.transaction(async (tx) =>
                operation({
                  query: tx.query.bind(tx),
                  queryResult: tx.queryResult.bind(tx),
                  async execute(sql, values) {
                    const result = await tx.execute(sql, values);
                    entered();
                    await released;
                    return result;
                  },
                }),
              ),
          };
          const guarding = createPostgresObservationStore(gated).guardRead(
            claim,
            1000200,
            1001000,
            true,
          );
          await paused;
          const stopping = store.stop(claim, 1000300, "admin_stopped");
          const changing = wardogs.change({
            guildId,
            targetId: source.id,
            generation: source.generation,
            name: "Changed during guard",
          });
          try {
            let blocked = 0;
            for (let attempt = 0; attempt < 100; attempt++) {
              blocked = Number(
                (
                  await db.query<{ count: string }>(
                    "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'UPDATE attendance_observation_runs SET%' OR query LIKE 'UPDATE wardogs_targets SET%')",
                  )
                )[0].count,
              );
              if (blocked === 2) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(
              blocked,
              2,
              "stop and generation change serialize with dispatch admission",
            );
          } finally {
            resume();
          }
          assert.equal(await guarding, true);
          assert.ok(await stopping);
          await changing;
          assert.equal(await store.guardRead(claim, 1000500, 1001000, false), false);
          await store.recordReadStart(claim, 1000500, 1001000);
          assert.deepEqual(await store.samples(first.id, 1001000), []);
          await store.eraseGuild(guildId);
        },
      );
      await t.test(
        "personal erasure keeps a non-personal cadence and slot tombstone with bounded retention",
        async () => {
          const source = await wardogs.create(guildId, "Erasure fixture", null);
          const first = await startRun(source.id, source.generation, 100000);
          const claim = (await store.claim(first, 100000))!;
          const observed = {
            ...sample,
            id: `${first.id}:${claim.slot}`,
            runId: first.id,
            targetId: source.id,
            generation: source.generation,
            slot: claim.slot!,
          };
          assert.equal(
            await store.finish(
              { ...claim, totals: { ...claim.totals, samples: 1 } },
              observed,
              105000,
            ),
            true,
          );
          assert.ok(await store.stop((await store.read(first.id))!, 105000, "personal_erasure"));
          await store.eraseMember(
            guildId,
            "synthetic-admin",
            await observationMemberKey(guildId, "synthetic-admin"),
          );
          assert.deepEqual(await store.samples(first.id, 110000), []);
          assert.equal((await store.read(first.id))?.actorId, null);
          assert.deepEqual(
            await db.query<{ data: string }>(
              "SELECT data FROM attendance_observation_samples WHERE run_id=$1",
              [first.id],
            ),
            [{ data: "{}" }],
          );
          assert.equal(
            await store.finish(claim, observed, 110000),
            false,
            "an old result cannot recreate erased data",
          );
          const second = await startRun(source.id, source.generation, 110000);
          assert.deepEqual(
            await Promise.all([
              store.claim(second, 110000),
              createPostgresObservationStore(db).claim(second, 110000),
            ]),
            [null, null],
          );
          assert.equal(await store.claim(second, 159999), null);
          assert.ok(await store.claim(second, 160000));
          assert.equal(
            (await store.report(first.id))?.totals.samples,
            1,
            "aggregate evidence is not fabricated",
          );
          const retained = JSON.stringify({
            run: await store.read(first.id),
            report: await store.report(first.id),
          });
          for (const value of [
            "synthetic-admin",
            "76561198000000001",
            await observationMemberKey(guildId, "synthetic-admin"),
          ])
            assert.ok(!retained.includes(value));
          await store.eraseMember(
            guildId,
            "synthetic-admin",
            await observationMemberKey(guildId, "synthetic-admin"),
          );
          await store.cleanup(1e9);
          assert.deepEqual(
            await db.query("SELECT id FROM attendance_observation_samples WHERE guild_id=$1", [
              guildId,
            ]),
            [],
          );
          assert.equal(await store.read(first.id), null);
          assert.equal((await store.report(first.id))?.totals.samples, 1);
          await store.eraseGuild(guildId);
          assert.deepEqual(await store.reports(guildId), []);
        },
      );
      const effectsAfter = await Promise.all(
        effectTables.map(
          async (table) =>
            (await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`))[0].count,
        ),
      );
      assert.deepEqual(
        effectsAfter,
        effectsBefore,
        "native persistence never writes progression or access tables",
      );
    } finally {
      await db.close();
    }
  },
);
