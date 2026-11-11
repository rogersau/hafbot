import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { BillingWebhookStore, VerifiedBillingWebhook } from "../billing/webhook";

export type PendingBillingWebhookOutbox = {
  eventId: string;
  customerId: string;
};

export class PostgresBillingWebhookStore implements BillingWebhookStore {
  constructor(private readonly database: PostgresDatabaseCapability) {}

  async accept(
    event: VerifiedBillingWebhook,
  ): Promise<{ accepted: boolean; outboxPending: boolean }> {
    const existing = await this.database
      .query<{ event_id: string }>(
        "SELECT event_id FROM billing_webhook_events WHERE event_id = $1",
        [event.eventId],
      )
      .then((rows) => rows[0] ?? null);
    await executePostgresCommands(this.database, [
      {
        statement: `INSERT INTO billing_webhook_events(
             event_id, event_type, object_id, stripe_customer_id, stripe_created_at_ms,
             payload_hash, received_at_ms, processing_status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') ON CONFLICT(event_id) DO NOTHING`,
        values: [
          event.eventId,
          event.eventType,
          event.objectId,
          event.customerId,
          event.createdAtMs,
          event.payloadHash,
          Date.now(),
        ],
      },
      {
        statement: `INSERT INTO billing_sync_outbox(event_id, stripe_customer_id, created_at_ms)
           SELECT $1, $2, $3 WHERE EXISTS(
             SELECT 1 FROM billing_webhook_events WHERE event_id = $4 AND processing_status = 'pending'
           ) ON CONFLICT(event_id) DO NOTHING`,
        values: [event.eventId, event.customerId, Date.now(), event.eventId],
      },
    ]);
    const row = await this.database
      .query<{ received_at_ms: number; sent_at_ms: number | null }>(
        `SELECT e.received_at_ms, o.sent_at_ms
         FROM billing_webhook_events e LEFT JOIN billing_sync_outbox o ON o.event_id = e.event_id
         WHERE e.event_id = $1`,
        [event.eventId],
      )
      .then((rows) => rows[0] ?? null);
    return {
      accepted: !existing,
      outboxPending: row?.sent_at_ms === null,
    };
  }

  async markOutboxSent(eventId: string, sentAtMs: number): Promise<void> {
    await this.database.queryResult(
      "UPDATE billing_sync_outbox SET sent_at_ms = COALESCE(sent_at_ms, $1) WHERE event_id = $2",
      [sentAtMs, eventId],
    );
  }

  async listPendingOutbox(limit = 100): Promise<PendingBillingWebhookOutbox[]> {
    const result = await this.database.queryResult<{
      event_id: string;
      stripe_customer_id: string;
    }>(
      `SELECT event_id, stripe_customer_id FROM billing_sync_outbox
         WHERE sent_at_ms IS NULL ORDER BY created_at_ms LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      customerId: row.stripe_customer_id,
    }));
  }

  async readOwnerId(customerId: string): Promise<string | null> {
    const row = await this.database
      .query<{ owner_id: string }>(
        "SELECT owner_id FROM billing_customer_bindings WHERE stripe_customer_id = $1",
        [customerId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.owner_id ?? null;
  }

  async readEvent(eventId: string): Promise<{ eventType: string; objectId: string | null } | null> {
    const row = await this.database
      .query<{ event_type: string; object_id: string | null }>(
        "SELECT event_type, object_id FROM billing_webhook_events WHERE event_id = $1",
        [eventId],
      )
      .then((rows) => rows[0] ?? null);
    return row ? { eventType: row.event_type, objectId: row.object_id } : null;
  }

  async markProcessed(eventId: string, processedAtMs: number): Promise<boolean> {
    await this.database.queryResult(
      `UPDATE billing_webhook_events SET processing_status = 'processed', processed_at_ms = $1
         WHERE event_id = $2 AND processing_status = 'pending'`,
      [processedAtMs, eventId],
    );
    const row = await this.database
      .query<{ processing_status: string }>(
        "SELECT processing_status FROM billing_webhook_events WHERE event_id = $1",
        [eventId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.processing_status === "processed";
  }

  async markTerminal(eventId: string, reason: string, nowMs: number): Promise<void> {
    await this.database.queryResult(
      `UPDATE billing_webhook_events SET processing_status = 'terminal', terminal_reason = $1, processed_at_ms = $2
         WHERE event_id = $3 AND processing_status != 'processed'`,
      [reason, nowMs, eventId],
    );
  }
}
