import type {
  PaidRoleEntitlementState,
  PaidRoleEntitlementStore,
  PaidRoleManagedAssignment,
  PaidRoleMemberState,
  PaidRoleProviderActionInput,
} from "../../../../../src/commerce/paid-role-entitlement";

export interface PaidRoleOutboxMessage {
  id: string;
  operationKey: string;
  entitlementId: string;
  guildId: string;
  discordUserId: string;
  discordRoleId: string;
  action: "assign" | "remove" | "repair";
  payloadJson: string;
  status: "pending" | "sent" | "dead_letter";
  availableAtMs: number;
  sentAtMs: number | null;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaidRoleRepairRecord {
  id: string;
  offeringId: string;
  guildId: string;
  oldRoleId: string;
  replacementRoleId: string | null;
  startedAtMs: number;
  deadlineAtMs: number;
  status: "pending" | "complete" | "quarantined";
  repairedCount: number;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaidRoleProviderAction {
  id: string;
  operationKey: string;
  assignmentId: string | null;
  connectedAccountId: string;
  subscriptionId: string;
  actionType: PaidRoleProviderActionInput["actionType"];
  reasonCode: string;
  status: "pending" | "processing" | "completed" | "failed";
  attemptCount: number;
  availableAtMs: number;
  claimedAtMs: number | null;
  leaseExpiresAtMs: number | null;
  completedAtMs: number | null;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaidRoleAuditEntry {
  id: string;
  connectedAccountId?: string | null;
  guildId: string;
  operationKey: string;
  operationType: string;
  entityType: string;
  entityId: string;
  actorType: "system" | "stripe" | "buyer" | "seller" | "operator";
  actorId?: string | null;
  payloadJson?: string;
  createdAtMs: number;
}

export interface PaidRoleIncident {
  id: string;
  connectedAccountId?: string | null;
  guildId: string;
  incidentKey: string;
  severity: "warning" | "error" | "critical";
  status: "open" | "resolved";
  summaryCode: string;
  entityType?: string | null;
  entityId?: string | null;
  safeArgsJson: string;
  occurrenceCount: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  resolvedAtMs?: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaidRoleNotification {
  id: string;
  operationId: string;
  destinationType: "buyer_dm" | "seller_audit" | "admin_audit";
  destinationId: string;
  payloadJson: string;
  status: "pending" | "processing" | "delivered" | "dead_letter";
  attemptCount: number;
  availableAtMs: number;
  lastErrorCode: string | null;
  deliveredAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

type Row = Record<string, unknown>;

export class SqlitePaidRoleStore implements PaidRoleEntitlementStore {
  constructor(
    private readonly database: D1Database,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async readState(entitlementId: string): Promise<PaidRoleEntitlementState | null> {
    const row = await first(
      this.database,
      "SELECT * FROM commerce_paid_role_states WHERE entitlement_id = ?",
      entitlementId,
    );
    return row ? stateFromRow(row) : null;
  }

  async saveState(state: PaidRoleEntitlementState): Promise<void> {
    await run(
      this.database,
      `INSERT INTO commerce_paid_role_states(
      entitlement_id,connected_account_id,guild_id,discord_user_id,discord_role_id,subscription_id,subscription_status,
      cancel_at_period_end,current_period_end_ms,payment_status,amount_minor,amount_refunded_minor,
      dispute_status,failed_payment_at_ms,admin_action,member_state,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entitlement_id) DO UPDATE SET connected_account_id=excluded.connected_account_id,guild_id=excluded.guild_id,discord_user_id=excluded.discord_user_id,
      discord_role_id=excluded.discord_role_id,subscription_id=excluded.subscription_id,subscription_status=excluded.subscription_status,
      cancel_at_period_end=excluded.cancel_at_period_end,current_period_end_ms=excluded.current_period_end_ms,
      payment_status=excluded.payment_status,amount_minor=excluded.amount_minor,amount_refunded_minor=excluded.amount_refunded_minor,
      dispute_status=excluded.dispute_status,failed_payment_at_ms=excluded.failed_payment_at_ms,admin_action=excluded.admin_action,
      member_state=excluded.member_state,updated_at_ms=excluded.updated_at_ms`,
      state.entitlementId,
      state.connectedAccountId,
      state.guildId,
      state.discordUserId,
      state.discordRoleId,
      state.subscriptionId,
      state.subscriptionStatus,
      state.cancelAtPeriodEnd ? 1 : 0,
      state.currentPeriodEndMs,
      state.paymentStatus,
      state.amountMinor,
      state.amountRefundedMinor,
      state.disputeStatus,
      state.failedPaymentAtMs,
      state.adminAction,
      state.memberState,
      state.updatedAtMs,
    );
  }

  async buildEntitlementState(entitlementId: string, memberState: PaidRoleMemberState = "present") {
    const row = await first(
      this.database,
      `SELECT e.id AS entitlement_id,e.connected_account_id,o.guild_id,o.discord_role_id,
      b.discord_user_id,s.stripe_subscription_id AS subscription_id,s.status AS subscription_status,
      s.cancel_at_period_end,s.current_period_end_ms,s.latest_payment_status,
      s.grace_started_at_ms,p.status AS payment_status,p.amount_minor,p.amount_refunded_minor,
      d.status AS dispute_status
      FROM commerce_entitlements e
      JOIN commerce_offerings o ON o.id=e.offering_id
      JOIN commerce_buyers b ON b.id=e.buyer_id
      LEFT JOIN commerce_subscriptions s
        ON s.connected_account_id=e.connected_account_id
       AND s.stripe_subscription_id=e.source_id AND e.source_type='subscription'
      LEFT JOIN commerce_payments p
        ON p.connected_account_id=e.connected_account_id
       AND (
         (e.source_type='subscription' AND p.stripe_payment_intent_id=s.latest_payment_intent_id) OR
         (e.source_type='payment' AND p.stripe_payment_intent_id=e.source_id)
       )
      LEFT JOIN commerce_disputes d ON d.payment_id=p.id
      WHERE e.id=? ORDER BY p.updated_at_ms DESC,d.updated_at_ms DESC LIMIT 1`,
      entitlementId,
    );
    if (!row) return null;
    return {
      entitlementId: String(row.entitlement_id),
      connectedAccountId: String(row.connected_account_id),
      guildId: String(row.guild_id),
      discordUserId: String(row.discord_user_id),
      discordRoleId: String(row.discord_role_id),
      subscriptionId: nullable(row.subscription_id),
      subscriptionStatus: String(
        row.subscription_status ?? "active",
      ) as PaidRoleEntitlementState["subscriptionStatus"],
      cancelAtPeriodEnd: Number(row.cancel_at_period_end ?? 0) === 1,
      currentPeriodEndMs: numberOrNull(row.current_period_end_ms),
      paymentStatus: nullable(
        row.latest_payment_status ?? row.payment_status,
      ) as PaidRoleEntitlementState["paymentStatus"],
      amountMinor: numberOrNull(row.amount_minor),
      amountRefundedMinor: Number(row.amount_refunded_minor ?? 0),
      disputeStatus: nullable(row.dispute_status) as PaidRoleEntitlementState["disputeStatus"],
      failedPaymentAtMs: numberOrNull(row.grace_started_at_ms),
      adminAction: null,
      memberState,
      updatedAtMs: Date.now(),
    } satisfies PaidRoleEntitlementState;
  }

  readCurrentEntitlementState(entitlementId: string, memberState: PaidRoleMemberState = "present") {
    return this.buildEntitlementState(entitlementId, memberState);
  }

  async readManagedAssignment(input: {
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
  }) {
    const row = await first(
      this.database,
      `SELECT * FROM commerce_role_assignments
      WHERE entitlement_id=? AND guild_id=? AND discord_user_id=? AND discord_role_id=?
        AND status IN ('pending','assigned','withheld','removing','removed','failed')
      ORDER BY updated_at_ms DESC LIMIT 1`,
      input.entitlementId,
      input.guildId,
      input.discordUserId,
      input.discordRoleId,
    );
    return row ? assignmentFromRow(row) : null;
  }

  async saveManagedAssignment(assignment: PaidRoleManagedAssignment): Promise<void> {
    await run(
      this.database,
      `INSERT INTO commerce_role_assignments(
      id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,withheld_reason,provider_cancellation_state,attempt_count,last_error_code,next_attempt_at_ms,assigned_at_ms,removed_at_ms,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entitlement_id) DO UPDATE SET guild_id=excluded.guild_id,
      discord_user_id=excluded.discord_user_id,discord_role_id=excluded.discord_role_id,status=excluded.status,
      withheld_reason=excluded.withheld_reason,provider_cancellation_state=excluded.provider_cancellation_state,
      attempt_count=excluded.attempt_count,last_error_code=excluded.last_error_code,assigned_at_ms=excluded.assigned_at_ms,
      removed_at_ms=excluded.removed_at_ms,updated_at_ms=excluded.updated_at_ms`,
      assignment.id,
      assignment.entitlementId,
      assignment.guildId,
      assignment.discordUserId,
      assignment.discordRoleId,
      assignment.state === "managed" ? "assigned" : assignment.state,
      assignment.withheldReason,
      assignment.providerCancellationState,
      assignment.attemptCount,
      assignment.lastErrorCode,
      null,
      assignment.assignedAtMs,
      assignment.removedAtMs,
      assignment.updatedAtMs,
      assignment.updatedAtMs,
    );
  }

  async listManagedAssignments(input: {
    offeringId?: string;
    guildId: string;
    discordRoleId: string;
  }) {
    const rows = await all(
      this.database,
      `SELECT ra.* FROM commerce_role_assignments ra
       JOIN commerce_entitlements e ON e.id=ra.entitlement_id
       WHERE ra.guild_id=? AND ra.discord_role_id=?
         AND (CAST(? AS TEXT) IS NULL OR e.offering_id=?)
         AND ra.status IN ('pending','assigned','withheld','removing','failed')
       ORDER BY ra.updated_at_ms`,
      input.guildId,
      input.discordRoleId,
      input.offeringId ?? null,
      input.offeringId ?? null,
    );
    return rows.map(assignmentFromRow);
  }

  async enqueueProviderAction(input: PaidRoleProviderActionInput) {
    await run(
      this.database,
      `INSERT INTO commerce_paid_role_provider_actions(
         id,operation_key,assignment_id,connected_account_id,stripe_subscription_id,
         action_type,reason_code,status,attempt_count,available_at_ms,claimed_at_ms,
         lease_expires_at_ms,completed_at_ms,last_error_code,created_at_ms,updated_at_ms
       ) VALUES (?,?,?,?,?,?,?,'pending',0,?,NULL,NULL,NULL,NULL,?,?)
       ON CONFLICT(operation_key) DO NOTHING`,
      input.operationKey,
      input.operationKey,
      input.assignmentId,
      input.connectedAccountId,
      input.subscriptionId,
      input.actionType,
      input.reasonCode,
      input.nowMs,
      input.nowMs,
      input.nowMs,
    );
    const row = await first(
      this.database,
      "SELECT status,action_type FROM commerce_paid_role_provider_actions WHERE operation_key=?",
      input.operationKey,
    );
    if (row?.status === "completed") {
      return row.action_type === "subscription.cancel_at_period_end" ? "scheduled" : "completed";
    }
    if (row?.status === "failed") return "failed";
    return "pending";
  }

  async listDueProviderActions(nowMs: number, limit = 100): Promise<PaidRoleProviderAction[]> {
    return (
      await all(
        this.database,
        `SELECT * FROM commerce_paid_role_provider_actions
         WHERE available_at_ms<=?
           AND (status IN ('pending','failed') OR (status='processing' AND lease_expires_at_ms<=?))
         ORDER BY available_at_ms,created_at_ms LIMIT ?`,
        nowMs,
        nowMs,
        limit,
      )
    ).map(providerActionFromRow);
  }

  async claimProviderAction(id: string, nowMs: number): Promise<number | null> {
    const result = await run(
      this.database,
      `UPDATE commerce_paid_role_provider_actions
       SET status='processing',attempt_count=attempt_count+1,claimed_at_ms=?,lease_expires_at_ms=?,
           last_error_code=NULL,updated_at_ms=?
       WHERE id=? AND (status IN ('pending','failed') OR (status='processing' AND lease_expires_at_ms<=?))`,
      nowMs,
      nowMs + 60_000,
      nowMs,
      id,
      nowMs,
    );
    return result.meta.changes > 0 ? nowMs : null;
  }

  async completeProviderAction(
    action: PaidRoleProviderAction,
    claimedAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const assignmentState =
      action.actionType === "subscription.cancel_at_period_end" ? "scheduled" : "completed";
    const statements = [];
    if (action.assignmentId) {
      statements.push(
        this.database
          .prepare(
            `UPDATE commerce_role_assignments
             SET provider_cancellation_state=?,updated_at_ms=?
             WHERE id=? AND EXISTS (
               SELECT 1 FROM commerce_paid_role_provider_actions
               WHERE id=? AND status='processing' AND claimed_at_ms=?
             )`,
          )
          .bind(assignmentState, nowMs, action.assignmentId, action.id, claimedAtMs),
      );
    }
    statements.push(
      this.database
        .prepare(
          `UPDATE commerce_paid_role_provider_actions
           SET status='completed',completed_at_ms=?,lease_expires_at_ms=?,last_error_code=NULL,updated_at_ms=?
           WHERE id=? AND status='processing' AND claimed_at_ms=?`,
        )
        .bind(nowMs, nowMs, nowMs, action.id, claimedAtMs),
    );
    const results = await this.database.batch(statements);
    return results.at(-1)?.meta.changes === 1;
  }

  async failProviderAction(
    action: PaidRoleProviderAction,
    claimedAtMs: number,
    errorCode: string,
    nowMs: number,
  ): Promise<void> {
    const retryAtMs = nowMs + Math.min(60 * 60_000, Math.max(1, action.attemptCount + 1) * 60_000);
    const statements = [];
    if (action.assignmentId) {
      statements.push(
        this.database
          .prepare(
            `UPDATE commerce_role_assignments
             SET provider_cancellation_state='failed',last_error_code=?,updated_at_ms=?
             WHERE id=? AND EXISTS (
               SELECT 1 FROM commerce_paid_role_provider_actions
               WHERE id=? AND status='processing' AND claimed_at_ms=?
             )`,
          )
          .bind(errorCode, nowMs, action.assignmentId, action.id, claimedAtMs),
      );
    }
    statements.push(
      this.database
        .prepare(
          `UPDATE commerce_paid_role_provider_actions
           SET status='failed',available_at_ms=?,lease_expires_at_ms=NULL,last_error_code=?,updated_at_ms=?
           WHERE id=? AND status='processing' AND claimed_at_ms=?`,
        )
        .bind(retryAtMs, errorCode, nowMs, action.id, claimedAtMs),
    );
    await this.database.batch(statements);
  }

  async appendOperation(input: {
    operationKey: string;
    entitlementId: string;
    operationType: string;
    createdAtMs: number;
  }): Promise<boolean> {
    const result = await run(
      this.database,
      `INSERT INTO commerce_paid_role_operations(
         operation_key,entitlement_id,operation_type,status,created_at_ms,claimed_at_ms,
         lease_expires_at_ms,committed_at_ms
       ) VALUES (?,?,?,'processing',?,?,?,NULL)
       ON CONFLICT(operation_key) DO UPDATE SET
         status='processing', claimed_at_ms=excluded.claimed_at_ms,
         lease_expires_at_ms=excluded.lease_expires_at_ms
       WHERE commerce_paid_role_operations.status='processing'
         AND commerce_paid_role_operations.lease_expires_at_ms<=excluded.claimed_at_ms`,
      input.operationKey,
      input.entitlementId,
      input.operationType,
      input.createdAtMs,
      input.createdAtMs,
      input.createdAtMs + 60_000,
    );
    return result.meta.changes > 0;
  }

  async releaseOperation(operationKey: string): Promise<void> {
    await run(
      this.database,
      "DELETE FROM commerce_paid_role_operations WHERE operation_key=? AND status='processing'",
      operationKey,
    );
  }

  async commitOperation(operationKey: string, committedAtMs: number): Promise<void> {
    await run(
      this.database,
      `UPDATE commerce_paid_role_operations
       SET status='committed', committed_at_ms=?, lease_expires_at_ms=?
       WHERE operation_key=? AND status='processing'`,
      committedAtMs,
      committedAtMs,
      operationKey,
    );
  }

  claimOperation(input: {
    operationKey: string;
    entitlementId: string;
    operationType: string;
    createdAtMs: number;
  }) {
    return this.appendOperation(input);
  }

  async readOperationStatus(operationKey: string): Promise<"processing" | "committed" | null> {
    const row = await first(
      this.database,
      "SELECT status FROM commerce_paid_role_operations WHERE operation_key=?",
      operationKey,
    );
    return row?.status === "processing" || row?.status === "committed" ? row.status : null;
  }

  async enqueueRoleOperation(
    input: Omit<
      PaidRoleOutboxMessage,
      "id" | "status" | "sentAtMs" | "attemptCount" | "lastErrorCode"
    > & { id?: string },
  ): Promise<boolean> {
    const now = input.updatedAtMs;
    const result = await run(
      this.database,
      `INSERT INTO commerce_paid_role_outbox(id,operation_key,entitlement_id,guild_id,discord_user_id,discord_role_id,action,payload_json,status,available_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?, 'pending',?,?,?) ON CONFLICT(operation_key) DO NOTHING`,
      input.id ?? this.createId(),
      input.operationKey,
      input.entitlementId,
      input.guildId,
      input.discordUserId,
      input.discordRoleId,
      input.action,
      input.payloadJson,
      input.availableAtMs,
      input.createdAtMs,
      now,
    );
    return result.meta.changes > 0;
  }

  async listRoleOutbox(nowMs: number, limit = 100): Promise<PaidRoleOutboxMessage[]> {
    return (
      await all(
        this.database,
        "SELECT * FROM commerce_paid_role_outbox WHERE status='pending' AND available_at_ms<=? ORDER BY created_at_ms LIMIT ?",
        nowMs,
        limit,
      )
    ).map(outboxFromRow);
  }

  enqueueRoleOutbox(
    input: Omit<
      PaidRoleOutboxMessage,
      "id" | "status" | "sentAtMs" | "attemptCount" | "lastErrorCode"
    > & { id?: string },
  ) {
    return this.enqueueRoleOperation(input);
  }

  listPendingRoleOutbox(nowMs: number, limit = 100) {
    return this.listRoleOutbox(nowMs, limit);
  }

  async markRoleOutboxSent(id: string, sentAtMs: number): Promise<void> {
    await run(
      this.database,
      "UPDATE commerce_paid_role_outbox SET status='sent',sent_at_ms=?,updated_at_ms=? WHERE id=? AND status='pending'",
      sentAtMs,
      sentAtMs,
      id,
    );
  }

  async recordRoleOutboxFailure(
    id: string,
    attempts: number,
    errorCode: string,
    deadLetter: boolean,
    updatedAtMs: number,
  ): Promise<void> {
    await run(
      this.database,
      `UPDATE commerce_paid_role_outbox
       SET status = CASE WHEN ? = 1 THEN 'dead_letter' ELSE status END,
           attempt_count = MAX(attempt_count, ?), last_error_code = ?, updated_at_ms = ?
       WHERE id = ?`,
      deadLetter ? 1 : 0,
      attempts,
      errorCode,
      updatedAtMs,
      id,
    );
  }

  async enqueueHourlyDrift(nowMs: number): Promise<number> {
    const hour = new Date(nowMs).toISOString().slice(0, 13);
    const rows = await all(
      this.database,
      `SELECT id, entitlement_id, guild_id, discord_user_id, discord_role_id, status
       FROM commerce_role_assignments
       WHERE status IN ('pending', 'assigned', 'withheld', 'removing', 'failed')`,
    );
    let enqueued = 0;
    for (const row of rows) {
      const action = row.status === "removing" ? "remove" : "assign";
      if (
        await this.enqueueRoleOperation({
          operationKey: `commerce-role-drift:${row.id}:${hour}`,
          entitlementId: String(row.entitlement_id),
          guildId: String(row.guild_id),
          discordUserId: String(row.discord_user_id),
          discordRoleId: String(row.discord_role_id),
          action,
          payloadJson: JSON.stringify({ source: "scheduled_drift" }),
          availableAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
      ) {
        enqueued += 1;
      }
    }
    return enqueued;
  }

  async enqueueMemberLifecycle(
    guildId: string,
    discordUserId: string,
    memberState: "left" | "rejoined" | "banned",
    eventKey: string,
    nowMs: number,
  ): Promise<number> {
    const rows = await all(
      this.database,
      `SELECT id, entitlement_id, discord_role_id
       FROM commerce_role_assignments
       WHERE guild_id=? AND discord_user_id=?
          AND status IN ('pending', 'assigned', 'withheld', 'removing', 'failed')`,
      guildId,
      discordUserId,
    );
    let enqueued = 0;
    for (const row of rows) {
      if (
        await this.enqueueRoleOperation({
          operationKey: `commerce-role-member:${eventKey}:${row.id}`,
          entitlementId: String(row.entitlement_id),
          guildId,
          discordUserId,
          discordRoleId: String(row.discord_role_id),
          action: memberState === "rejoined" ? "assign" : "remove",
          payloadJson: JSON.stringify({ memberState }),
          availableAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
      ) {
        enqueued += 1;
      }
    }
    return enqueued;
  }

  async enqueueGuildDeletion(guildId: string, eventKey: string, nowMs: number): Promise<number> {
    const rows = await all(
      this.database,
      `SELECT s.id AS subscription_id,s.stripe_subscription_id,s.connected_account_id,
              s.buyer_id,s.current_period_end_ms,a.stripe_account_id,b.discord_user_id,
              p.id AS payment_id,COALESCE(p.paid_at_ms,p.provider_created_at_ms,p.created_at_ms) AS paid_at_ms
       FROM commerce_subscriptions s
       JOIN commerce_offerings o
         ON o.id=s.offering_id AND o.connected_account_id=s.connected_account_id
       JOIN commerce_connected_accounts a
         ON a.id=s.connected_account_id AND a.guild_id=o.guild_id
       JOIN commerce_buyers b ON b.id=s.buyer_id
       LEFT JOIN commerce_payments p
         ON p.connected_account_id=s.connected_account_id
        AND p.stripe_payment_intent_id=s.latest_payment_intent_id
       WHERE o.guild_id=? AND s.status NOT IN ('canceled','ended')`,
      guildId,
    );
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_offering_lifecycles
           SET state='archived',archived_at_ms=COALESCE(archived_at_ms,?),updated_at_ms=?
           WHERE guild_id=?`,
        )
        .bind(nowMs, nowMs, guildId),
      this.database
        .prepare(
          `UPDATE commerce_offerings
           SET status='archived',archived_at_ms=COALESCE(archived_at_ms,?),updated_at_ms=?
           WHERE guild_id=?`,
        )
        .bind(nowMs, nowMs, guildId),
      this.database
        .prepare("UPDATE commerce_support_configs SET enabled=0,updated_at_ms=? WHERE guild_id=?")
        .bind(nowMs, guildId),
      this.database
        .prepare(
          `UPDATE commerce_role_assignments
           SET status='removed',withheld_reason=NULL,removed_at_ms=COALESCE(removed_at_ms,?),updated_at_ms=?
           WHERE guild_id=? AND status<>'removed'`,
        )
        .bind(nowMs, nowMs, guildId),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO commerce_operations_ledger(
             id,connected_account_id,guild_id,operation_key,operation_type,entity_type,
             entity_id,actor_type,actor_id,payload_json,created_at_ms
           ) VALUES (?,?,?,?,'guild.deleted','guild',?,'system',NULL,'{}',?)`,
        )
        .bind(
          `guild-delete:${eventKey}`,
          null,
          guildId,
          `guild-delete:${eventKey}`,
          guildId,
          nowMs,
        ),
    ]);
    for (const row of rows) {
      const operationKey = `paid-role-provider:${row.stripe_account_id}:${row.stripe_subscription_id}:subscription.cancel_immediately`;
      await this.enqueueProviderAction({
        operationKey,
        assignmentId: null,
        connectedAccountId: String(row.stripe_account_id),
        subscriptionId: String(row.stripe_subscription_id),
        actionType: "subscription.cancel_immediately",
        reasonCode: "guild_deleted",
        nowMs,
      });
      await run(
        this.database,
        `INSERT INTO commerce_guild_deletion_refund_reviews(
           id,guild_id,connected_account_id,subscription_id,buyer_id,payment_id,
           payment_paid_at_ms,paid_through_at_ms,status,created_at_ms,updated_at_ms
         ) VALUES (?,?,?,?,?,?,?,?, 'pending',?,?)
         ON CONFLICT(connected_account_id,subscription_id) DO NOTHING`,
        `guild-delete-refund:${row.connected_account_id}:${row.subscription_id}`,
        guildId,
        row.connected_account_id,
        row.subscription_id,
        row.buyer_id,
        row.payment_id,
        row.paid_at_ms,
        row.current_period_end_ms,
        nowMs,
        nowMs,
      );
      await this.enqueueNotification({
        id: `notification:guild-delete:${eventKey}:${row.buyer_id}`,
        operationId: `guild-delete:${eventKey}`,
        destinationType: "buyer_dm",
        destinationId: String(row.discord_user_id),
        payloadJson: JSON.stringify({ kind: "guild_deleted", guildId }),
        status: "pending",
        attemptCount: 0,
        availableAtMs: nowMs,
        lastErrorCode: null,
        deliveredAtMs: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    await this.enqueueNotification({
      id: `notification:guild-delete:${eventKey}:seller`,
      operationId: `guild-delete:${eventKey}`,
      destinationType: "seller_audit",
      destinationId: guildId,
      payloadJson: JSON.stringify({ kind: "guild_deleted", guildId }),
      status: "pending",
      attemptCount: 0,
      availableAtMs: nowMs,
      lastErrorCode: null,
      deliveredAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return rows.length;
  }

  async saveRoleRepair(repair: PaidRoleRepairRecord): Promise<void> {
    await run(
      this.database,
      `INSERT INTO commerce_paid_role_repairs(id,offering_id,guild_id,old_role_id,replacement_role_id,started_at_ms,deadline_at_ms,status,repaired_count,last_error_code,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      replacement_role_id=COALESCE(excluded.replacement_role_id,commerce_paid_role_repairs.replacement_role_id),
      status=CASE WHEN commerce_paid_role_repairs.status='pending' THEN excluded.status ELSE commerce_paid_role_repairs.status END,
      repaired_count=excluded.repaired_count,last_error_code=excluded.last_error_code,updated_at_ms=excluded.updated_at_ms`,
      repair.id,
      repair.offeringId,
      repair.guildId,
      repair.oldRoleId,
      repair.replacementRoleId,
      repair.startedAtMs,
      repair.deadlineAtMs,
      repair.status,
      repair.repairedCount,
      repair.lastErrorCode,
      repair.createdAtMs,
      repair.updatedAtMs,
    );
    await run(
      this.database,
      `UPDATE commerce_offering_lifecycles
       SET state='repair_required',repair_deadline_at_ms=COALESCE(repair_deadline_at_ms,?),
           role_manageable=0,updated_at_ms=?
       WHERE guild_id=? AND offering_id=? AND state<>'archived'`,
      repair.deadlineAtMs,
      repair.updatedAtMs,
      repair.guildId,
      repair.offeringId,
    );
  }

  async completeRoleRepair(repair: PaidRoleRepairRecord, nowMs: number): Promise<void> {
    if (!repair.replacementRoleId) throw new Error("commerce_role_replacement_missing");
    const offering = await run(
      this.database,
      `UPDATE commerce_offerings SET discord_role_id=?,updated_at_ms=?
       WHERE id=? AND guild_id=? AND discord_role_id IN (?,?) AND EXISTS (
         SELECT 1 FROM commerce_offering_lifecycles lifecycle
         WHERE lifecycle.offering_id=commerce_offerings.id
           AND lifecycle.guild_id=? AND lifecycle.state='repair_required'
       )`,
      repair.replacementRoleId,
      nowMs,
      repair.offeringId,
      repair.guildId,
      repair.oldRoleId,
      repair.replacementRoleId,
      repair.guildId,
    );
    if (offering.meta.changes === 0) throw new Error("commerce_role_repair_stale");
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_offering_lifecycles
           SET state=CASE
                 WHEN offering_id IN (SELECT id FROM commerce_offerings WHERE status='active')
                   THEN 'published'
                 ELSE 'unpublished'
               END,
               role_manageable=1,repair_deadline_at_ms=NULL,updated_at_ms=?
           WHERE offering_id=? AND guild_id=? AND state='repair_required'`,
        )
        .bind(nowMs, repair.offeringId, repair.guildId),
      this.database
        .prepare(
          `UPDATE commerce_paid_role_states SET discord_role_id=?,updated_at_ms=?
           WHERE entitlement_id IN (
             SELECT id FROM commerce_entitlements WHERE offering_id=?
           ) AND guild_id=? AND discord_role_id=?`,
        )
        .bind(repair.replacementRoleId, nowMs, repair.offeringId, repair.guildId, repair.oldRoleId),
      this.database
        .prepare(
          `UPDATE commerce_paid_role_repairs
           SET status='complete',repaired_count=?,last_error_code=NULL,updated_at_ms=?
           WHERE id=? AND offering_id=? AND status='pending'`,
        )
        .bind(repair.repairedCount, nowMs, repair.id, repair.offeringId),
    ]);
  }

  async hasOutstandingRoleRepairAssignments(repair: PaidRoleRepairRecord): Promise<boolean> {
    const row = await first(
      this.database,
      `SELECT 1 AS found FROM commerce_role_assignments ra
       JOIN commerce_entitlements e ON e.id=ra.entitlement_id
       WHERE e.offering_id=? AND ra.guild_id=? AND ra.discord_role_id=?
         AND ra.status IN ('pending','assigned','withheld','removing','failed')
       LIMIT 1`,
      repair.offeringId,
      repair.guildId,
      repair.oldRoleId,
    );
    return Boolean(row?.found);
  }

  async selectRoleReplacement(
    repairId: string,
    replacementRoleId: string,
    updatedAtMs: number,
  ): Promise<boolean> {
    const result = await run(
      this.database,
      `UPDATE commerce_paid_role_repairs
       SET replacement_role_id=?, updated_at_ms=?
       WHERE id=? AND status='pending' AND replacement_role_id IS NULL`,
      replacementRoleId,
      updatedAtMs,
      repairId,
    );
    return result.meta.changes > 0;
  }

  async readOfferingIdForEntitlement(entitlementId: string): Promise<string | null> {
    const row = await first(
      this.database,
      "SELECT offering_id FROM commerce_entitlements WHERE id=?",
      entitlementId,
    );
    return nullable(row?.offering_id);
  }

  async listDueRoleRepairs(nowMs: number): Promise<PaidRoleRepairRecord[]> {
    return (
      await all(
        this.database,
        "SELECT * FROM commerce_paid_role_repairs WHERE status='pending' AND deadline_at_ms>=? ORDER BY deadline_at_ms",
        nowMs,
      )
    ).map(repairFromRow);
  }

  async listPendingRoleRepairs(): Promise<PaidRoleRepairRecord[]> {
    return (
      await all(
        this.database,
        "SELECT * FROM commerce_paid_role_repairs WHERE status='pending' ORDER BY deadline_at_ms",
      )
    ).map(repairFromRow);
  }

  enqueueRoleRepair(repair: PaidRoleRepairRecord) {
    return this.saveRoleRepair(repair);
  }

  listHourlyRoleRepairs(nowMs: number) {
    return this.listDueRoleRepairs(nowMs);
  }

  async appendAudit(entry: PaidRoleAuditEntry): Promise<boolean> {
    const result = await run(
      this.database,
      `INSERT INTO commerce_operations_ledger(id,connected_account_id,guild_id,operation_key,operation_type,entity_type,entity_id,actor_type,actor_id,payload_json,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,operation_key) DO NOTHING`,
      entry.id,
      entry.connectedAccountId ?? null,
      entry.guildId,
      entry.operationKey,
      entry.operationType,
      entry.entityType,
      entry.entityId,
      entry.actorType,
      entry.actorId ?? null,
      entry.payloadJson ?? "{}",
      entry.createdAtMs,
    );
    return result.meta.changes > 0;
  }

  async audit(input: {
    operationKey: string;
    operationType: string;
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    safeReason: string;
    createdAtMs: number;
  }): Promise<void> {
    await this.appendAudit({
      id: `audit:${input.operationKey}`,
      guildId: input.guildId,
      operationKey: input.operationKey,
      operationType: input.operationType,
      entityType: "entitlement",
      entityId: input.entitlementId,
      actorType: "system",
      payloadJson: JSON.stringify({ reason: input.safeReason, discordUserId: input.discordUserId }),
      createdAtMs: input.createdAtMs,
    });
  }

  async saveIncident(incident: PaidRoleIncident): Promise<void> {
    await run(
      this.database,
      `INSERT INTO commerce_incidents(id,connected_account_id,guild_id,incident_key,severity,status,summary_code,entity_type,entity_id,safe_args_json,occurrence_count,first_seen_at_ms,last_seen_at_ms,resolved_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,incident_key) DO UPDATE SET occurrence_count=commerce_incidents.occurrence_count+1,last_seen_at_ms=excluded.last_seen_at_ms,updated_at_ms=excluded.updated_at_ms,status=excluded.status,safe_args_json=excluded.safe_args_json`,
      incident.id,
      incident.connectedAccountId ?? null,
      incident.guildId,
      incident.incidentKey,
      incident.severity,
      incident.status,
      incident.summaryCode,
      incident.entityType ?? null,
      incident.entityId ?? null,
      incident.safeArgsJson,
      incident.occurrenceCount,
      incident.firstSeenAtMs,
      incident.lastSeenAtMs,
      incident.resolvedAtMs ?? null,
      incident.createdAtMs,
      incident.updatedAtMs,
    );
  }

  async incident(input: {
    incidentKey: string;
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    code:
      | "permission"
      | "hierarchy"
      | "role_missing"
      | "member_missing"
      | "repair_window_expired"
      | "repair_failed";
    safeReason: string;
    createdAtMs: number;
  }): Promise<void> {
    await this.saveIncident({
      id: `incident:${input.incidentKey}`,
      guildId: input.guildId,
      incidentKey: input.incidentKey,
      severity: "error",
      status: "open",
      summaryCode: input.code,
      entityType: "entitlement",
      entityId: input.entitlementId,
      safeArgsJson: JSON.stringify({
        reason: input.safeReason,
        discordUserId: input.discordUserId,
      }),
      occurrenceCount: 1,
      firstSeenAtMs: input.createdAtMs,
      lastSeenAtMs: input.createdAtMs,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
    });
  }

  async enqueueNotification(notification: PaidRoleNotification): Promise<boolean> {
    const result = await run(
      this.database,
      `INSERT INTO commerce_delivery_outbox(id,operation_id,destination_type,destination_id,payload_json,status,attempt_count,available_at_ms,last_error_code,delivered_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?) ON CONFLICT(operation_id,destination_type,destination_id) DO NOTHING`,
      notification.id,
      notification.operationId,
      notification.destinationType,
      notification.destinationId,
      notification.payloadJson,
      notification.attemptCount,
      notification.availableAtMs,
      notification.lastErrorCode,
      notification.deliveredAtMs,
      notification.createdAtMs,
      notification.updatedAtMs,
    );
    return (result.meta?.changes ?? 0) > 0;
  }

  async notify(input: {
    kind:
      | "grace_started"
      | "grace_expired"
      | "suspended"
      | "restored"
      | "removed"
      | "repair_failed";
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    safeReason: string;
    operationKey: string;
  }): Promise<void> {
    const now = Date.now();
    const payloadJson = JSON.stringify({
      kind: input.kind,
      reason: input.safeReason,
      guildId: input.guildId,
      entitlementId: input.entitlementId,
    });
    for (const destination of [
      { type: "buyer_dm" as const, id: input.discordUserId },
      { type: "seller_audit" as const, id: input.guildId },
    ]) {
      await this.enqueueNotification({
        id: `notification:${input.operationKey}:${input.kind}:${destination.type}`,
        operationId: input.operationKey,
        destinationType: destination.type,
        destinationId: destination.id,
        payloadJson,
        status: "pending",
        attemptCount: 0,
        availableAtMs: now,
        lastErrorCode: null,
        deliveredAtMs: null,
        createdAtMs: now,
        updatedAtMs: now,
      });
    }
  }
}

export function createSqlitePaidRoleStore(database: D1Database): SqlitePaidRoleStore {
  return new SqlitePaidRoleStore(database);
}

async function first(
  database: D1Database,
  query: string,
  ...values: unknown[]
): Promise<Row | null> {
  return (
    (await database
      .prepare(query)
      .bind(...values)
      .first<Row>()) ?? null
  );
}
async function all(database: D1Database, query: string, ...values: unknown[]): Promise<Row[]> {
  return ((
    await database
      .prepare(query)
      .bind(...values)
      .all<Row>()
  ).results ?? []) as Row[];
}
async function run(database: D1Database, query: string, ...values: unknown[]) {
  return database
    .prepare(query)
    .bind(...values)
    .run();
}
function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}
function stateFromRow(row: Row): PaidRoleEntitlementState {
  return {
    entitlementId: String(row.entitlement_id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    discordUserId: String(row.discord_user_id),
    discordRoleId: String(row.discord_role_id),
    subscriptionId: nullable(row.subscription_id),
    subscriptionStatus: String(
      row.subscription_status,
    ) as PaidRoleEntitlementState["subscriptionStatus"],
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
    currentPeriodEndMs: numberOrNull(row.current_period_end_ms),
    paymentStatus: nullable(row.payment_status) as PaidRoleEntitlementState["paymentStatus"],
    amountMinor: numberOrNull(row.amount_minor),
    amountRefundedMinor: Number(row.amount_refunded_minor ?? 0),
    disputeStatus: nullable(row.dispute_status) as PaidRoleEntitlementState["disputeStatus"],
    failedPaymentAtMs: numberOrNull(row.failed_payment_at_ms),
    adminAction: nullable(row.admin_action) as PaidRoleEntitlementState["adminAction"],
    memberState: String(row.member_state) as PaidRoleEntitlementState["memberState"],
    updatedAtMs: Number(row.updated_at_ms),
  };
}
function assignmentFromRow(row: Row): PaidRoleManagedAssignment {
  return {
    id: String(row.id),
    entitlementId: String(row.entitlement_id),
    guildId: String(row.guild_id),
    discordUserId: String(row.discord_user_id),
    discordRoleId: String(row.discord_role_id),
    state:
      row.status === "assigned"
        ? "managed"
        : row.status === "withheld"
          ? "withheld"
          : row.status === "removed"
            ? "removed"
            : row.status === "pending"
              ? "pending"
              : row.status === "removing"
                ? "removing"
                : "failed",
    withheldReason: nullable(row.withheld_reason) as PaidRoleManagedAssignment["withheldReason"],
    providerCancellationState: String(
      row.provider_cancellation_state ?? "none",
    ) as PaidRoleManagedAssignment["providerCancellationState"],
    attemptCount: Number(row.attempt_count ?? 0),
    lastErrorCode: nullable(row.last_error_code),
    assignedAtMs: numberOrNull(row.assigned_at_ms),
    removedAtMs: numberOrNull(row.removed_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
function providerActionFromRow(row: Row): PaidRoleProviderAction {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    assignmentId: nullable(row.assignment_id),
    connectedAccountId: String(row.connected_account_id),
    subscriptionId: String(row.stripe_subscription_id),
    actionType: String(row.action_type) as PaidRoleProviderAction["actionType"],
    reasonCode: String(row.reason_code),
    status: String(row.status) as PaidRoleProviderAction["status"],
    attemptCount: Number(row.attempt_count),
    availableAtMs: Number(row.available_at_ms),
    claimedAtMs: numberOrNull(row.claimed_at_ms),
    leaseExpiresAtMs: numberOrNull(row.lease_expires_at_ms),
    completedAtMs: numberOrNull(row.completed_at_ms),
    lastErrorCode: nullable(row.last_error_code),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
function outboxFromRow(row: Row): PaidRoleOutboxMessage {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    entitlementId: String(row.entitlement_id),
    guildId: String(row.guild_id),
    discordUserId: String(row.discord_user_id),
    discordRoleId: String(row.discord_role_id),
    action: String(row.action) as PaidRoleOutboxMessage["action"],
    payloadJson: String(row.payload_json),
    status: String(row.status) as PaidRoleOutboxMessage["status"],
    availableAtMs: Number(row.available_at_ms),
    sentAtMs: numberOrNull(row.sent_at_ms),
    attemptCount: Number(row.attempt_count ?? 0),
    lastErrorCode: nullable(row.last_error_code),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
function repairFromRow(row: Row): PaidRoleRepairRecord {
  return {
    id: String(row.id),
    offeringId: String(row.offering_id),
    guildId: String(row.guild_id),
    oldRoleId: String(row.old_role_id),
    replacementRoleId: nullable(row.replacement_role_id),
    startedAtMs: Number(row.started_at_ms),
    deadlineAtMs: Number(row.deadline_at_ms),
    status: String(row.status) as PaidRoleRepairRecord["status"],
    repairedCount: Number(row.repaired_count ?? 0),
    lastErrorCode: nullable(row.last_error_code),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
