import type {
  PostgresDatabaseCapability,
  PostgresExecutor,
} from "../runtime/postgres/postgres-capability";
import {
  BanAppealError,
  banAppealSettingsSchema,
  defaultBanAppealConfig,
  type BanAppeal,
  type BanAppealConfig,
  type BanAppealOperation,
  type BanAppealStore,
} from "./types";

type ConfigRow = { settings_json: unknown; revision: number };
type AppealRow = {
  id: string;
  guild_id: string;
  user_id: string;
  display_name: string;
  appeal_text: string;
  ban_reason: string | null;
  status: BanAppeal["status"];
  revision: number;
  created_at_ms: string | number;
  resolved_at_ms: string | number | null;
  reviewer_user_id: string | null;
  decision_reason: string | null;
  operation_id: string | null;
};
type OperationRow = {
  id: string;
  appeal_id: string;
  actor_user_id: string;
  reason: string;
  outcome: BanAppealOperation["outcome"];
  created_at_ms: number | string;
  completed_at_ms: number | string | null;
};
const parseConfig = (guildId: string, row: ConfigRow): BanAppealConfig => ({
  ...banAppealSettingsSchema.parse(row.settings_json),
  guildId,
  revision: Number(row.revision),
});
const parseAppeal = (row: AppealRow): BanAppeal => ({
  id: row.id,
  guildId: row.guild_id,
  userId: row.user_id,
  displayName: row.display_name,
  text: row.appeal_text,
  banReason: row.ban_reason,
  status: row.status,
  revision: Number(row.revision),
  createdAtMs: Number(row.created_at_ms),
  resolvedAtMs: row.resolved_at_ms === null ? null : Number(row.resolved_at_ms),
  reviewerUserId: row.reviewer_user_id,
  decisionReason: row.decision_reason,
  operationId: row.operation_id,
});
const parseOperation = (row: OperationRow): BanAppealOperation => ({
  id: row.id,
  appealId: row.appeal_id,
  actorUserId: row.actor_user_id,
  reason: row.reason,
  outcome: row.outcome,
  createdAtMs: Number(row.created_at_ms),
  completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
});

