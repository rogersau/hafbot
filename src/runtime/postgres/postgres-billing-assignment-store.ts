import type { BillingAssignmentStore, BillingGuildAssignment } from "../billing/assignments";
import type { BillingLedgerOperation } from "../billing/types";
import type { PostgresDatabaseCapability, PostgresExecutor } from "./postgres-capability";
import { PostgresBillingSyncStore } from "./postgres-billing-sync-store";

type AssignmentRow = {
  guild_id: string;
  owner_id: string;
  stripe_subscription_id: string;
  assigned_at_ms: number;
};

export class PostgresBillingAssignmentStore implements BillingAssignmentStore {
  private readonly billing: PostgresBillingSyncStore;
  constructor(private readonly database: PostgresDatabaseCapability) {
    this.billing = new PostgresBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async listAssignments(ownerId: string): Promise<BillingGuildAssignment[]> {
    const rows = await this.database.query<AssignmentRow>(
      `SELECT guild_id, owner_id, stripe_subscription_id, assigned_at_ms
       FROM billing_guild_assignments WHERE owner_id = $1 ORDER BY assigned_at_ms`,
      [ownerId],
    );
    return rows.map((row) => ({
      guildId: row.guild_id,
      ownerId: row.owner_id,
      subscriptionId: row.stripe_subscription_id,
      assignedAtMs: row.assigned_at_ms,
    }));
  }
  async readEffectivePlans(
    guildIds: string[],
  ): Promise<Map<string, "free" | "premium" | "premium_plus">> {
    if (guildIds.length === 0) return new Map();
    const placeholders = guildIds.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await this.database.query<{
      guild_id: string;
      plan: "free" | "premium" | "premium_plus";
    }>(
      `SELECT guild_id, plan FROM guild_entitlements WHERE guild_id IN (${placeholders})`,
      guildIds,
    );
    return new Map(rows.map((row) => [row.guild_id, row.plan]));
  }
  assign(input: Parameters<BillingAssignmentStore["assign"]>[0]): Promise<boolean> {
    return this.mutate(input.ownerId, [input.guildId], async (transaction) => {
      const changed = await transaction.execute(
        `INSERT INTO billing_guild_assignments (guild_id, owner_id, stripe_subscription_id, assigned_at_ms)
         SELECT $1, $2, $3, $4 WHERE
           EXISTS(SELECT 1 FROM billing_guild_assignments WHERE guild_id = $1 AND owner_id = $2)
           OR (SELECT COUNT(*) FROM billing_guild_assignments WHERE owner_id = $2) < $5
         ON CONFLICT (guild_id) DO UPDATE SET
           stripe_subscription_id = excluded.stripe_subscription_id, assigned_at_ms = excluded.assigned_at_ms
         WHERE billing_guild_assignments.owner_id = excluded.owner_id`,
        [input.guildId, input.ownerId, input.subscriptionId, input.nowMs, input.capacity],
      );
      if (changed === 0) return false;
      await projectPlan(transaction, input.guildId, input.plan, input.nowMs);
      await recordOperation(transaction, input.operation);
      return true;
    });
  }
  move(input: Parameters<BillingAssignmentStore["move"]>[0]): Promise<boolean> {
    return this.mutate(input.ownerId, [input.fromGuildId, input.toGuildId], async (transaction) => {
      const changed = await transaction.execute(
        `UPDATE billing_guild_assignments SET guild_id = $1, assigned_at_ms = $2
         WHERE guild_id = $3 AND owner_id = $4 AND stripe_subscription_id = $5
         AND NOT EXISTS(SELECT 1 FROM billing_guild_assignments WHERE guild_id = $1)`,
        [input.toGuildId, input.nowMs, input.fromGuildId, input.ownerId, input.subscriptionId],
      );
      if (changed === 0) return false;
      await projectPlan(transaction, input.fromGuildId, "free", input.nowMs);
      await projectPlan(transaction, input.toGuildId, input.plan, input.nowMs);
      await recordOperation(transaction, input.operation);
      return true;
    });
  }
  unassign(input: Parameters<BillingAssignmentStore["unassign"]>[0]): Promise<boolean> {
    return this.mutate(input.ownerId, [input.guildId], async (transaction) => {
      const changed = await transaction.execute(
        "DELETE FROM billing_guild_assignments WHERE guild_id = $1 AND owner_id = $2 AND stripe_subscription_id = $3",
        [input.guildId, input.ownerId, input.subscriptionId],
      );
      if (changed === 0) return false;
      await projectPlan(transaction, input.guildId, "free", input.nowMs);
      await recordOperation(transaction, input.operation);
      return true;
    });
  }
  private mutate<T>(
    ownerId: string,
    guildIds: string[],
    operation: (transaction: PostgresExecutor) => Promise<T>,
  ) {
    return this.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `billing-owner:${ownerId}`,
      ]);
      for (const guildId of [...new Set(guildIds)].sort()) {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `billing-guild:${guildId}`,
        ]);
      }
      return operation(transaction);
    });
  }
}

async function projectPlan(
  database: PostgresExecutor,
  guildId: string,
  plan: string,
  nowMs: number,
) {
  await database.execute(
    `INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET plan = excluded.plan, updated_at_ms = excluded.updated_at_ms`,
    [guildId, plan, nowMs],
  );
}

async function recordOperation(
  database: PostgresExecutor,
  operation: BillingLedgerOperation | undefined,
) {
  if (!operation) return;
  await database.execute(
    `INSERT INTO billing_operations_ledger (id, owner_id, kind, source, correlation_id, summary_json, created_at_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [
      operation.id,
      operation.ownerId,
      operation.kind,
      operation.source,
      operation.correlationId,
      operation.summaryJson,
      operation.createdAtMs,
    ],
  );
  await database.execute(
    `INSERT INTO billing_operation_delivery (operation_id, updated_at_ms) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [operation.id, operation.createdAtMs],
  );
  await database.execute(
    `INSERT INTO billing_delivery_outbox (operation_id, created_at_ms) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [operation.id, operation.createdAtMs],
  );
}
