import type {
  BillingWebhookStore,
  VerifiedBillingWebhook,
} from "../../../../../src/runtime/billing/webhook";

export interface PendingBillingWebhookOutbox {
  eventId: string;
  customerId: string;
}

export class SqliteBillingWebhookStore implements BillingWebhookStore {
  constructor(private readonly database: D1Database) {}

  async accept(
    event: VerifiedBillingWebhook,
  ): Promise<{ accepted: boolean; outboxPending: boolean }> {
    const existing = await this.database
      .prepare("SELECT event_id FROM billing_webhook_events WHERE event_id = ?")
      .bind(event.eventId)
      .first<{ event_id: string }>();
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO billing_webhook_events(
             event_id, event_type, object_id, stripe_customer_id, stripe_created_at_ms,
             payload_hash, received_at_ms, processing_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(
          event.eventId,
          event.eventType,
          event.objectId,
          event.customerId,
          event.createdAtMs,
          event.payloadHash,
          Date.now(),
        ),
      this.database
        .prepare(
          `INSERT INTO billing_sync_outbox(event_id, stripe_customer_id, created_at_ms)
           SELECT ?, ?, ? WHERE EXISTS(
             SELECT 1 FROM billing_webhook_events WHERE event_id = ? AND processing_status = 'pending'
           ) ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(event.eventId, event.customerId, Date.now(), event.eventId),
    ]);
    const row = await this.database
      .prepare(
        `SELECT e.received_at_ms, o.sent_at_ms
         FROM billing_webhook_events e LEFT JOIN billing_sync_outbox o ON o.event_id = e.event_id
         WHERE e.event_id = ?`,
      )
      .bind(event.eventId)
      .first<{ received_at_ms: number; sent_at_ms: number | null }>();
    return {
      accepted: !existing,
      outboxPending: row?.sent_at_ms === null,
    };
  }

  async markOutboxSent(eventId: string, sentAtMs: number): Promise<void> {
    await this.database
      .prepare(
        "UPDATE billing_sync_outbox SET sent_at_ms = COALESCE(sent_at_ms, ?) WHERE event_id = ?",
      )
      .bind(sentAtMs, eventId)
      .run();
  }

  async listPendingOutbox(limit = 100): Promise<PendingBillingWebhookOutbox[]> {
    const result = await this.database
      .prepare(
        `SELECT event_id, stripe_customer_id FROM billing_sync_outbox
         WHERE sent_at_ms IS NULL ORDER BY created_at_ms LIMIT ?`,
      )
      .bind(limit)
      .all<{ event_id: string; stripe_customer_id: string }>();
    return result.results.map((row) => ({
      eventId: row.event_id,
      customerId: row.stripe_customer_id,
    }));
  }

  async readOwnerId(customerId: string): Promise<string | null> {
    const row = await this.database
      .prepare("SELECT owner_id FROM billing_customer_bindings WHERE stripe_customer_id = ?")
      .bind(customerId)
      .first<{ owner_id: string }>();
    return row?.owner_id ?? null;
  }

  async readEvent(eventId: string): Promise<{ eventType: string; objectId: string | null } | null> {
    const row = await this.database
      .prepare("SELECT event_type, object_id FROM billing_webhook_events WHERE event_id = ?")
      .bind(eventId)
      .first<{ event_type: string; object_id: string | null }>();
    return row ? { eventType: row.event_type, objectId: row.object_id } : null;
  }

  async markProcessed(eventId: string, processedAtMs: number): Promise<boolean> {
    await this.database
      .prepare(
        `UPDATE billing_webhook_events SET processing_status = 'processed', processed_at_ms = ?
         WHERE event_id = ? AND processing_status = 'pending'`,
      )
      .bind(processedAtMs, eventId)
      .run();
    const row = await this.database
      .prepare("SELECT processing_status FROM billing_webhook_events WHERE event_id = ?")
      .bind(eventId)
      .first<{ processing_status: string }>();
    return row?.processing_status === "processed";
  }

  async markTerminal(eventId: string, reason: string, nowMs: number): Promise<void> {
    await this.database
      .prepare(
        `UPDATE billing_webhook_events SET processing_status = 'terminal', terminal_reason = ?, processed_at_ms = ?
         WHERE event_id = ? AND processing_status != 'processed'`,
      )
      .bind(reason, nowMs, eventId)
      .run();
  }
}
