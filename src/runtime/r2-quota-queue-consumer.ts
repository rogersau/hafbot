import type { QueueBatch } from "./queue-types";

import type { GuildR2ObjectStore } from "./contracts";

import { isRecord } from "../unknown-parse";
import {
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  deliverQueueBatch,
  queueDeliveryEmitter,
} from "./queue-delivery";

export const R2_QUOTA_QUEUE_NAME = "haf-bot-r2-quota";

export interface R2QuotaQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export async function deliverR2QuotaQueueBatch(
  batch: QueueBatch<unknown>,
  store: GuildR2ObjectStore,
  logger: R2QuotaQueueLogger = console,
): Promise<void> {
  await deliverQueueBatch(batch, {
    maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
    parse(body) {
      const event = parseR2Event(body);
      return event ? { ok: true, value: event } : { ok: false, reasonCode: "invalid_r2_event" };
    },
    async handle(event) {
      if (event.action === "create") {
        await store.upsertObject({
          guildId: event.guildId,
          key: event.key,
          sizeBytes: event.sizeBytes,
          createdAtMs: event.createdAtMs,
        });
      } else {
        await store.deleteObject({
          guildId: event.guildId,
          key: event.key,
          deletedAtMs: event.createdAtMs,
        });
      }
      return { status: "complete" };
    },
    classifyError: () => ({ status: "retry", reasonCode: "d1_unavailable" }),
    emit: queueDeliveryEmitter(logger),
  });
}

interface ParsedR2Event {
  action: "create" | "delete";
  guildId: string;
  key: string;
  sizeBytes: number;
  createdAtMs: number;
}

function parseR2Event(message: unknown): ParsedR2Event | null {
  if (!isRecord(message)) {
    return null;
  }

  const action = parseAction(
    asString(message.eventType) ??
      asString(message.eventName) ??
      asString(message.event) ??
      asString(message.action) ??
      asString(message.type),
  );
  const object = isRecord(message.object) ? message.object : undefined;
  const key = normalizeKey(
    asString(object?.key) ??
      asString(object?.name) ??
      asString(message.key) ??
      asString(message.name),
  );
  const guildId = key ? deriveGuildIdFromKey(key) : null;
  if (!action || !key || !guildId) {
    return null;
  }

  const sizeBytes =
    asFiniteNumber(object?.size) ??
    asFiniteNumber(object?.sizeBytes) ??
    asFiniteNumber(message.size) ??
    asFiniteNumber(message.sizeBytes);
  if (action === "create" && sizeBytes === null) {
    return null;
  }
  const createdAtMs = parseTimestampMs(
    message.eventTime ?? message.timestamp ?? message.time ?? object?.uploaded,
  );
  if (createdAtMs === null) return null;

  return {
    action,
    guildId,
    key,
    sizeBytes: sizeBytes ?? 0,
    createdAtMs,
  };
}

function parseAction(value: string | null): "create" | "delete" | null {
  const normalized = value?.toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes("delete") ||
    normalized.includes("remove") ||
    normalized.includes("object-deleted")
  ) {
    return "delete";
  }
  if (
    normalized.includes("create") ||
    normalized.includes("put") ||
    normalized.includes("copy") ||
    normalized.includes("complete")
  ) {
    return "create";
  }
  return null;
}

function deriveGuildIdFromKey(key: string): string | null {
  const [guildId] = key.split("/");
  return guildId && guildId.trim().length > 0 ? guildId : null;
}

function normalizeKey(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && !normalized.startsWith("/") ? normalized : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
