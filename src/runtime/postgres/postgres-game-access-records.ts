interface GameAccessRow {
  data: string;
  revision?: number;
  generation?: number;
  next_at_ms?: number;
}
export interface GameAccessSql {
  rows(sql: string, values: (string | number | null)[]): Promise<GameAccessRow[]>;
}
function assignment(row: GameAccessRow): Assignment {
  return {
    ...JSON.parse(row.data),
    revision: Number(row.revision),
    generation: Number(row.generation),
    nextAtMs: Number(row.next_at_ms),
  };
}
import {
  GameAccessError,
  type Fulfillment,
  type Selection,
  type Assignment,
} from "../../commerce/game-access/model";
export function createGameAccessStore(db: GameAccessSql) {
  const decode = <T>(rows: { data: string }[]) =>
    rows[0] ? (JSON.parse(rows[0].data) as T) : null;
  return {
    async canChangeOrigin(guildId: string, targetId: string) {
      return !(
        await db.rows(
          "SELECT data FROM commerce_game_fulfillments WHERE guild_id=$1 AND target_id=$2 LIMIT 1",
          [guildId, targetId],
        )
      ).length;
    },
    async config(offeringId: string) {
      return decode<Fulfillment>(
        await db.rows("SELECT data FROM commerce_game_fulfillments WHERE offering_id=$1", [
          offeringId,
        ]),
      );
    },
    async configs(guildId?: string) {
      return (
        await db.rows(
          guildId
            ? "SELECT data FROM commerce_game_fulfillments WHERE guild_id=$1"
            : "SELECT data FROM commerce_game_fulfillments",
          guildId ? [guildId] : [],
        )
      ).map((r) => JSON.parse(r.data) as Fulfillment);
    },
    async configure(config: Fulfillment) {
      // Any durable checkout locks the destination, including a payment completing late.
      const rows = await db.rows(
        `INSERT INTO commerce_game_fulfillments(offering_id,guild_id,target_id,physical_target,origin,data) SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS(SELECT 1 FROM commerce_checkout_attempts WHERE offering_id=$7 AND NOT EXISTS(SELECT 1 FROM commerce_game_fulfillments WHERE offering_id=$8))
      ON CONFLICT(offering_id) DO UPDATE SET data=excluded.data,target_id=excluded.target_id,physical_target=excluded.physical_target,origin=excluded.origin
      WHERE commerce_game_fulfillments.guild_id=excluded.guild_id AND
       ((commerce_game_fulfillments.target_id=excluded.target_id AND commerce_game_fulfillments.physical_target=excluded.physical_target AND commerce_game_fulfillments.origin=excluded.origin) OR NOT EXISTS(SELECT 1 FROM commerce_checkout_attempts WHERE offering_id=$9)) RETURNING data`,
        [
          config.offeringId,
          config.guildId,
          config.targetId,
          config.physicalTarget,
          config.origin,
          JSON.stringify(config),
          config.offeringId,
          config.offeringId,
          config.offeringId,
        ],
      );
      if (!rows.length) throw new GameAccessError("Purchased fulfillment targets are immutable.");
    },
    async select(selection: Selection) {
      await db.rows(
        "INSERT INTO commerce_game_selections(checkout_id,offering_id,buyer_id,assignment_id,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING data",
        [
          selection.checkoutId,
          selection.offeringId,
          selection.buyerId,
          selection.assignmentId,
          JSON.stringify(selection),
        ],
      );
      const saved = decode<Selection>(
        await db.rows("SELECT data FROM commerce_game_selections WHERE checkout_id=$1", [
          selection.checkoutId,
        ]),
      );
      if (
        !saved ||
        saved.guildId !== selection.guildId ||
        saved.buyerId !== selection.buyerId ||
        saved.assignmentId !== selection.assignmentId ||
        saved.userId !== selection.userId ||
        saved.subject !== selection.subject ||
        saved.offeringId !== selection.offeringId
      )
        throw new GameAccessError("Checkout identity cannot be substituted.");
    },
    async selection(checkoutId: string) {
      return decode<Selection>(
        await db.rows("SELECT data FROM commerce_game_selections WHERE checkout_id=$1", [
          checkoutId,
        ]),
      );
    },
    async selections(id: string) {
      return (
        await db.rows("SELECT data FROM commerce_game_selections WHERE assignment_id=$1", [id])
      ).map((r) => JSON.parse(r.data) as Selection);
    },
    async read(id: string) {
      const rows = await db.rows(
        "SELECT data,revision,generation,next_at_ms FROM commerce_game_assignments WHERE id=$1",
        [id],
      );
      return rows[0] ? assignment(rows[0]) : null;
    },
    async list(guildId?: string) {
      return (
        await db.rows(
          guildId
            ? "SELECT data,revision,generation,next_at_ms FROM commerce_game_assignments WHERE guild_id=$1"
            : "SELECT data,revision,generation,next_at_ms FROM commerce_game_assignments",
          guildId ? [guildId] : [],
        )
      ).map(assignment);
    },
    async due(now: number) {
      return (
        await db.rows(
          "SELECT data,revision,generation,next_at_ms FROM commerce_game_assignments WHERE next_at_ms<=$1 ORDER BY next_at_ms LIMIT 50",
          [now],
        )
      ).map(assignment);
    },
    async reserve(candidate: Assignment, available: number) {
      const existingRows = await db.rows(
        "SELECT data,revision,generation,next_at_ms FROM commerce_game_assignments WHERE physical_target=$1 AND subject=$2",
        [candidate.physicalTarget, candidate.subject],
      );
      const existing = existingRows[0] ? assignment(existingRows[0]) : null;
      if (existing) {
        if (existing.guildId !== candidate.guildId || existing.userId !== candidate.userId)
          throw new GameAccessError(
            "This server identity has a conflicting owner. Ask staff to review it.",
          );
        if (existing.slot !== null) return existing;
        for (let slot = 0; slot < available; slot++) {
          const next = { ...existing, slot, revision: existing.revision + 1 };
          try {
            const rows = await db.rows(
              "UPDATE commerce_game_assignments SET slot=$1,revision=$2,data=$3 WHERE id=$4 AND revision=$5 RETURNING data",
              [slot, next.revision, JSON.stringify(next), existing.id, existing.revision],
            );
            if (rows.length) return next;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !/unique constraint|duplicate key/i.test(error.message)
            )
              throw error;
          }
        }
      } else
        for (let slot = 0; slot < available; slot++) {
          const next = { ...candidate, slot };
          const rows = await db.rows(
            "INSERT INTO commerce_game_assignments(id,guild_id,user_id,physical_target,subject,slot,generation,revision,next_at_ms,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING data",
            [
              next.id,
              next.guildId,
              next.userId,
              next.physicalTarget,
              next.subject,
              slot,
              next.generation,
              next.revision,
              next.nextAtMs,
              JSON.stringify(next),
            ],
          );
          if (rows.length) return next;
          const otherRows = await db.rows(
            "SELECT data,revision,generation,next_at_ms FROM commerce_game_assignments WHERE physical_target=$1 AND subject=$2",
            [next.physicalTarget, next.subject],
          );
          const other = otherRows[0] ? assignment(otherRows[0]) : null;
          if (
            other &&
            other.guildId === next.guildId &&
            other.userId === next.userId &&
            other.slot !== null
          )
            return other;
        }
      throw new GameAccessError("Reserved-access capacity is exhausted or ownership conflicts.");
    },
    async deferPublication(value: Assignment, nextAtMs: number) {
      const rows = await db.rows(
        `UPDATE commerce_game_assignments SET next_at_ms=$1
        WHERE id=$2 AND revision=$3 AND next_at_ms=$4 RETURNING data,revision,generation,next_at_ms`,
        [nextAtMs, value.id, value.revision, value.nextAtMs],
      );
      return rows[0] ? assignment(rows[0]) : null;
    },
    async save(value: Assignment, expected: number) {
      const next = { ...value, revision: expected + 1 };
      return decode<Assignment>(
        await db.rows(
          "UPDATE commerce_game_assignments SET revision=$1,generation=$2,next_at_ms=$3,slot=$4,data=$5 WHERE id=$6 AND revision=$7 RETURNING data",
          [
            next.revision,
            next.generation,
            next.nextAtMs,
            next.slot,
            JSON.stringify(next),
            next.id,
            expected,
          ],
        ),
      );
    },
  };
}
export type GameAccessStore = ReturnType<typeof createGameAccessStore>;
