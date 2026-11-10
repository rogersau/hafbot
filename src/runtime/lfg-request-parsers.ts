import type { LfgPost } from "../types";
import { isRecord } from "../unknown-parse";

export function parseLfgPost(body: unknown): LfgPost {
  const record = asRecord(body);

  return {
    guildId: requiredString(record.guildId, "guildId"),
    id: requiredString(record.id, "id"),
    ownerId: requiredString(record.ownerId, "ownerId"),
    ownerDisplayName: requiredString(record.ownerDisplayName, "ownerDisplayName"),
    serverId: requiredString(record.serverId, "serverId"),
    serverLabel: requiredString(record.serverLabel, "serverLabel"),
    whenPlay: requiredString(record.whenPlay, "whenPlay"),
    lookingFor: requiredString(record.lookingFor, "lookingFor"),
    extraInfo: optionalString(record.extraInfo),
    channelId: requiredString(record.channelId, "channelId"),
    messageId: nullableString(record.messageId),
    active: requiredBoolean(record.active, "active"),
    createdAtMs: requiredNumber(record.createdAtMs, "createdAtMs"),
    expiresAtMs: nullableNumber(record.expiresAtMs),
    reminderSentAtMs: nullableNumber(record.reminderSentAtMs),
    renewedAtMs: nullableNumber(record.renewedAtMs),
    renewalsCount: requiredNumber(record.renewalsCount, "renewalsCount"),
    closedAtMs: nullableNumber(record.closedAtMs),
    closedByUserId: nullableString(record.closedByUserId),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected object.");
  }

  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected nullable string.");
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${field} to be a boolean.`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${field} to be a number.`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected nullable number.");
  }
  return value;
}
