import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands, type PostgresCommand } from "./postgres-statements";
import type { CommerceFinancialOperationsProvider } from "../../commerce/financial-operations";

type Row = Record<string, unknown>;

export type CommerceFinancialProviderAction = {
  id: string;
  operationKey: string;
  parentActionId: string;
  workflowType:
    | "offering_retirement"
    | "seller_offboarding"
    | "renewal_shutdown"
    | "refund_followup";
  workflowId: string;
  connectedAccountId: string;
  stripeAccountId: string;
  guildId: string;
  offeringId: string | null;
  subscriptionId: string;
  stripeSubscriptionId: string;
  actionType: "subscription.cancel_at_period_end" | "subscription.cancel_immediately";
  reasonCode: string;
  status: "pending" | "processing" | "completed" | "failed" | "quarantined";
  attemptCount: number;
  providerCompletedAtMs: number | null;
};

export async function processCommerceFinancialProviderActions(options: {
  database: PostgresDatabaseCapability;
  provider: Pick<CommerceFinancialOperationsProvider, "cancelAtPeriodEnd" | "cancelImmediately">;
  requestReconciliation(input: {
    connectedAccountId: string;
    correlationId: string;
  }): Promise<void>;
  now?: () => number;
  createLeaseToken?: () => string;
  limit?: number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  await ensureRetirementChildren(options.database, nowMs);
  await ensureOffboardingChildren(options.database, nowMs);
  await ensureRenewalShutdownChildren(options.database, nowMs);
  await refreshWorkflowProgress(options.database, nowMs);
  const actions = await listDueActions(options.database, nowMs, options.limit ?? 100);
  let completed = 0;

  for (const action of actions) {
    const leaseToken = options.createLeaseToken?.() ?? crypto.randomUUID();
    if (!(await claimAction(options.database, action.id, leaseToken, now()))) continue;
    try {
      if (action.providerCompletedAtMs === null) {
        const operation =
          action.actionType === "subscription.cancel_immediately"
            ? options.provider.cancelImmediately.bind(options.provider)
            : options.provider.cancelAtPeriodEnd.bind(options.provider);
        await operation({
          connectedAccountId: action.stripeAccountId,
          stripeSubscriptionId: action.stripeSubscriptionId,
          idempotencyKey: `commerce:${action.actionType}:${action.subscriptionId}`,
        });
        if (!(await markProviderComplete(options.database, action.id, leaseToken, now()))) continue;
      }
      await options.requestReconciliation({
        connectedAccountId: action.connectedAccountId,
        correlationId: action.operationKey,
      });
      if (await completeAction(options.database, action.id, leaseToken, now())) completed += 1;
    } catch (error) {
      await failAction(options.database, action, leaseToken, safeErrorCode(error), now());
    }
  }

  await refreshWorkflowProgress(options.database, now());
  return completed;
}

async function ensureRetirementChildren(
  database: PostgresDatabaseCapability,
  nowMs: number,
): Promise<void> {
  await database.queryResult(
    `INSERT INTO commerce_financial_provider_actions(
         id, operation_key, parent_action_id, workflow_type, workflow_id,
         connected_account_id, guild_id, offering_id, subscription_id,
         stripe_subscription_id, action_type, reason_code, status, attempt_count,
         available_at_ms, lease_token, claimed_at_ms, lease_expires_at_ms,
         provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms,
         last_error_code, created_at_ms, updated_at_ms
       )
       SELECT 'commerce:offering-retirement:' || r.offering_id || ':' || s.id,
              'commerce:offering-retirement:' || r.offering_id || ':' || s.id,
              r.id, 'offering_retirement', r.offering_id, s.connected_account_id,
              r.guild_id, r.offering_id, s.id, s.stripe_subscription_id,
              'subscription.cancel_at_period_end', r.reason_code,
              CASE WHEN s.cancel_at_period_end=1 THEN 'completed' ELSE 'pending' END, 0,
              $1, NULL, NULL, NULL,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($2 AS BIGINT) END,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($3 AS BIGINT) END,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($4 AS BIGINT) END,
              NULL, $5, $6
         FROM commerce_offering_retirements r
         JOIN commerce_offering_lifecycles l ON l.offering_id=r.offering_id
         JOIN commerce_subscriptions s ON s.offering_id=r.offering_id
        WHERE l.state IN ('retiring','archived')
          AND s.status NOT IN ('canceled','ended')
       ON CONFLICT(operation_key) DO NOTHING`,
    [nowMs, nowMs, nowMs, nowMs, nowMs, nowMs],
  );
}

async function ensureOffboardingChildren(
  database: PostgresDatabaseCapability,
  nowMs: number,
): Promise<void> {
  await database.queryResult(
    `INSERT INTO commerce_financial_provider_actions(
         id, operation_key, parent_action_id, workflow_type, workflow_id,
         connected_account_id, guild_id, offering_id, subscription_id,
         stripe_subscription_id, action_type, reason_code, status, attempt_count,
         available_at_ms, lease_token, claimed_at_ms, lease_expires_at_ms,
         provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms,
         last_error_code, created_at_ms, updated_at_ms
       )
       SELECT 'commerce:seller_offboarding:' || o.connected_account_id || ':' || s.id,
              'commerce:seller_offboarding:' || o.connected_account_id || ':' || s.id,
              p.id, 'seller_offboarding', o.connected_account_id, o.connected_account_id,
              o.guild_id, s.offering_id, s.id, s.stripe_subscription_id,
              'subscription.cancel_at_period_end', o.reason_code,
              CASE WHEN s.cancel_at_period_end=1 THEN 'completed' ELSE 'pending' END, 0,
              $1, NULL, NULL, NULL,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($2 AS BIGINT) END,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($3 AS BIGINT) END,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($4 AS BIGINT) END,
              NULL, $5, $6
         FROM commerce_seller_offboarding o
         JOIN commerce_subscriptions s ON s.connected_account_id=o.connected_account_id
         JOIN commerce_financial_actions p ON p.id=(
           SELECT a.id FROM commerce_financial_actions a
            WHERE a.connected_account_id=o.connected_account_id
              AND a.action_type='seller.offboarding_started'
            ORDER BY a.created_at_ms LIMIT 1
         )
        WHERE o.status IN ('canceling','waiting','ready','completed')
          AND s.status NOT IN ('canceled','ended')
       ON CONFLICT(operation_key) DO NOTHING`,
    [nowMs, nowMs, nowMs, nowMs, nowMs, nowMs],
  );
}

async function ensureRenewalShutdownChildren(
  database: PostgresDatabaseCapability,
  nowMs: number,
): Promise<void> {
  await database.queryResult(
    `INSERT INTO commerce_financial_provider_actions(
         id, operation_key, parent_action_id, workflow_type, workflow_id,
         connected_account_id, guild_id, offering_id, subscription_id,
         stripe_subscription_id, action_type, reason_code, status, attempt_count,
         available_at_ms, lease_token, claimed_at_ms, lease_expires_at_ms,
         provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms,
         last_error_code, created_at_ms, updated_at_ms
       )
       SELECT 'commerce:renewal_shutdown:' || s.connected_account_id || ':' || s.id,
              'commerce:renewal_shutdown:' || s.connected_account_id || ':' || s.id,
              'control:' || c.id, 'renewal_shutdown', s.connected_account_id,
              s.connected_account_id, a.guild_id, s.offering_id, s.id,
              s.stripe_subscription_id, 'subscription.cancel_at_period_end',
              COALESCE(c.reason_code, 'renewal_shutdown'),
              CASE WHEN s.cancel_at_period_end=1 THEN 'completed' ELSE 'pending' END, 0,
              $1, NULL, NULL, NULL,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($2 AS BIGINT) END,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($3 AS BIGINT) END,
              CASE WHEN s.cancel_at_period_end=1 THEN CAST($4 AS BIGINT) END,
              NULL, $5, $6
         FROM commerce_connected_accounts a
         JOIN commerce_subscriptions s ON s.connected_account_id=a.id
         JOIN commerce_operational_controls c ON
              (c.scope_type='global' AND c.scope_id='commerce') OR
              (c.scope_type='guild' AND c.scope_id=a.guild_id) OR
              (c.scope_type='seller' AND c.scope_id=a.id) OR
              (c.scope_type='offering' AND c.scope_id=s.offering_id)
        WHERE c.enabled=1 AND c.control_type IN ('renewal_shutdown','commerce_kill')
          AND (c.expires_at_ms IS NULL OR c.expires_at_ms>$7)
          AND s.status NOT IN ('canceled','ended')
       ON CONFLICT(operation_key) DO NOTHING`,
    [nowMs, nowMs, nowMs, nowMs, nowMs, nowMs, nowMs],
  );
}

async function listDueActions(
  database: PostgresDatabaseCapability,
  nowMs: number,
  limit: number,
): Promise<CommerceFinancialProviderAction[]> {
  const result = await database.queryResult<Row>(
    `SELECT a.*, c.stripe_account_id
         FROM commerce_financial_provider_actions a
         JOIN commerce_connected_accounts c ON c.id=a.connected_account_id
        WHERE a.available_at_ms <= $1
          AND (a.status IN ('pending','failed') OR
               (a.status='processing' AND
                (a.lease_expires_at_ms IS NULL OR a.lease_expires_at_ms <= $2)))
        ORDER BY a.available_at_ms, a.created_at_ms LIMIT $3`,
    [nowMs, nowMs, limit],
  );
  return result.rows.map(actionFromRow);
}

async function claimAction(
  database: PostgresDatabaseCapability,
  actionId: string,
  leaseToken: string,
  nowMs: number,
): Promise<boolean> {
  const result = await database.queryResult(
    `UPDATE commerce_financial_provider_actions
          SET status='processing', attempt_count=attempt_count+1, lease_token=$1,
              claimed_at_ms=$2, lease_expires_at_ms=$3, last_error_code=NULL, updated_at_ms=$4
        WHERE id=$5 AND (status IN ('pending','failed') OR
          (status='processing' AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= $6)))`,
    [leaseToken, nowMs, nowMs + 60_000, nowMs, actionId, nowMs],
  );
  return Number(result.rowCount ?? 0) === 1;
}

async function markProviderComplete(
  database: PostgresDatabaseCapability,
  actionId: string,
  leaseToken: string,
  nowMs: number,
): Promise<boolean> {
  const result = await database.queryResult(
    `UPDATE commerce_financial_provider_actions
          SET provider_completed_at_ms=COALESCE(provider_completed_at_ms, $1), updated_at_ms=$2
        WHERE id=$3 AND status='processing' AND lease_token=$4 AND lease_expires_at_ms>$5`,
    [nowMs, nowMs, actionId, leaseToken, nowMs],
  );
  return Number(result.rowCount ?? 0) === 1;
}

async function completeAction(
  database: PostgresDatabaseCapability,
  actionId: string,
  leaseToken: string,
  nowMs: number,
): Promise<boolean> {
  const result = await database.queryResult(
    `UPDATE commerce_financial_provider_actions
          SET status='completed', reconciliation_requested_at_ms=$1, completed_at_ms=$2,
              lease_expires_at_ms=$3, last_error_code=NULL, updated_at_ms=$4
        WHERE id=$5 AND status='processing' AND lease_token=$6 AND lease_expires_at_ms>$7
          AND provider_completed_at_ms IS NOT NULL`,
    [nowMs, nowMs, nowMs, nowMs, actionId, leaseToken, nowMs],
  );
  return Number(result.rowCount ?? 0) === 1;
}

async function failAction(
  database: PostgresDatabaseCapability,
  action: CommerceFinancialProviderAction,
  leaseToken: string,
  errorCode: string,
  nowMs: number,
): Promise<void> {
  const terminal = action.attemptCount + 1 >= 5;
  const retryAtMs = nowMs + Math.min(60 * 60_000, (action.attemptCount + 1) * 60_000);
  const statements: PostgresCommand[] = [
    {
      statement: `UPDATE commerce_financial_provider_actions
            SET status=$1, available_at_ms=$2, lease_expires_at_ms=NULL,
                last_error_code=$3, updated_at_ms=$4
          WHERE id=$5 AND status='processing' AND lease_token=$6 AND lease_expires_at_ms>$7`,
      values: [
        terminal ? "quarantined" : "failed",
        retryAtMs,
        errorCode,
        nowMs,
        action.id,
        leaseToken,
        nowMs,
      ],
    },
  ];
  if (terminal) {
    const incidentId = `commerce-provider-action:${action.id}`;
    statements.push({
      statement: `INSERT INTO commerce_incidents(
             id,connected_account_id,guild_id,incident_key,severity,status,summary_code,
             entity_type,entity_id,safe_args_json,occurrence_count,first_seen_at_ms,
             last_seen_at_ms,resolved_at_ms,created_at_ms,updated_at_ms
           )
           SELECT $1, connected_account_id, guild_id, $2, 'critical', 'open',
                  'commerce_provider_action_quarantined', 'subscription', subscription_id,
                  '{}', 1, $3, $4, NULL, $5, $6
             FROM commerce_financial_provider_actions
            WHERE id=$7 AND status='quarantined' AND lease_token=$8
           ON CONFLICT(guild_id,incident_key) DO UPDATE SET status='open',
             occurrence_count=occurrence_count+1,last_seen_at_ms=excluded.last_seen_at_ms,
             updated_at_ms=excluded.updated_at_ms`,
      values: [incidentId, incidentId, nowMs, nowMs, nowMs, nowMs, action.id, leaseToken],
    });
  }
  await executePostgresCommands(database, statements);
}

async function refreshWorkflowProgress(
  database: PostgresDatabaseCapability,
  nowMs: number,
): Promise<void> {
  const statements = [
    {
      statement: `UPDATE commerce_offering_retirements AS r
            SET active_subscription_count=(
                  SELECT COUNT(*) FROM commerce_subscriptions s
                   WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')
                ),
                scheduled_cancellation_count=(
                  SELECT COUNT(*) FROM commerce_financial_provider_actions a
                   WHERE a.workflow_type='offering_retirement' AND a.workflow_id=r.offering_id
                     AND a.status='completed'
                ),
                failed_cancellation_count=(
                  SELECT COUNT(*) FROM commerce_financial_provider_actions a
                   WHERE a.workflow_type='offering_retirement' AND a.workflow_id=r.offering_id
                     AND a.status IN ('failed','quarantined')
                ),
                latest_period_end_ms=(
                  SELECT MAX(s.current_period_end_ms) FROM commerce_subscriptions s
                   WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')
                ),
                status=CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM commerce_subscriptions s
                     WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')
                  ) THEN 'complete'
                  WHEN EXISTS (
                    SELECT 1 FROM commerce_financial_provider_actions a
                     WHERE a.workflow_type='offering_retirement' AND a.workflow_id=r.offering_id
                       AND a.status IN ('failed','quarantined')
                  ) THEN 'failed'
                  WHEN NOT EXISTS (
                    SELECT 1 FROM commerce_financial_provider_actions a
                     WHERE a.workflow_type='offering_retirement' AND a.workflow_id=r.offering_id
                       AND a.status <> 'completed'
                  ) THEN 'waiting_for_period_end'
                  ELSE 'scheduling_cancellations'
                END,
                last_error_code=(
                  SELECT a.last_error_code FROM commerce_financial_provider_actions a
                   WHERE a.workflow_type='offering_retirement' AND a.workflow_id=r.offering_id
                     AND a.status IN ('failed','quarantined')
                   ORDER BY a.updated_at_ms DESC LIMIT 1
                ),
                completed_at_ms=CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM commerce_subscriptions s
                     WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')
                  ) THEN COALESCE(r.completed_at_ms, $1)
                  ELSE NULL
                END,
                updated_at_ms=$2
          WHERE EXISTS (
            SELECT 1 FROM commerce_offering_lifecycles l
             WHERE l.offering_id=r.offering_id AND l.state IN ('retiring','archived')
          )`,
      values: [nowMs, nowMs],
    },
    {
      statement: `UPDATE commerce_seller_offboarding AS o
            SET active_subscription_count=(
                  SELECT COUNT(*) FROM commerce_subscriptions s
                   WHERE s.connected_account_id=o.connected_account_id
                     AND s.status NOT IN ('canceled','ended')
                ),
                latest_paid_through_at_ms=(
                  SELECT MAX(s.current_period_end_ms) FROM commerce_subscriptions s
                   WHERE s.connected_account_id=o.connected_account_id
                     AND s.status NOT IN ('canceled','ended')
                ),
                status=CASE WHEN NOT EXISTS (
                  SELECT 1 FROM commerce_subscriptions s
                   WHERE s.connected_account_id=o.connected_account_id
                     AND s.status NOT IN ('canceled','ended')
                ) THEN CASE WHEN o.status='completed' THEN 'completed' ELSE 'ready' END
                  ELSE 'waiting' END,
                updated_at_ms=$1
          WHERE o.status IN ('canceling','waiting','ready','completed')`,
      values: [nowMs],
    },
  ];

  await executePostgresCommands(database, statements);
}

function actionFromRow(row: Row): CommerceFinancialProviderAction {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    parentActionId: String(row.parent_action_id),
    workflowType: String(row.workflow_type) as CommerceFinancialProviderAction["workflowType"],
    workflowId: String(row.workflow_id),
    connectedAccountId: String(row.connected_account_id),
    stripeAccountId: String(row.stripe_account_id),
    guildId: String(row.guild_id),
    offeringId: row.offering_id == null ? null : String(row.offering_id),
    subscriptionId: String(row.subscription_id),
    stripeSubscriptionId: String(row.stripe_subscription_id),
    actionType: String(row.action_type) as CommerceFinancialProviderAction["actionType"],
    reasonCode: String(row.reason_code),
    status: String(row.status) as CommerceFinancialProviderAction["status"],
    attemptCount: Number(row.attempt_count),
    providerCompletedAtMs:
      row.provider_completed_at_ms == null ? null : Number(row.provider_completed_at_ms),
  };
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]{1,100}$/i.test(error.message)
    ? error.message.toLowerCase()
    : "commerce_provider_action_failed";
}