export function createPostgresBanAppealStore(database: PostgresDatabaseCapability): BanAppealStore {
  async function read(guildId: string, id: string, tx: PostgresExecutor = database, lock = false) {
    const [row] = await tx.query<AppealRow>(
      `SELECT * FROM discord_ban_appeals WHERE guild_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [guildId, id],
    );
    return row ? parseAppeal(row) : null;
  }
  async function getConfig(guildId: string) {
    const [row] = await database.query<ConfigRow>(
      "SELECT settings_json,revision FROM discord_ban_appeal_configs WHERE guild_id = $1",
      [guildId],
    );
    return row ? parseConfig(guildId, row) : defaultBanAppealConfig(guildId);
  }
  return {
    read,
    getConfig,
    async saveConfig(guildId, input, expectedRevision) {
      const settings = banAppealSettingsSchema.parse(input);
      return database.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO discord_ban_appeal_configs(guild_id,settings_json) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING",
          [guildId, JSON.stringify(defaultBanAppealConfig(guildId))],
        );
        const [row] = await tx.query<ConfigRow>(
          "UPDATE discord_ban_appeal_configs SET settings_json = $2::jsonb, revision = revision + 1 WHERE guild_id = $1 AND revision = $3 RETURNING settings_json,revision",
          [guildId, JSON.stringify(settings), expectedRevision],
        );
        if (!row)
          throw new BanAppealError("Ban appeal settings changed. Reload before saving.", 409);
        return parseConfig(guildId, row);
      });
    },
    async latestForUser(guildId, userId) {
      const [row] = await database.query<AppealRow>(
        "SELECT * FROM discord_ban_appeals WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at_ms DESC,id DESC LIMIT 1",
        [guildId, userId],
      );
      return row ? parseAppeal(row) : null;
    },
    async nextSubmissionAt(guildId, userId) {
      const [row] = await database.query<{ next_submission_at_ms: string }>(
        "SELECT next_submission_at_ms FROM discord_ban_appeal_cooldowns WHERE guild_id = $1 AND user_id = $2",
        [guildId, userId],
      );
      return Number(row?.next_submission_at_ms ?? 0);
    },
    async list(guildId) {
      return (
        await database.query<AppealRow>(
          "SELECT * FROM discord_ban_appeals WHERE guild_id = $1 ORDER BY CASE WHEN status IN ('pending','unban_pending') THEN 0 ELSE 1 END,created_at_ms DESC LIMIT 50",
          [guildId],
        )
      ).map(parseAppeal);
    },
    async operations(guildId, id) {
      return (
        await database.query<OperationRow>(
          "SELECT * FROM discord_ban_appeal_operations WHERE guild_id = $1 AND appeal_id = $2 ORDER BY created_at_ms DESC LIMIT 20",
          [guildId, id],
        )
      ).map(parseOperation);
    },
    async submit(input) {
      return database.transaction(async (tx) => {
        const [row] = await tx.query<ConfigRow>(
          "SELECT settings_json,revision FROM discord_ban_appeal_configs WHERE guild_id = $1 FOR SHARE",
          [input.guildId],
        );
        if (!row || !parseConfig(input.guildId, row).enabled)
          throw new BanAppealError("Ban appeals are not enabled for this server.", 404);
        const existing = await read(input.guildId, input.id, tx);
        if (existing) {
          if (existing.userId !== input.userId)
            throw new BanAppealError("This submission identity is already in use.", 409);
          return existing;
        }
        await tx.execute(
          "INSERT INTO discord_ban_appeal_cooldowns(guild_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [input.guildId, input.userId],
        );
        const [cooldown] = await tx.query<{ next_submission_at_ms: string }>(
          "SELECT next_submission_at_ms FROM discord_ban_appeal_cooldowns WHERE guild_id = $1 AND user_id = $2 FOR UPDATE",
          [input.guildId, input.userId],
        );
        const repeated = await read(input.guildId, input.id, tx);
        if (repeated) {
          if (repeated.userId !== input.userId)
            throw new BanAppealError("This submission identity is already in use.", 409);
          return repeated;
        }
        const [open] = await tx.query<AppealRow>(
          "SELECT * FROM discord_ban_appeals WHERE guild_id = $1 AND user_id = $2 AND status IN ('pending','unban_pending') LIMIT 1",
          [input.guildId, input.userId],
        );
        if (open) return parseAppeal(open);
        if (Number(cooldown!.next_submission_at_ms) > input.nowMs)
          throw new BanAppealError(
            "Please wait for the appeal cooldown before submitting again.",
            429,
          );
        const [created] = await tx.query<AppealRow>(
          `INSERT INTO discord_ban_appeals(guild_id,id,user_id,display_name,appeal_text,ban_reason,status,created_at_ms)
          VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING *`,
          [
            input.guildId,
            input.id,
            input.userId,
            input.displayName,
            input.text,
            input.banReason,
            input.nowMs,
          ],
        );
        await tx.execute(
          "UPDATE discord_ban_appeal_cooldowns SET next_submission_at_ms = $3 WHERE guild_id = $1 AND user_id = $2",
          [
            input.guildId,
            input.userId,
            input.nowMs + parseConfig(input.guildId, row).cooldownHours * 3_600_000,
          ],
        );
        return parseAppeal(created!);
      });
    },
    async claimReview(input) {
      return database.transaction(async (tx) => {
        const appeal = await read(input.guildId, input.id, tx, true);
        if (!appeal) throw new BanAppealError("Ban appeal not found.", 404);
        if (appeal.status === "unbanned" || appeal.status === "rejected") {
          if (
            (input.action === "unban" && appeal.status === "unbanned") ||
            (input.action === "reject" && appeal.status === "rejected")
          )
            return { appeal, operation: null, execute: false };
          throw new BanAppealError("This appeal has already been resolved.", 409);
        }
        const [operationRow] = appeal.operationId
          ? await tx.query<OperationRow>(
              "SELECT * FROM discord_ban_appeal_operations WHERE guild_id = $1 AND id = $2",
              [input.guildId, appeal.operationId],
            )
          : [];
        const operation = operationRow ? parseOperation(operationRow) : null;
        if (appeal.status === "unban_pending" && input.action === "unban")
          return { appeal, operation, execute: false };
        if (appeal.revision !== input.expectedRevision)
          throw new BanAppealError("This appeal changed. Refresh it before reviewing.", 409);
        if (
          appeal.status === "unban_pending" &&
          operation?.outcome === "started" &&
          operation.createdAtMs > input.nowMs - 60_000
        )
          throw new BanAppealError(
            "An unban request is still in progress. Refresh its status shortly.",
            409,
          );
        if (input.action === "reject") {
          const [updated] = await tx.query<AppealRow>(
            "UPDATE discord_ban_appeals SET status = 'rejected', reviewer_user_id = $3, decision_reason = $4, resolved_at_ms = $5, revision = revision + 1 WHERE guild_id = $1 AND id = $2 RETURNING *",
            [input.guildId, input.id, input.actorUserId, input.reason, input.nowMs],
          );
          return { appeal: parseAppeal(updated!), operation, execute: false };
        }
        const [started] = await tx.query<OperationRow>(
          "INSERT INTO discord_ban_appeal_operations(guild_id,appeal_id,id,actor_user_id,reason,outcome,created_at_ms) VALUES ($1,$2,$3,$4,$5,'started',$6) RETURNING *",
          [
            input.guildId,
            input.id,
            input.operationId,
            input.actorUserId,
            input.reason,
            input.nowMs,
          ],
        );
        const [updated] = await tx.query<AppealRow>(
          "UPDATE discord_ban_appeals SET status = 'unban_pending',operation_id = $3,reviewer_user_id = $4,decision_reason = $5,revision = revision + 1 WHERE guild_id = $1 AND id = $2 RETURNING *",
          [input.guildId, input.id, input.operationId, input.actorUserId, input.reason],
        );
        return {
          appeal: parseAppeal(updated!),
          operation: parseOperation(started!),
          execute: true,
        };
      });
    },
    async finishUnban(guildId, appealId, operationId, outcome, nowMs) {
      return database.transaction(async (tx) => {
        const appeal = await read(guildId, appealId, tx, true);
        if (!appeal) throw new BanAppealError("Ban appeal not found.", 404);
        if (appeal.operationId !== operationId || appeal.status !== "unban_pending") return appeal;
        await tx.execute(
          "UPDATE discord_ban_appeal_operations SET outcome = $3, completed_at_ms = $4 WHERE guild_id = $1 AND id = $2 AND outcome <> 'succeeded'",
          [guildId, operationId, outcome, nowMs],
        );
        const status =
          outcome === "succeeded" ? "unbanned" : outcome === "failed" ? "pending" : "unban_pending";
        const [updated] = await tx.query<AppealRow>(
          "UPDATE discord_ban_appeals SET status = $3,resolved_at_ms = $4,revision = revision + 1 WHERE guild_id = $1 AND id = $2 RETURNING *",
          [guildId, appealId, status, status === "unbanned" ? nowMs : null],
        );
        return parseAppeal(updated!);
      });
    },
  };
}
