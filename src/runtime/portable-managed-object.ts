import {
  transitionManagedObject,
  managedObjectFailureAction,
  type ManagedObjectWorkflow,
} from "./managed-object-workflow";
import { getGuildEntitlementLimits } from "../types";
import type { GuildEntitlementStore, GuildR2QuotaStore } from "./contracts";
import {
  resolveObjectBodySize,
  type ObjectStore,
  type ObjectStoreBody,
  type ObjectStoreHead,
} from "./object-store";

const RESERVATION_TTL_MS = 15 * 60_000;

export async function putManagedGuildObject(input: {
  key: string;
  body: ObjectStoreBody;
  declaredSizeBytes?: number;
  contentType?: string | null;
  metadata?: Record<string, string>;
  objects: ObjectStore;
  guildEntitlements: GuildEntitlementStore;
  guildObjects: GuildR2QuotaStore;
  operationKey?: string;
  now?: () => number;
}): Promise<ObjectStoreHead> {
  const guildId = readGuildIdFromObjectKey(input.key);
  const expectedBytes = resolveObjectBodySize(input.body, input.declaredSizeBytes);
  if (expectedBytes === null) throw new Error("Streaming object uploads require a trusted size.");
  const entitlement = await input.guildEntitlements.readGuildEntitlement(guildId);
  const limitBytes = getGuildEntitlementLimits(entitlement.tier).r2MaxBytes;
  const operationKey = input.operationKey ?? crypto.randomUUID();
  const now = input.now ?? Date.now;
  const reservedAtMs = now();
  const reservation = await input.guildObjects.reserveObject({
    guildId,
    key: input.key,
    operationKey,
    reservedBytes: expectedBytes,
    limitBytes,
    expiresAtMs: reservedAtMs + RESERVATION_TTL_MS,
    nowMs: reservedAtMs,
  });
  if (reservation.status === "quota-exceeded") {
    throw new Error(
      `Object storage quota exceeded for guild ${guildId}: the ${expectedBytes}-byte write cannot fit within ${limitBytes} bytes`,
    );
  }
  if (reservation.status === "conflict") {
    throw new Error(`Object ${input.key} already has an upload in progress.`);
  }

  let workflow: ManagedObjectWorkflow = { kind: "reserved" };
  try {
    const marked = await input.guildObjects.markUploadStarted({
      guildId,
      key: input.key,
      operationKey,
      startedAtMs: now(),
    });
    if (!marked) throw new Error(`Object reservation start failed for ${input.key}.`);
    workflow = transitionManagedObject(workflow, "upload-started");
    const object = await input.objects.put(input.key, input.body, {
      sizeBytes: expectedBytes,
      contentType: input.contentType,
      metadata: input.metadata,
    });
    workflow = transitionManagedObject(workflow, "upload-confirmed");
    if (object.sizeBytes !== expectedBytes) {
      throw new Error(
        `Object size mismatch for ${input.key}: expected ${expectedBytes}, stored ${object.sizeBytes}.`,
      );
    }
    const committed = await input.guildObjects.commitObject({
      guildId,
      key: input.key,
      operationKey,
      actualBytes: object.sizeBytes,
      committedAtMs: now(),
    });
    if (!committed) throw new Error(`Object reservation commit failed for ${input.key}.`);
    workflow = transitionManagedObject(workflow, "commit-confirmed");
    return object;
  } catch (error) {
    const absent =
      workflow.kind === "upload-outcome-unknown" &&
      (await objectIsDefinitelyAbsent(input.objects, input.key));
    if (managedObjectFailureAction(workflow, absent) === "release-reservation") {
      await input.guildObjects.releaseReservation({ guildId, key: input.key, operationKey });
    }
    throw error;
  }
}

export function readGuildIdFromObjectKey(key: string): string {
  const guildId = key.split("/", 1)[0];
  if (!guildId) throw new Error("Invalid object key: missing guild path segment.");
  return guildId;
}

async function objectIsDefinitelyAbsent(objects: ObjectStore, key: string): Promise<boolean> {
  try {
    return (await objects.head(key)) === null;
  } catch {
    return false;
  }
}
