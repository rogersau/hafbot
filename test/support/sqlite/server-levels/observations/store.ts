import {
  OBSERVATION_POLICY,
  ObservationError,
  redactedReport,
  type ObservationRun,
  type Observation,
} from "../../../../../src/server-levels/observations/model";
export interface ObservationSql {
  rows(
    sql: string,
    values: (string | number | null)[],
  ): Promise<{ data: string; duplicates?: number; late?: number }[]>;
  batch(
    statements: { sql: string; values: (string | number | null)[] }[],
    fence?: { runId: string; guildId: string; targetId: string; generation: number },
  ): Promise<number[]>;
}
const CLAIM_LEASE_MS = 90_000;
export function createObservationStore(db: ObservationSql) {
  const read = async (id: string) => {
    const r = await db.rows("SELECT data FROM attendance_observation_runs WHERE id=?", [id]);
    return r[0] ? (JSON.parse(r[0].data) as ObservationRun) : null;
  };
  const samples = async (id: string, now: number) =>
    (
      await db.rows(
        "SELECT data FROM attendance_observation_samples WHERE run_id=? AND delete_at_ms>? ORDER BY slot",
        [id, now],
      )
    )
      .filter((r) => r.data !== "{}")
      .map((r) => JSON.parse(r.data) as Observation);
  return {
    read,
    samples,
    async reports(guildId: string) {
      return (
        await db.rows("SELECT data FROM attendance_observation_reports WHERE guild_id=? LIMIT 50", [
          guildId,
        ])
      ).map((r) => JSON.parse(r.data) as ReturnType<typeof redactedReport>);
    },
    async list(guildId: string) {
      return (
        await db.rows(
          "SELECT data FROM attendance_observation_runs WHERE guild_id=? ORDER BY CASE WHEN active_target IS NOT NULL THEN 0 ELSE 1 END, expires_at_ms DESC LIMIT 50",
          [guildId],
        )
      ).map((r) => JSON.parse(r.data) as ObservationRun);
    },
    async start(run: ObservationRun) {
      const r = await db.rows(
        "INSERT INTO attendance_observation_runs(id,guild_id,target_id,generation,active_target,revision,lease,next_at_ms,expires_at_ms,delete_at_ms,data) VALUES(?,?,?,?,?,?,NULL,?,?,?,?) ON CONFLICT DO NOTHING RETURNING data",
        [
          run.id,
          run.guildId,
          run.targetId,
          run.generation,
          run.targetId,
          run.revision,
          run.nextAtMs,
          run.expiresAtMs,
          run.deleteAtMs,
          JSON.stringify(run),
        ],
      );
      if (!r.length)
        throw new ObservationError(
          "This target already has an observation run. Stop it before starting another.",
        );
      return run;
    },
    async due(now: number) {
      return (
        await db.rows(
          "SELECT data FROM attendance_observation_runs WHERE active_target IS NOT NULL AND (next_at_ms<=? OR expires_at_ms<=?) ORDER BY next_at_ms LIMIT 5",
          [now, now],
        )
      ).map((r) => JSON.parse(r.data) as ObservationRun);
    },
    async claim(run: ObservationRun, now: number) {
      const token = crypto.randomUUID();
      const slot = Math.floor(now / OBSERVATION_POLICY.intervalMs);
      const next = {
        ...run,
        revision: run.revision + 1,
        lease: token,
        slot,
        nextAtMs: now + CLAIM_LEASE_MS,
        totals: {
          ...run.totals,
          attempts: run.totals.attempts + 1,
          missingSlots:
            run.totals.missingSlots + (run.slot === null ? 0 : Math.max(0, slot - run.slot - 1)),
        },
      };
      await db.batch([
        {
          // Retain cadence on the durable slot claim, independently of run lifetime
          // and private payload. The run CAS serializes admission with stop/restart.
          sql: "UPDATE attendance_observation_runs SET revision=?,lease=?,next_at_ms=?,data=? WHERE id=? AND revision=? AND active_target IS NOT NULL AND expires_at_ms>? AND next_at_ms<=? AND NOT EXISTS(SELECT 1 FROM attendance_observation_samples s WHERE s.target_id=attendance_observation_runs.target_id AND s.generation=attendance_observation_runs.generation AND s.next_allowed_at_ms>?)",
          values: [
            next.revision,
            token,
            next.nextAtMs,
            JSON.stringify(next),
            run.id,
            run.revision,
            now,
            now,
            now,
          ],
        },
        {
          sql: "INSERT INTO attendance_observation_samples(id,run_id,guild_id,target_id,generation,slot,claim_token,next_allowed_at_ms,delete_at_ms,data) SELECT ?,?,?,?,?,?,?,?,?,'{}' WHERE EXISTS(SELECT 1 FROM attendance_observation_runs WHERE id=? AND lease=? AND revision=?) ON CONFLICT DO NOTHING",
          values: [
            `${run.id}:${slot}`,
            run.id,
            run.guildId,
            run.targetId,
            run.generation,
            slot,
            token,
            now + OBSERVATION_POLICY.intervalMs,
            now + OBSERVATION_POLICY.retentionMs,
            run.id,
            token,
            next.revision,
          ],
        },
      ]);
      const check = await db.rows(
        "SELECT data FROM attendance_observation_samples WHERE id=? AND claim_token=?",
        [`${run.id}:${slot}`, token],
      );
      if (check.length) return next;
      await db.rows(
        "UPDATE attendance_observation_runs SET duplicates=duplicates+1 WHERE id=? RETURNING data",
        [run.id],
      );
      return null;
    },
    async guardRead(run: ObservationRun, now: number, dispatchByMs: number, firstRead: boolean) {
      if (now > dispatchByMs || dispatchByMs >= run.nextAtMs || dispatchByMs >= run.expiresAtMs)
        return false;
      // Reserve through the client's latest permitted dispatch, rather than an
      // earlier membership check. A lost worker leaves this safe bound intact.
      const changes = await db.batch(
        [
          {
            sql: `UPDATE attendance_observation_samples SET next_allowed_at_ms=${firstRead ? "?" : "next_allowed_at_ms"} WHERE id=? AND claim_token=? ${firstRead ? "AND next_allowed_at_ms=?" : ""} AND EXISTS(SELECT 1 FROM attendance_observation_runs r JOIN wardogs_targets t ON t.id=r.target_id AND t.guild_id=r.guild_id AND t.generation=r.generation WHERE r.id=? AND r.revision=? AND r.lease=? AND r.active_target IS NOT NULL AND r.expires_at_ms>? AND r.next_at_ms>?)`,
            values: [
              ...(firstRead ? [dispatchByMs + OBSERVATION_POLICY.intervalMs] : []),
              `${run.id}:${run.slot}`,
              run.lease,
              ...(firstRead ? [run.nextAtMs - CLAIM_LEASE_MS + OBSERVATION_POLICY.intervalMs] : []),
              run.id,
              run.revision,
              run.lease,
              now,
              now,
            ],
          },
        ],
        { runId: run.id, guildId: run.guildId, targetId: run.targetId, generation: run.generation },
      );
      return changes[0] === 1;
    },
    async recordReadStart(run: ObservationRun, startedAtMs: number, dispatchByMs: number) {
      if (startedAtMs > dispatchByMs)
        throw new ObservationError("Read start exceeded its durable dispatch reservation.");
      // Cadence belongs to the target generation even after stop/erasure/lease
      // loss. Only this read's token and reserved bound may settle its tombstone.
      await db.rows(
        "UPDATE attendance_observation_samples SET next_allowed_at_ms=? WHERE id=? AND claim_token=? AND next_allowed_at_ms=? RETURNING data",
        [
          startedAtMs + OBSERVATION_POLICY.intervalMs,
          `${run.id}:${run.slot}`,
          run.lease,
          dispatchByMs + OBSERVATION_POLICY.intervalMs,
        ],
      );
    },
    async finish(run: ObservationRun, sample: Observation, now: number, retryAt = 0) {
      const next = {
        ...run,
        revision: run.revision + 1,
        lease: null,
        nextAtMs: Math.max(
          (sample.slot + 1) * 60_000,
          sample.status.startedAtMs + 60_000,
          now,
          retryAt,
        ),
      };
      const guard =
        "id=? AND revision=? AND lease=? AND active_target IS NOT NULL AND expires_at_ms>? AND EXISTS(SELECT 1 FROM wardogs_targets t WHERE t.id=attendance_observation_runs.target_id AND t.guild_id=attendance_observation_runs.guild_id AND t.generation=attendance_observation_runs.generation)";
      await db.batch(
        [
          {
            sql: `UPDATE attendance_observation_samples SET data=? WHERE id=? AND claim_token=? AND EXISTS(SELECT 1 FROM attendance_observation_runs WHERE ${guard})`,
            values: [
              JSON.stringify(sample),
              sample.id,
              run.lease,
              run.id,
              run.revision,
              run.lease,
              now,
            ],
          },
          {
            sql: `UPDATE attendance_observation_runs SET revision=?,lease=NULL,next_at_ms=?,data=? WHERE ${guard}`,
            values: [
              next.revision,
              next.nextAtMs,
              JSON.stringify(next),
              run.id,
              run.revision,
              run.lease,
              now,
            ],
          },
        ],
        { runId: run.id, guildId: run.guildId, targetId: run.targetId, generation: run.generation },
      );
      const saved = await read(run.id);
      const ok =
        saved?.revision === next.revision && saved.lease === null && saved.state === "running";
      if (!ok)
        await db.rows(
          "UPDATE attendance_observation_runs SET late=late+1 WHERE id=? RETURNING data",
          [run.id],
        );
      return ok;
    },
    async stop(run: ObservationRun, now: number, reason: string) {
      const next = {
        ...run,
        state: "stopped" as const,
        stoppedAtMs: now,
        stopReason: reason,
        revision: run.revision + 1,
        lease: null,
      };
      const r = await db.rows(
        "UPDATE attendance_observation_runs SET active_target=NULL,lease=NULL,revision=?,data=? WHERE id=? AND revision=? RETURNING data",
        [next.revision, JSON.stringify(next), run.id, run.revision],
      );
      return r.length ? next : null;
    },
    async late(id: string) {
      await db.rows(
        "UPDATE attendance_observation_runs SET late=late+1 WHERE id=? RETURNING data",
        [id],
      );
    },
    async report(id: string) {
      const rows = await db.rows(
        "SELECT data,duplicates,late FROM attendance_observation_runs WHERE id=?",
        [id],
      );
      if (rows[0])
        return redactedReport(
          JSON.parse(rows[0].data),
          Number(rows[0].duplicates ?? 0),
          Number(rows[0].late ?? 0),
        );
      const retained = await db.rows("SELECT data FROM attendance_observation_reports WHERE id=?", [
        id,
      ]);
      return retained[0]
        ? (JSON.parse(retained[0].data) as ReturnType<typeof redactedReport>)
        : null;
    },
    async cleanup(now: number) {
      const runs = await db.rows(
        "SELECT data,duplicates,late FROM attendance_observation_runs WHERE delete_at_ms<=? ORDER BY delete_at_ms LIMIT 20",
        [now],
      );
      for (const row of runs) {
        const run = JSON.parse(row.data) as ObservationRun;
        const report = redactedReport(
          {
            ...run,
            state: "stopped",
            stoppedAtMs: run.stoppedAtMs ?? run.expiresAtMs,
            stopReason: run.stopReason ?? "expired",
          },
          Number(row.duplicates ?? 0),
          Number(row.late ?? 0),
        );
        await db.batch([
          {
            sql: "INSERT INTO attendance_observation_reports(id,guild_id,data) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM attendance_observation_runs WHERE id=? AND delete_at_ms<=?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            values: [run.id, run.guildId, JSON.stringify(report), run.id, now],
          },
          {
            sql: "DELETE FROM attendance_observation_runs WHERE id=? AND delete_at_ms<=?",
            values: [run.id, now],
          },
        ]);
      }
      await db.rows(
        "DELETE FROM attendance_observation_samples WHERE id IN (SELECT id FROM attendance_observation_samples WHERE delete_at_ms<=? ORDER BY delete_at_ms LIMIT 500) RETURNING data",
        [now],
      );
    },
    async eraseMember(guildId: string, userId: string, memberKey: string) {
      // These predicates are bound values, and the erasure key has only hex digits.
      // Scrub the whole private payload without inventing a revised attendance set.
      // Keep the non-personal slot/cadence claim until its existing retention expiry.
      // Aggregate decision evidence contains no subjects or consenting actor.
      const actor = `"actorId":${JSON.stringify(userId)}`;
      await db.batch([
        {
          sql: "UPDATE attendance_observation_samples SET data='{}' WHERE guild_id=? AND data LIKE ?",
          values: [guildId, `%"memberKey":"${memberKey}"%`],
        },
        {
          sql: "UPDATE attendance_observation_runs SET data=REPLACE(data,?,?) WHERE guild_id=?",
          values: [actor, '"actorId":null', guildId],
        },
      ]);
    },
    async eraseGuild(guildId: string) {
      await db.batch([
        { sql: "DELETE FROM attendance_observation_runs WHERE guild_id=?", values: [guildId] },
        { sql: "DELETE FROM attendance_observation_samples WHERE guild_id=?", values: [guildId] },
        { sql: "DELETE FROM attendance_observation_reports WHERE guild_id=?", values: [guildId] },
      ]);
    },
  };
}
export type ObservationStore = ReturnType<typeof createObservationStore>;
