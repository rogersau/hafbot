import type { SyncBillingOwnerInput } from "./owner-sync";
import type { BillingSyncQueueMessage, BillingSyncQueueSender } from "./webhook";

export interface BillingQueueEventStore {
  readOwnerId(customerId: string): Promise<string | null>;
  markProcessed(eventId: string, processedAtMs: number): Promise<boolean>;
  markTerminal(eventId: string, reason: string, nowMs: number): Promise<void>;
  listPendingOutbox(limit?: number): Promise<BillingSyncQueueMessage[]>;
  markOutboxSent(eventId: string, sentAtMs: number): Promise<void>;
}

export async function processBillingSyncMessage(options: {
  message: BillingSyncQueueMessage;
  attempts: number;
  store: BillingQueueEventStore;
  syncOwner(input: SyncBillingOwnerInput): Promise<unknown>;
  handleAdverseEvent?(eventId: string, ownerId: string): Promise<void>;
  maxAttempts?: number;
  now?: () => number;
}): Promise<"processed" | "already_processed" | "retry" | "terminal"> {
  const now = options.now ?? Date.now;
  const ownerId = await options.store.readOwnerId(options.message.customerId);
  if (!ownerId) {
    if (options.attempts < (options.maxAttempts ?? 5)) return "retry";
    await options.store.markTerminal(options.message.eventId, "customer_binding_missing", now());
    return "terminal";
  }
  try {
    await options.handleAdverseEvent?.(options.message.eventId, ownerId);
    await options.syncOwner({
      ownerId,
      source: "webhook",
      correlationId: options.message.eventId,
    });
    return (await options.store.markProcessed(options.message.eventId, now()))
      ? "processed"
      : "already_processed";
  } catch (error) {
    if (options.attempts < (options.maxAttempts ?? 5)) return "retry";
    await options.store.markTerminal(
      options.message.eventId,
      error instanceof Error ? error.message : "sync_failed",
      now(),
    );
    return "terminal";
  }
}

export async function sweepBillingSyncOutbox(options: {
  store: BillingQueueEventStore;
  queue: BillingSyncQueueSender;
  now?: () => number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  const pending = await options.store.listPendingOutbox();
  for (const message of pending) {
    await options.queue.send(message);
    await options.store.markOutboxSent(message.eventId, now());
  }
  return pending.length;
}
