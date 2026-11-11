import type {
  BillingAssignmentStore,
  BillingGuildAssignment,
} from "../../../../../src/runtime/billing/assignments";
import { SqliteBillingSyncStore } from "./sqlite-billing-sync-store";
import type { BillingLedgerOperation } from "../../../../../src/runtime/billing/types";

export class SqliteBillingAssignmentStore implements BillingAssignmentStore {
  private readonly billing: SqliteBillingSyncStore;
  constructor(private readonly database: D1Database) {
    this.billing = new SqliteBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async listAssignments(ownerId: string): Promise<BillingGuildAssignment[]> {
    const result = await this.database
      .prepare(
        "SELECT guild_id, owner_id, stripe_subscription_id, assigned_at_ms FROM billing_guild_assignments WHERE owner_id = ? ORDER BY assigned_at_ms",
      )
      .bind(ownerId)
      .all<{
        guild_id: string;
        owner_id: string;
        stripe_subscription_id: string;
        assigned_at_ms: number;
      }>();
    return result.results.map((row) => ({
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
    const placeholders = guildIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(`SELECT guild_id, plan FROM guild_entitlements WHERE guild_id IN (${placeholders})`)
      .bind(...guildIds)
      .all<{ guild_id: string; plan: "free" | "premium" | "premium_plus" }>();
    return new Map(result.results.map((row) => [row.guild_id, row.plan]));
  }
  async assign(input: Parameters<BillingAssignmentStore["assign"]>[0]): Promise<boolean> {
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO billing_guild_assignments(guild_id, owner_id, stripe_subscription_id, assigned_at_ms)
         SELECT ?, ?, ?, ? WHERE
           EXISTS(SELECT 1 FROM billing_guild_assignments WHERE guild_id = ? AND owner_id = ?)
           OR (SELECT COUNT(*) FROM billing_guild_assignments WHERE owner_id = ?) < ?
         ON CONFLICT(guild_id) DO UPDATE SET
           stripe_subscription_id = excluded.stripe_subscription_id,
           assigned_at_ms = excluded.assigned_at_ms
         WHERE billing_guild_assignments.owner_id = excluded.owner_id`,
        )
        .bind(
          input.guildId,
          input.ownerId,
          input.subscriptionId,
          input.nowMs,
          input.guildId,
          input.ownerId,
          input.ownerId,
          input.capacity,
        ),
      ...operationStatements(
        this.database,
        input.operation,
        `EXISTS(SELECT 1 FROM billing_guild_assignments
          WHERE guild_id = ? AND owner_id = ? AND stripe_subscription_id = ?)`,
        [input.guildId, input.ownerId, input.subscriptionId],
      ),
      projectPlan(
        this.database,
        input.guildId,
        input.ownerId,
        input.subscriptionId,
        input.plan,
        input.nowMs,
      ),
    ]);
    const assignment = await this.readAssignment(input.guildId);
    return (
      assignment?.ownerId === input.ownerId && assignment.subscriptionId === input.subscriptionId
    );
  }
  async move(input: Parameters<BillingAssignmentStore["move"]>[0]): Promise<boolean> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE billing_guild_assignments SET guild_id = ?, assigned_at_ms = ?
         WHERE guild_id = ? AND owner_id = ? AND stripe_subscription_id = ?
           AND NOT EXISTS(SELECT 1 FROM billing_guild_assignments WHERE guild_id = ?)`,
        )
        .bind(
          input.toGuildId,
          input.nowMs,
          input.fromGuildId,
          input.ownerId,
          input.subscriptionId,
          input.toGuildId,
        ),
      ...operationStatements(
        this.database,
        input.operation,
        `EXISTS(SELECT 1 FROM billing_guild_assignments
          WHERE guild_id = ? AND owner_id = ? AND stripe_subscription_id = ?)
         AND NOT EXISTS(SELECT 1 FROM billing_guild_assignments WHERE guild_id = ?)`,
        [input.toGuildId, input.ownerId, input.subscriptionId, input.fromGuildId],
      ),
      projectFreeIfUnassigned(this.database, input.fromGuildId, input.nowMs),
      projectPlan(
        this.database,
        input.toGuildId,
        input.ownerId,
        input.subscriptionId,
        input.plan,
        input.nowMs,
      ),
    ]);
    const [target, source] = await Promise.all([
      this.readAssignment(input.toGuildId),
      this.readAssignment(input.fromGuildId),
    ]);
    return (
      target?.ownerId === input.ownerId &&
      target.subscriptionId === input.subscriptionId &&
      source === null
    );
  }
  async unassign(input: Parameters<BillingAssignmentStore["unassign"]>[0]): Promise<boolean> {
    const existing = await this.readAssignment(input.guildId);
    if (existing?.ownerId !== input.ownerId || existing.subscriptionId !== input.subscriptionId)
      return false;
    await this.database.batch([
      this.database
        .prepare(
          "DELETE FROM billing_guild_assignments WHERE guild_id = ? AND owner_id = ? AND stripe_subscription_id = ?",
        )
        .bind(input.guildId, input.ownerId, input.subscriptionId),
      ...operationStatements(this.database, input.operation, "changes() > 0", []),
      projectFreeIfUnassigned(this.database, input.guildId, input.nowMs),
    ]);
    return true;
  }
  private async readAssignment(guildId: string): Promise<BillingGuildAssignment | null> {
    const row = await this.database
      .prepare(
        "SELECT guild_id, owner_id, stripe_subscription_id, assigned_at_ms FROM billing_guild_assignments WHERE guild_id = ?",
      )
      .bind(guildId)
      .first<{
        guild_id: string;
        owner_id: string;
        stripe_subscription_id: string;
        assigned_at_ms: number;
      }>();
    return row
      ? {
          guildId: row.guild_id,
          ownerId: row.owner_id,
          subscriptionId: row.stripe_subscription_id,
          assignedAtMs: row.assigned_at_ms,
        }
      : null;
  }
}

function operationStatements(
  database: D1Database,
  operation: BillingLedgerOperation | undefined,
  condition: string,
  conditionBindings: unknown[],
): D1PreparedStatement[] {
  if (!operation) return [];
  return [
    database
      .prepare(
        `INSERT INTO billing_operations_ledger(
           id, owner_id, kind, source, correlation_id, summary_json, created_at_ms
         ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`,
      )
      .bind(
        operation.id,
        operation.ownerId,
        operation.kind,
        operation.source,
        operation.correlationId,
        operation.summaryJson,
        operation.createdAtMs,
        ...conditionBindings,
      ),
    database
      .prepare(
        `INSERT INTO billing_operation_delivery(operation_id, updated_at_ms)
         SELECT ?, ? WHERE EXISTS(SELECT 1 FROM billing_operations_ledger WHERE id = ?)`,
      )
      .bind(operation.id, operation.createdAtMs, operation.id),
    database
      .prepare(
        `INSERT INTO billing_delivery_outbox(operation_id, created_at_ms)
         SELECT ?, ? WHERE EXISTS(SELECT 1 FROM billing_operations_ledger WHERE id = ?)`,
      )
      .bind(operation.id, operation.createdAtMs, operation.id),
  ];
}

function projectPlan(
  database: D1Database,
  guildId: string,
  ownerId: string,
  subscriptionId: string,
  plan: string,
  nowMs: number,
) {
  return database
    .prepare(
      `INSERT INTO guild_entitlements(guild_id, plan, updated_at_ms)
     SELECT ?, ?, ? WHERE EXISTS(
       SELECT 1 FROM billing_guild_assignments
       WHERE guild_id = ? AND owner_id = ? AND stripe_subscription_id = ?
      ) ON CONFLICT(guild_id) DO UPDATE SET plan = excluded.plan, updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(guildId, plan, nowMs, guildId, ownerId, subscriptionId);
}

function projectFreeIfUnassigned(database: D1Database, guildId: string, nowMs: number) {
  return database
    .prepare(
      `INSERT INTO guild_entitlements(guild_id, plan, updated_at_ms)
     SELECT ?, 'free', ? WHERE NOT EXISTS(
       SELECT 1 FROM billing_guild_assignments WHERE guild_id = ?
      ) ON CONFLICT(guild_id) DO UPDATE SET plan = 'free', updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(guildId, nowMs, guildId);
}
