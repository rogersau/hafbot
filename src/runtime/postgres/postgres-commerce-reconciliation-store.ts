import type { PostgresDatabaseCapability, PostgresValue } from "./postgres-capability";
import { executePostgresCommands, type PostgresCommand } from "./postgres-statements";
import type { CommerceSellerSnapshot } from "../commerce/reconciliation";
import type {
  CommerceReconciliationMessage,
  CommerceReconciliationSource,
  CommerceReconciliationStore,
  CommerceReconciliationTrigger,
} from "../commerce/reconciliation";

export type AcceptedCommerceWebhook = {
  eventId: string;
  eventType: string;
  objectId: string | null;
  connectedAccountId: string;
  providerCreatedAtMs: number;
  payloadHash: string;
  apiVersion?: string | null;
};

export class PostgresCommerceReconciliationStore implements CommerceReconciliationStore {
  constructor(
    private readonly database: PostgresDatabaseCapability,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async accept(event: AcceptedCommerceWebhook): Promise<{
    accepted: boolean;
    outboxPending: boolean;
    generation: number;
  }> {
    const receivedAtMs = this.now();
    const eventRowId = eventKey(event.connectedAccountId, event.eventId);
    const syncId = syncStateId(event.connectedAccountId);
    const outboxId = outboxKey(event.connectedAccountId, event.eventId);
    const existing = await this.readWebhookGeneration(event.connectedAccountId, event.eventId);
    if (
      !event.eventType.startsWith("commerce.refresh.") &&
      (await this.webhookQuarantineEnabled(event.connectedAccountId, receivedAtMs))
    ) {
      await this.quarantineAcceptedWebhook(event, eventRowId, receivedAtMs);
      return { accepted: existing === null, outboxPending: false, generation: 0 };
    }

    await executePostgresCommands(this.database, [
      {
        statement: `INSERT INTO commerce_webhook_events(
             id, connected_account_id, stripe_event_id, event_type, object_id, payload_hash,
             generation, api_version, provider_created_at_ms, received_at_ms, status,
             attempt_count, last_error_code, processed_at_ms, updated_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, 'pending', 0, NULL, NULL, $10)
           ON CONFLICT(connected_account_id, stripe_event_id) DO NOTHING`,
        values: [
          eventRowId,
          event.connectedAccountId,
          event.eventId,
          event.eventType,
          event.objectId,
          event.payloadHash,
          event.apiVersion ?? null,
          event.providerCreatedAtMs,
          receivedAtMs,
          receivedAtMs,
        ],
      },
      {
        statement: `INSERT INTO commerce_sync_state(
             id, connected_account_id, resource_type, resource_id, status,
             provider_updated_at_ms, provider_event_id, last_synced_at_ms, last_error_code,
             generation, applied_generation, lease_token, lease_expires_at_ms,
             created_at_ms, updated_at_ms
           )
           SELECT $1, $2, 'seller', $3, 'pending', NULL, $4, NULL, NULL,
                  1, 0, NULL, NULL, $5, $6
           FROM commerce_webhook_events
           WHERE connected_account_id = $7 AND stripe_event_id = $8 AND generation = 0
           ON CONFLICT(connected_account_id, resource_type, resource_id) DO UPDATE SET
             status = 'pending',
             provider_event_id = excluded.provider_event_id,
             generation = commerce_sync_state.generation + 1,
             updated_at_ms = excluded.updated_at_ms`,
        values: [
          syncId,
          event.connectedAccountId,
          event.connectedAccountId,
          event.eventId,
          receivedAtMs,
          receivedAtMs,
          event.connectedAccountId,
          event.eventId,
        ],
      },
      {
        statement: `UPDATE commerce_webhook_events
           SET generation = (
             SELECT generation FROM commerce_sync_state
             WHERE connected_account_id = $1 AND resource_type = 'seller' AND resource_id = $2
           )
           WHERE connected_account_id = $3 AND stripe_event_id = $4 AND generation = 0`,
        values: [
          event.connectedAccountId,
          event.connectedAccountId,
          event.connectedAccountId,
          event.eventId,
        ],
      },
      {
        statement: `INSERT INTO commerce_sync_outbox(
             id, connected_account_id, event_id, resource_type, resource_id,
             generation, sent_at_ms, created_at_ms
           )
           SELECT $1, connected_account_id, stripe_event_id, 'seller', connected_account_id,
                  generation, NULL, $2
           FROM commerce_webhook_events
           WHERE connected_account_id = $3 AND stripe_event_id = $4 AND generation > 0
           ON CONFLICT(connected_account_id, event_id) DO NOTHING`,
        values: [outboxId, receivedAtMs, event.connectedAccountId, event.eventId],
      },
    ]);

    const row = await this.database
      .query<{ generation: number; sentAtMs: number | null }>(
        `SELECT e.generation, o.sent_at_ms AS "sentAtMs"
         FROM commerce_webhook_events e
         LEFT JOIN commerce_sync_outbox o
           ON o.connected_account_id = e.connected_account_id AND o.event_id = e.stripe_event_id
         WHERE e.connected_account_id = $1 AND e.stripe_event_id = $2`,
        [event.connectedAccountId, event.eventId],
      )
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("commerce_webhook_accept_failed");
    return {
      accepted: existing === null,
      outboxPending: row.sentAtMs === null,
      generation: row.generation,
    };
  }

  async claim(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<"claimed" | "stale" | "leased" | "complete" | "missing"> {
    await this.database.queryResult(
      `UPDATE commerce_sync_state
         SET lease_token = $1, lease_expires_at_ms = $2, status = 'pending', updated_at_ms = $3
         WHERE connected_account_id = $4 AND resource_type = $5 AND resource_id = $6
           AND generation = $7 AND applied_generation < $8
           AND (lease_token IS NULL OR lease_expires_at_ms IS NULL OR lease_expires_at_ms <= $9)`,
      [
        input.leaseToken,
        input.nowMs + input.leaseMs,
        input.nowMs,
        input.message.connectedAccountId,
        input.message.resourceType,
        input.message.resourceId,
        input.message.generation,
        input.message.generation,
        input.nowMs,
      ],
    );
    const row = await this.readSyncState(input.message);
    if (!row) return "missing";
    if (row.appliedGeneration >= input.message.generation) return "complete";
    if (row.generation > input.message.generation) return "stale";
    return row.leaseToken === input.leaseToken ? "claimed" : "leased";
  }

  async readTrigger(
    message: CommerceReconciliationMessage,
  ): Promise<CommerceReconciliationTrigger | null> {
    const row = await this.database
      .query<{ eventType: string; objectId: string | null }>(
        `SELECT event_type AS "eventType", object_id AS "objectId"
         FROM commerce_webhook_events
         WHERE connected_account_id = $1 AND stripe_event_id = $2 AND generation = $3`,
        [message.connectedAccountId, message.eventId, message.generation],
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      eventType: row.eventType,
      objectId: row.objectId,
      source: sourceFromEventType(row.eventType),
    };
  }

  async commit(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string;
    snapshot: CommerceSellerSnapshot;
    nowMs: number;
  }): Promise<boolean> {
    const guard = {
      connectedAccountId: input.message.connectedAccountId,
      resourceType: input.message.resourceType,
      resourceId: input.message.resourceId,
      generation: input.message.generation,
      leaseToken: input.leaseToken,
    };
    const statements: PostgresCommand[] = [
      ...(input.snapshot.expiredCheckoutIds ?? []).map((id) => ({
        statement: `UPDATE commerce_checkout_attempts SET provider_terminal_at_ms=$1,status='expired',updated_at_ms=$2 WHERE id=$3 AND connected_account_id=$4
         AND EXISTS(SELECT 1 FROM commerce_sync_state WHERE connected_account_id=$5 AND resource_type=$6 AND resource_id=$7 AND generation=$8 AND lease_token=$9)`,
        values: [
          input.nowMs,
          input.nowMs,
          id,
          guard.connectedAccountId,
          guard.connectedAccountId,
          guard.resourceType,
          guard.resourceId,
          guard.generation,
          guard.leaseToken,
        ],
      })),
      {
        statement: `UPDATE commerce_game_assignments SET revision=revision+1,generation=generation+1,next_at_ms=$1
        WHERE id IN (SELECT gs.assignment_id FROM commerce_game_selections gs
          JOIN commerce_offerings o ON o.id=gs.offering_id WHERE o.connected_account_id=$2)
        AND EXISTS(SELECT 1 FROM commerce_sync_state WHERE connected_account_id=$3 AND resource_type=$4 AND resource_id=$5 AND generation=$6 AND lease_token=$7)`,
        values: [
          input.nowMs,
          guard.connectedAccountId,
          guard.connectedAccountId,
          guard.resourceType,
          guard.resourceId,
          guard.generation,
          guard.leaseToken,
        ],
      },
      guardedUpsert(
        "commerce_connected_accounts",
        [
          "id",
          "guild_id",
          "stripe_account_id",
          "status",
          "country",
          "default_currency",
          "charges_enabled",
          "payouts_enabled",
          "details_submitted",
          "provider_created_at_ms",
          "archived_at_ms",
          "created_at_ms",
          "updated_at_ms",
        ],
        accountValues(input.snapshot.connectedAccount),
        guard,
      ),
      ...input.snapshot.buyers.map((row) =>
        guardedUpsert(
          "commerce_buyers",
          ["id", "discord_user_id", "created_at_ms", "updated_at_ms"],
          [row.id, row.discordUserId, row.createdAtMs, row.updatedAtMs],
          guard,
        ),
      ),
      ...input.snapshot.customers.map((row) =>
        guardedUpsert(
          "commerce_customers",
          [
            "id",
            "connected_account_id",
            "buyer_id",
            "stripe_customer_id",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.buyerId,
            row.stripeCustomerId,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.subscriptions.map((row) =>
        guardedUpsert(
          "commerce_subscriptions",
          [
            "checkout_attempt_id",
            "id",
            "connected_account_id",
            "customer_id",
            "buyer_id",
            "offering_id",
            "price_id",
            "stripe_subscription_id",
            "status",
            "cancel_at_period_end",
            "current_period_start_ms",
            "current_period_end_ms",
            "canceled_at_ms",
            "ended_at_ms",
            "provider_updated_at_ms",
            "latest_invoice_id",
            "latest_invoice_status",
            "latest_payment_intent_id",
            "latest_payment_status",
            "grace_started_at_ms",
            "grace_ends_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.checkoutAttemptId ?? null,
            row.id,
            row.connectedAccountId,
            row.customerId,
            row.buyerId,
            row.offeringId,
            row.priceId,
            row.stripeSubscriptionId,
            row.status,
            booleanInt(row.cancelAtPeriodEnd),
            row.currentPeriodStartMs,
            row.currentPeriodEndMs,
            row.canceledAtMs,
            row.endedAtMs,
            row.providerUpdatedAtMs,
            row.latestInvoiceId,
            row.latestInvoiceStatus,
            row.latestPaymentIntentId,
            row.latestPaymentStatus,
            row.graceStartedAtMs,
            row.graceEndsAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.payments.map((row) =>
        guardedUpsert(
          "commerce_payments",
          [
            "id",
            "connected_account_id",
            "customer_id",
            "buyer_id",
            "offering_id",
            "price_id",
            "stripe_payment_intent_id",
            "stripe_charge_id",
            "stripe_checkout_session_id",
            "stripe_invoice_id",
            "stripe_subscription_id",
            "invoice_period_start_ms",
            "invoice_period_end_ms",
            "is_latest_subscription_invoice",
            "currency",
            "amount_minor",
            "amount_received_minor",
            "amount_refunded_minor",
            "application_fee_minor",
            "stripe_fee_minor",
            "stripe_fee_tax_minor",
            "status",
            "provider_created_at_ms",
            "paid_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.customerId,
            row.buyerId,
            row.offeringId,
            row.priceId,
            row.stripePaymentIntentId,
            row.stripeChargeId,
            row.stripeCheckoutSessionId,
            row.stripeInvoiceId,
            row.stripeSubscriptionId,
            row.billingPeriodStartMs,
            row.billingPeriodEndMs,
            booleanInt(row.isLatestSubscriptionInvoice),
            row.currency,
            row.amountMinor,
            row.amountReceivedMinor,
            row.amountRefundedMinor,
            row.applicationFeeMinor,
            row.stripeFeeMinor,
            row.stripeFeeTaxMinor,
            row.status,
            row.providerCreatedAtMs,
            row.paidAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.payments
        .filter((row) => row.status === "succeeded")
        .map((row) =>
          reportingLedgerInsert(
            {
              id: this.createId(),
              connectedAccountId: row.connectedAccountId,
              guildId: input.snapshot.connectedAccount.guildId,
              sellerCountry: input.snapshot.connectedAccount.country,
              buyerId: row.buyerId,
              transactionType: "membership_payment",
              sourceRecordId: row.id,
              providerTransactionId: row.stripePaymentIntentId,
              providerStatus: row.status,
              currency: row.currency,
              grossAmountMinor: row.amountMinor,
              applicationFeeMinor: row.applicationFeeMinor,
              stripeFeeMinor: row.stripeFeeMinor,
              stripeFeeTaxMinor: row.stripeFeeTaxMinor,
              occurredAtMs: row.paidAtMs ?? row.providerCreatedAtMs ?? row.createdAtMs,
              correctionOfTransactionType: null,
              correctionOfSourceRecordId: null,
              recordedAtMs: input.nowMs,
            },
            guard,
          ),
        ),
      ...input.snapshot.refunds.map((row) =>
        guardedUpsert(
          "commerce_refunds",
          [
            "id",
            "connected_account_id",
            "payment_id",
            "stripe_refund_id",
            "currency",
            "amount_minor",
            "application_fee_refunded_minor",
            "status",
            "reason",
            "provider_created_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.paymentId,
            row.stripeRefundId,
            row.currency,
            row.amountMinor,
            row.applicationFeeRefundedMinor,
            row.status,
            row.reason,
            row.providerCreatedAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.refunds
        .filter((row) => row.status === "succeeded")
        .map((row) => {
          const payment = input.snapshot.payments.find(
            (candidate) => candidate.id === row.paymentId,
          );
          return reportingLedgerInsert(
            {
              id: this.createId(),
              connectedAccountId: row.connectedAccountId,
              guildId: input.snapshot.connectedAccount.guildId,
              sellerCountry: input.snapshot.connectedAccount.country,
              buyerId: payment?.buyerId ?? null,
              transactionType: "membership_refund",
              sourceRecordId: row.id,
              providerTransactionId: row.stripeRefundId,
              providerStatus: row.status,
              currency: row.currency,
              grossAmountMinor: row.amountMinor,
              applicationFeeMinor: row.applicationFeeRefundedMinor,
              stripeFeeMinor: null,
              stripeFeeTaxMinor: null,
              occurredAtMs: row.providerCreatedAtMs ?? row.createdAtMs,
              correctionOfTransactionType: "membership_payment",
              correctionOfSourceRecordId: row.paymentId,
              recordedAtMs: input.nowMs,
            },
            guard,
          );
        }),
      ...(input.snapshot.supportPayments ?? []).map((row) =>
        guardedUpsert(
          "commerce_support_payments",
          [
            "id",
            "connected_account_id",
            "guild_id",
            "customer_id",
            "buyer_id",
            "checkout_attempt_id",
            "stripe_payment_intent_id",
            "stripe_charge_id",
            "stripe_checkout_session_id",
            "currency",
            "amount_minor",
            "amount_received_minor",
            "amount_refunded_minor",
            "application_fee_minor",
            "stripe_fee_minor",
            "stripe_fee_tax_minor",
            "status",
            "provider_created_at_ms",
            "paid_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.guildId,
            row.customerId,
            row.buyerId,
            row.checkoutAttemptId,
            row.stripePaymentIntentId,
            row.stripeChargeId,
            row.stripeCheckoutSessionId,
            row.currency,
            row.amountMinor,
            row.amountReceivedMinor,
            row.amountRefundedMinor,
            row.applicationFeeMinor,
            row.stripeFeeMinor,
            row.stripeFeeTaxMinor,
            row.status,
            row.providerCreatedAtMs,
            row.paidAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...(input.snapshot.supportPayments ?? [])
        .filter((row) => row.status === "succeeded")
        .map((row) =>
          reportingLedgerInsert(
            {
              id: this.createId(),
              connectedAccountId: row.connectedAccountId,
              guildId: row.guildId,
              sellerCountry: input.snapshot.connectedAccount.country,
              buyerId: row.buyerId,
              transactionType: "support_payment",
              sourceRecordId: row.id,
              providerTransactionId: row.stripePaymentIntentId,
              providerStatus: row.status,
              currency: row.currency,
              grossAmountMinor: row.amountMinor,
              applicationFeeMinor: row.applicationFeeMinor,
              stripeFeeMinor: row.stripeFeeMinor,
              stripeFeeTaxMinor: row.stripeFeeTaxMinor,
              occurredAtMs: row.paidAtMs ?? row.providerCreatedAtMs ?? row.createdAtMs,
              correctionOfTransactionType: null,
              correctionOfSourceRecordId: null,
              recordedAtMs: input.nowMs,
            },
            guard,
          ),
        ),
      ...(input.snapshot.supportRefunds ?? []).map((row) =>
        guardedUpsert(
          "commerce_support_refunds",
          [
            "id",
            "connected_account_id",
            "support_payment_id",
            "stripe_refund_id",
            "currency",
            "amount_minor",
            "application_fee_refunded_minor",
            "status",
            "reason",
            "provider_created_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.supportPaymentId,
            row.stripeRefundId,
            row.currency,
            row.amountMinor,
            row.applicationFeeRefundedMinor,
            row.status,
            row.reason,
            row.providerCreatedAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...(input.snapshot.supportRefunds ?? [])
        .filter((row) => row.status === "succeeded")
        .map((row) => {
          const payment = (input.snapshot.supportPayments ?? []).find(
            (candidate) => candidate.id === row.supportPaymentId,
          );
          return reportingLedgerInsert(
            {
              id: this.createId(),
              connectedAccountId: row.connectedAccountId,
              guildId: input.snapshot.connectedAccount.guildId,
              sellerCountry: input.snapshot.connectedAccount.country,
              buyerId: payment?.buyerId ?? null,
              transactionType: "support_refund",
              sourceRecordId: row.id,
              providerTransactionId: row.stripeRefundId,
              providerStatus: row.status,
              currency: row.currency,
              grossAmountMinor: row.amountMinor,
              applicationFeeMinor: row.applicationFeeRefundedMinor,
              stripeFeeMinor: null,
              stripeFeeTaxMinor: null,
              occurredAtMs: row.providerCreatedAtMs ?? row.createdAtMs,
              correctionOfTransactionType: "support_payment",
              correctionOfSourceRecordId: row.supportPaymentId,
              recordedAtMs: input.nowMs,
            },
            guard,
          );
        }),
      ...(input.snapshot.supportDisputes ?? []).map((row) =>
        guardedUpsert(
          "commerce_support_disputes",
          [
            "id",
            "connected_account_id",
            "support_payment_id",
            "stripe_dispute_id",
            "currency",
            "amount_minor",
            "status",
            "reason",
            "provider_created_at_ms",
            "closed_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.supportPaymentId,
            row.stripeDisputeId,
            row.currency,
            row.amountMinor,
            row.status,
            row.reason,
            row.providerCreatedAtMs,
            row.closedAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...(input.snapshot.supportDisputes ?? []).map((row) => {
        const payment = (input.snapshot.supportPayments ?? []).find(
          (candidate) => candidate.id === row.supportPaymentId,
        );
        return reportingLedgerInsert(
          {
            id: this.createId(),
            connectedAccountId: row.connectedAccountId,
            guildId: input.snapshot.connectedAccount.guildId,
            sellerCountry: input.snapshot.connectedAccount.country,
            buyerId: payment?.buyerId ?? null,
            transactionType: "support_dispute",
            sourceRecordId: row.id,
            providerTransactionId: row.stripeDisputeId,
            providerStatus: row.status,
            currency: row.currency,
            grossAmountMinor: row.amountMinor,
            applicationFeeMinor: null,
            stripeFeeMinor: null,
            stripeFeeTaxMinor: null,
            occurredAtMs: row.providerCreatedAtMs ?? row.createdAtMs,
            correctionOfTransactionType: "support_payment",
            correctionOfSourceRecordId: row.supportPaymentId,
            recordedAtMs: input.nowMs,
          },
          guard,
        );
      }),
      ...(input.snapshot.supportDisputes ?? [])
        .filter((row) =>
          [
            "warning_needs_response",
            "warning_under_review",
            "needs_response",
            "under_review",
          ].includes(row.status),
        )
        .map((row) => {
          const operationId = `support-dispute:${row.id}:${row.status}`;
          return {
            statement: `INSERT INTO commerce_delivery_outbox
               (id, operation_id, destination_type, destination_id, payload_json, status,
                attempt_count, available_at_ms, last_error_code, delivered_at_ms,
                created_at_ms, updated_at_ms)
               VALUES ($1, $2, 'seller_audit', $3, $4, 'pending', 0, $5, NULL, NULL, $6, $7) ON CONFLICT DO NOTHING`,
            values: [
              `notification:${operationId}:seller_audit`,
              operationId,
              input.snapshot.connectedAccount.guildId,
              JSON.stringify({
                kind: "support_dispute_open",
                disputeId: row.id,
                amountMinor: row.amountMinor,
                currency: row.currency,
                evidenceAuthority: "stripe",
              }),
              input.nowMs,
              input.nowMs,
              input.nowMs,
            ],
          };
        }),
      ...input.snapshot.disputes.map((row) =>
        guardedUpsert(
          "commerce_disputes",
          [
            "id",
            "connected_account_id",
            "payment_id",
            "stripe_dispute_id",
            "currency",
            "amount_minor",
            "status",
            "reason",
            "provider_created_at_ms",
            "closed_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.paymentId,
            row.stripeDisputeId,
            row.currency,
            row.amountMinor,
            row.status,
            row.reason,
            row.providerCreatedAtMs,
            row.closedAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.disputes.map((row) => {
        const payment = input.snapshot.payments.find((candidate) => candidate.id === row.paymentId);
        return reportingLedgerInsert(
          {
            id: this.createId(),
            connectedAccountId: row.connectedAccountId,
            guildId: input.snapshot.connectedAccount.guildId,
            sellerCountry: input.snapshot.connectedAccount.country,
            buyerId: payment?.buyerId ?? null,
            transactionType: "membership_dispute",
            sourceRecordId: row.id,
            providerTransactionId: row.stripeDisputeId,
            providerStatus: row.status,
            currency: row.currency,
            grossAmountMinor: row.amountMinor,
            applicationFeeMinor: null,
            stripeFeeMinor: null,
            stripeFeeTaxMinor: null,
            occurredAtMs: row.providerCreatedAtMs ?? row.createdAtMs,
            correctionOfTransactionType: "membership_payment",
            correctionOfSourceRecordId: row.paymentId,
            recordedAtMs: input.nowMs,
          },
          guard,
        );
      }),
      ...input.snapshot.entitlements.map((row) =>
        guardedUpsert(
          "commerce_entitlements",
          [
            "id",
            "connected_account_id",
            "buyer_id",
            "offering_id",
            "source_type",
            "source_id",
            "status",
            "effective_at_ms",
            "expires_at_ms",
            "revoked_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.connectedAccountId,
            row.buyerId,
            row.offeringId,
            row.sourceType,
            row.sourceId,
            row.status,
            row.effectiveAtMs,
            row.expiresAtMs,
            row.revokedAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.roleAssignments.map((row) =>
        guardedUpsert(
          "commerce_role_assignments",
          [
            "id",
            "entitlement_id",
            "guild_id",
            "discord_user_id",
            "discord_role_id",
            "status",
            "attempt_count",
            "last_error_code",
            "next_attempt_at_ms",
            "assigned_at_ms",
            "removed_at_ms",
            "created_at_ms",
            "updated_at_ms",
          ],
          [
            row.id,
            row.entitlementId,
            row.guildId,
            row.discordUserId,
            row.discordRoleId,
            row.status,
            row.attemptCount,
            row.lastErrorCode,
            row.nextAttemptAtMs,
            row.assignedAtMs,
            row.removedAtMs,
            row.createdAtMs,
            row.updatedAtMs,
          ],
          guard,
        ),
      ),
      ...input.snapshot.roleAssignments.map((row) => {
        const operationKey = `commerce-role:${row.id}:${input.message.generation}:${row.status}`;
        const action = row.status === "removing" || row.status === "removed" ? "remove" : "assign";
        return {
          statement: `INSERT INTO commerce_paid_role_outbox(
               id, operation_key, entitlement_id, guild_id, discord_user_id, discord_role_id,
               action, payload_json, status, available_at_ms, sent_at_ms, attempt_count,
               last_error_code, created_at_ms, updated_at_ms
             )
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NULL, 0, NULL, $10, $11
             WHERE EXISTS (
               SELECT 1 FROM commerce_sync_state
               WHERE connected_account_id = $12 AND resource_type = $13 AND resource_id = $14
                 AND generation = $15 AND lease_token = $16
             )
             ON CONFLICT(operation_key) DO NOTHING`,
          values: [
            this.createId(),
            operationKey,
            row.entitlementId,
            row.guildId,
            row.discordUserId,
            row.discordRoleId,
            action,
            JSON.stringify({ generation: input.message.generation }),
            input.nowMs,
            input.nowMs,
            input.nowMs,
            input.message.connectedAccountId,
            input.message.resourceType,
            input.message.resourceId,
            input.message.generation,
            input.leaseToken,
          ],
        };
      }),
      {
        statement: `UPDATE commerce_sync_state
           SET status = 'synced', applied_generation = $1, provider_updated_at_ms = $2,
               last_synced_at_ms = $3, last_error_code = NULL,
               lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = $4
           WHERE connected_account_id = $5 AND resource_type = $6 AND resource_id = $7
             AND generation = $8 AND lease_token = $9`,
        values: [
          input.message.generation,
          input.snapshot.observedAtMs,
          input.nowMs,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.resourceType,
          input.message.resourceId,
          input.message.generation,
          input.leaseToken,
        ],
      },
      {
        statement: `UPDATE commerce_webhook_events
           SET status = 'processed', processed_at_ms = $1, updated_at_ms = $2
           WHERE connected_account_id = $3 AND stripe_event_id = $4 AND generation = $5
             AND EXISTS (
               SELECT 1 FROM commerce_sync_state
               WHERE connected_account_id = $6 AND resource_type = $7 AND resource_id = $8
                 AND applied_generation >= $9
             )`,
        values: [
          input.nowMs,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.eventId,
          input.message.generation,
          input.message.connectedAccountId,
          input.message.resourceType,
          input.message.resourceId,
          input.message.generation,
        ],
      },
    ];
    await executePostgresCommands(this.database, statements);
    const state = await this.readSyncState(input.message);
    return Boolean(state && state.appliedGeneration >= input.message.generation);
  }

  async fail(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string;
    reasonCode: string;
    nowMs: number;
  }): Promise<void> {
    await executePostgresCommands(this.database, [
      {
        statement: `UPDATE commerce_sync_state
           SET status = 'failed', last_error_code = $1, lease_token = NULL,
               lease_expires_at_ms = NULL, updated_at_ms = $2
           WHERE connected_account_id = $3 AND resource_type = $4 AND resource_id = $5
             AND generation = $6 AND lease_token = $7`,
        values: [
          input.reasonCode,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.resourceType,
          input.message.resourceId,
          input.message.generation,
          input.leaseToken,
        ],
      },
      {
        statement: `UPDATE commerce_webhook_events
           SET status = 'failed', attempt_count = attempt_count + 1,
               last_error_code = $1, updated_at_ms = $2
           WHERE connected_account_id = $3 AND stripe_event_id = $4 AND generation = $5`,
        values: [
          input.reasonCode,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.eventId,
          input.message.generation,
        ],
      },
    ]);
  }

  async quarantine(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string | null;
    reasonCode: string;
    nowMs: number;
  }): Promise<void> {
    const incidentId = this.createId();
    const incidentKey = `commerce-reconciliation:${input.message.connectedAccountId}:${input.reasonCode}`;
    await executePostgresCommands(this.database, [
      {
        statement: `UPDATE commerce_sync_state
           SET status = 'quarantined', last_error_code = $1, lease_token = NULL,
               lease_expires_at_ms = NULL, updated_at_ms = $2
           WHERE connected_account_id = $3 AND resource_type = $4 AND resource_id = $5
             AND generation = $6 AND (CAST($7 AS TEXT) IS NULL OR lease_token = $8)`,
        values: [
          input.reasonCode,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.resourceType,
          input.message.resourceId,
          input.message.generation,
          input.leaseToken,
          input.leaseToken,
        ],
      },
      {
        statement: `UPDATE commerce_webhook_events
           SET status = 'failed', attempt_count = attempt_count + 1,
               last_error_code = $1, processed_at_ms = $2, updated_at_ms = $3
           WHERE connected_account_id = $4 AND stripe_event_id = $5 AND generation = $6
             AND EXISTS (
               SELECT 1 FROM commerce_sync_state
               WHERE connected_account_id = $7 AND resource_type = $8 AND resource_id = $9
                 AND generation = $10 AND status = 'quarantined' AND last_error_code = $11
             )`,
        values: [
          input.reasonCode,
          input.nowMs,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.eventId,
          input.message.generation,
          input.message.connectedAccountId,
          input.message.resourceType,
          input.message.resourceId,
          input.message.generation,
          input.reasonCode,
        ],
      },
      {
        statement: `INSERT INTO commerce_incidents(
             id, connected_account_id, guild_id, incident_key, severity, status,
             summary_code, entity_type, entity_id, safe_args_json, occurrence_count,
             first_seen_at_ms, last_seen_at_ms, resolved_at_ms, created_at_ms, updated_at_ms
           )
           SELECT $1, a.id, a.guild_id, $2, 'error', 'open',
                  'commerce_reconciliation_quarantined', 'seller', a.id, $3, 1,
                  $4, $5, NULL, $6, $7
           FROM commerce_connected_accounts a
           WHERE a.id = $8
             AND EXISTS (
               SELECT 1 FROM commerce_sync_state
               WHERE connected_account_id = $9 AND resource_type = $10 AND resource_id = $11
                 AND generation = $12 AND status = 'quarantined' AND last_error_code = $13
             )
           ON CONFLICT(guild_id, incident_key) DO UPDATE SET
             status = 'open',
             safe_args_json = excluded.safe_args_json,
             occurrence_count = commerce_incidents.occurrence_count + 1,
             last_seen_at_ms = excluded.last_seen_at_ms,
             resolved_at_ms = NULL,
             updated_at_ms = excluded.updated_at_ms`,
        values: [
          incidentId,
          incidentKey,
          JSON.stringify({ reasonCode: input.reasonCode }),
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.message.connectedAccountId,
          input.message.connectedAccountId,
          input.message.resourceType,
          input.message.resourceId,
          input.message.generation,
          input.reasonCode,
        ],
      },
    ]);
  }

  async listPendingOutbox(limit = 100): Promise<CommerceReconciliationMessage[]> {
    const result = await this.database.queryResult<CommerceReconciliationMessage>(
      `SELECT connected_account_id AS "connectedAccountId", event_id AS "eventId",
                resource_type AS "resourceType", resource_id AS "resourceId", generation
         FROM commerce_sync_outbox
         WHERE sent_at_ms IS NULL ORDER BY created_at_ms LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async markOutboxSent(message: CommerceReconciliationMessage, sentAtMs: number): Promise<void> {
    await this.database.execute(
      `UPDATE commerce_sync_outbox SET sent_at_ms = COALESCE(sent_at_ms, $1)
       WHERE connected_account_id = $2 AND event_id = $3 AND generation = $4`,
      [sentAtMs, message.connectedAccountId, message.eventId, message.generation],
    );
  }

  async requestRefresh(input: {
    connectedAccountId: string;
    source: Exclude<CommerceReconciliationSource, "webhook">;
    correlationId: string;
    requestedAtMs: number;
  }): Promise<{
    accepted: boolean;
    outboxPending: boolean;
    message: CommerceReconciliationMessage;
  }> {
    const eventId = `commerce:${input.source}:${input.correlationId}`;
    const accepted = await this.accept({
      eventId,
      eventType: `commerce.refresh.${input.source}`,
      objectId: input.connectedAccountId,
      connectedAccountId: input.connectedAccountId,
      providerCreatedAtMs: input.requestedAtMs,
      payloadHash: stableHash(eventId),
    });
    return {
      accepted: accepted.accepted,
      outboxPending: accepted.outboxPending,
      message: {
        connectedAccountId: input.connectedAccountId,
        eventId,
        resourceType: "seller",
        resourceId: input.connectedAccountId,
        generation: accepted.generation,
      },
    };
  }

  async listScheduledSellerAccounts(limit = 100): Promise<string[]> {
    const result = await this.database.queryResult<{ id: string }>(
      `SELECT a.id
         FROM commerce_connected_accounts a
         JOIN commerce_seller_profiles p ON p.connected_account_id = a.id
         WHERE a.status <> 'archived'
           AND p.lifecycle_state NOT IN ('offboarding', 'disconnected')
         ORDER BY p.updated_at_ms LIMIT $1`,
      [limit],
    );
    return result.rows.map(({ id }) => id);
  }

  private async readWebhookGeneration(
    connectedAccountId: string,
    eventId: string,
  ): Promise<number | null> {
    const row = await this.database
      .query<{ generation: number }>(
        `SELECT generation FROM commerce_webhook_events
         WHERE connected_account_id = $1 AND stripe_event_id = $2`,
        [connectedAccountId, eventId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.generation ?? null;
  }

  private async webhookQuarantineEnabled(
    connectedAccountId: string,
    nowMs: number,
  ): Promise<boolean> {
    const row = await this.database
      .query<{ enabled: number }>(
        `SELECT 1 enabled
         FROM commerce_operational_controls c
         JOIN commerce_connected_accounts a ON a.id = $1
         WHERE c.enabled = 1 AND c.control_type = 'webhook_quarantine'
           AND (c.expires_at_ms IS NULL OR c.expires_at_ms > $2)
           AND (
             (c.scope_type = 'global' AND c.scope_id = 'commerce') OR
             (c.scope_type = 'guild' AND c.scope_id = a.guild_id) OR
             (c.scope_type = 'seller' AND c.scope_id = a.id)
           )
         LIMIT 1`,
        [connectedAccountId, nowMs],
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(row?.enabled);
  }

  private async quarantineAcceptedWebhook(
    event: AcceptedCommerceWebhook,
    eventRowId: string,
    receivedAtMs: number,
  ): Promise<void> {
    const account = await this.database
      .query<{ guild_id: string }>(
        "SELECT guild_id FROM commerce_connected_accounts WHERE id = $1 LIMIT 1",
        [event.connectedAccountId],
      )
      .then((rows) => rows[0] ?? null);
    if (!account) throw new Error("commerce_webhook_account_unknown");
    const incidentId = `webhook-quarantine:${event.connectedAccountId}`;
    await executePostgresCommands(this.database, [
      {
        statement: `INSERT INTO commerce_webhook_events(
             id, connected_account_id, stripe_event_id, event_type, object_id, payload_hash,
             generation, api_version, provider_created_at_ms, received_at_ms, status,
             attempt_count, last_error_code, processed_at_ms, updated_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, 'ignored', 0,
                     'operator_quarantine', NULL, $10)
           ON CONFLICT(connected_account_id, stripe_event_id) DO NOTHING`,
        values: [
          eventRowId,
          event.connectedAccountId,
          event.eventId,
          event.eventType,
          event.objectId,
          event.payloadHash,
          event.apiVersion ?? null,
          event.providerCreatedAtMs,
          receivedAtMs,
          receivedAtMs,
        ],
      },
      {
        statement: `INSERT INTO commerce_incidents
           (id, connected_account_id, guild_id, incident_key, severity, status, summary_code,
            entity_type, entity_id, safe_args_json, occurrence_count, first_seen_at_ms,
            last_seen_at_ms, resolved_at_ms, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 'warning', 'open', 'commerce_webhook_quarantined',
                   'seller', $5, '{}', 1, $6, $7, NULL, $8, $9)
           ON CONFLICT(guild_id, incident_key) DO UPDATE SET
             occurrence_count = occurrence_count + 1, last_seen_at_ms = excluded.last_seen_at_ms,
             updated_at_ms = excluded.updated_at_ms, status = 'open'`,
        values: [
          incidentId,
          event.connectedAccountId,
          account.guild_id,
          incidentId,
          event.connectedAccountId,
          receivedAtMs,
          receivedAtMs,
          receivedAtMs,
          receivedAtMs,
        ],
      },
    ]);
  }

  private async readSyncState(message: CommerceReconciliationMessage): Promise<{
    generation: number;
    appliedGeneration: number;
    leaseToken: string | null;
  } | null> {
    return this.database
      .query<{
        generation: number;
        appliedGeneration: number;
        leaseToken: string | null;
      }>(
        `SELECT generation, applied_generation AS "appliedGeneration", lease_token AS "leaseToken"
         FROM commerce_sync_state
         WHERE connected_account_id = $1 AND resource_type = $2 AND resource_id = $3`,
        [message.connectedAccountId, message.resourceType, message.resourceId],
      )
      .then((rows) => rows[0] ?? null);
  }
}

type ReconciliationGuard = {
  connectedAccountId: string;
  resourceType: string;
  resourceId: string;
  generation: number;
  leaseToken: string;
};

type ReportingLedgerInput = {
  id: string;
  connectedAccountId: string;
  guildId: string;
  sellerCountry: string | null;
  buyerId: string | null;
  transactionType:
    | "membership_payment"
    | "membership_refund"
    | "membership_dispute"
    | "support_payment"
    | "support_refund"
    | "support_dispute";
  sourceRecordId: string;
  providerTransactionId: string;
  providerStatus: string;
  currency: "AUD" | "USD";
  grossAmountMinor: number;
  applicationFeeMinor: number | null;
  stripeFeeMinor: number | null;
  stripeFeeTaxMinor: number | null;
  occurredAtMs: number;
  correctionOfTransactionType: string | null;
  correctionOfSourceRecordId: string | null;
  recordedAtMs: number;
};

function reportingLedgerInsert(
  input: ReportingLedgerInput,
  guard: ReconciliationGuard,
): PostgresCommand {
  const audAmountMinor = input.currency === "AUD" ? input.grossAmountMinor : null;
  return {
    statement: `INSERT INTO commerce_reporting_ledger(
         id, connected_account_id, guild_id, seller_country, buyer_id, transaction_type,
         source_record_id, provider_transaction_id, provider_status, currency,
         gross_amount_minor, application_fee_minor, stripe_fee_minor, stripe_fee_tax_minor, occurred_at_ms,
         reporting_period, correction_of_transaction_type, correction_of_source_record_id,
         aud_amount_minor, aud_conversion_rate, aud_conversion_source, aud_conversion_at_ms,
         recorded_at_ms
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NULL, NULL, NULL, $20
       WHERE EXISTS (
         SELECT 1 FROM commerce_sync_state
         WHERE connected_account_id = $21 AND resource_type = $22 AND resource_id = $23
           AND generation = $24 AND lease_token = $25
       )
       ON CONFLICT(transaction_type, connected_account_id, source_record_id) DO NOTHING`,
    values: [
      input.id,
      input.connectedAccountId,
      input.guildId,
      input.sellerCountry,
      input.buyerId,
      input.transactionType,
      input.sourceRecordId,
      input.providerTransactionId,
      input.providerStatus,
      input.currency,
      input.grossAmountMinor,
      input.applicationFeeMinor,
      input.stripeFeeMinor,
      input.stripeFeeTaxMinor,
      input.occurredAtMs,
      new Date(input.occurredAtMs).toISOString().slice(0, 7),
      input.correctionOfTransactionType,
      input.correctionOfSourceRecordId,
      audAmountMinor,
      input.recordedAtMs,
      guard.connectedAccountId,
      guard.resourceType,
      guard.resourceId,
      guard.generation,
      guard.leaseToken,
    ],
  };
}

function guardedUpsert(
  table: string,
  columns: string[],
  values: PostgresValue[],
  guard: ReconciliationGuard,
): PostgresCommand {
  const updates = columns
    .filter((column) => column !== "id" && column !== "created_at_ms")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  return {
    statement: `INSERT INTO ${table} (${columns.join(", ")})
       SELECT ${columns.map((_, index) => `$${index + 1}`).join(", ")}
       WHERE EXISTS (
         SELECT 1 FROM commerce_sync_state
         WHERE connected_account_id = $${columns.length + 1} AND resource_type = $${columns.length + 2} AND resource_id = $${columns.length + 3}
           AND generation = $${columns.length + 4} AND lease_token = $${columns.length + 5}
       )
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
    values: [
      ...values,
      guard.connectedAccountId,
      guard.resourceType,
      guard.resourceId,
      guard.generation,
      guard.leaseToken,
    ],
  };
}

function accountValues(account: CommerceSellerSnapshot["connectedAccount"]): PostgresValue[] {
  return [
    account.id,
    account.guildId,
    account.stripeAccountId,
    account.status,
    account.country,
    account.defaultCurrency,
    booleanInt(account.chargesEnabled),
    booleanInt(account.payoutsEnabled),
    booleanInt(account.detailsSubmitted),
    account.providerCreatedAtMs,
    account.archivedAtMs,
    account.createdAtMs,
    account.updatedAtMs,
  ];
}

function sourceFromEventType(eventType: string): CommerceReconciliationSource {
  if (eventType === "commerce.refresh.checkout") return "checkout";
  if (eventType === "commerce.refresh.scheduled") return "scheduled";
  if (eventType === "commerce.refresh.support") return "support";
  return "webhook";
}

function booleanInt(value: boolean): number {
  return value ? 1 : 0;
}

function eventKey(connectedAccountId: string, eventId: string): string {
  return `event:${stableHash(`${connectedAccountId}:${eventId}`)}`;
}

function syncStateId(connectedAccountId: string): string {
  return `sync:${connectedAccountId}:seller`;
}

function outboxKey(connectedAccountId: string, eventId: string): string {
  return `sync-outbox:${stableHash(`${connectedAccountId}:${eventId}`)}`;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}
