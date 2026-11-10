import {
  transitionManagedObject,
  managedObjectFailureAction,
  type ManagedObjectWorkflow,
} from "./managed-object-workflow";
import { getGuildEntitlementLimits } from "../types";
import type { GuildEntitlementStore, GuildR2QuotaStore } from "./contracts";

const RESERVATION_TTL_MS = 15 * 60 * 1_000;

export async function putManagedGuildR2Object(input: {
  key: string;
  body: ReadableStream<Uint8Array> | ArrayBuffer | string;
  declaredSizeBytes?: number;
  bucket: R2Bucket;
  putOptions?: R2PutOptions;
  guildEntitlements: GuildEntitlementStore;
  guildR2Objects: GuildR2QuotaStore;
  operationKey?: string;
  now?: () => number;
}): Promise<R2Object> {
  const guildId = readGuildIdFromR2Key(input.key);
  const expectedBytes = resolveR2BodyBytes(input.body, input.declaredSizeBytes);
  const entitlement = await input.guildEntitlements.readGuildEntitlement(guildId);
  const limits = getGuildEntitlementLimits(entitlement.tier);
  const operationKey = input.operationKey ?? crypto.randomUUID();
  const now = input.now ?? Date.now;
  const reservedAtMs = now();
  const reservation = await input.guildR2Objects.reserveObject({
    guildId,
    key: input.key,
    operationKey,
    reservedBytes: expectedBytes,
    limitBytes: limits.r2MaxBytes,
    expiresAtMs: reservedAtMs + RESERVATION_TTL_MS,
    nowMs: reservedAtMs,
  });
  if (reservation.status === "quota-exceeded") {
    throw new Error(
      `R2 storage quota exceeded for guild ${guildId}: the ${expectedBytes}-byte write cannot fit within ${limits.r2MaxBytes} bytes`,
    );
  }
  if (reservation.status === "conflict") {
    throw new Error(`R2 object ${input.key} already has an upload in progress.`);
  }

  let workflow: ManagedObjectWorkflow = { kind: "reserved" };
  try {
    const marked = await input.guildR2Objects.markUploadStarted({
      guildId,
      key: input.key,
      operationKey,
      startedAtMs: now(),
    });
    if (!marked) throw new Error(`R2 reservation upload start failed for ${input.key}.`);
    workflow = transitionManagedObject(workflow, "upload-started");
    const object = await input.bucket.put(input.key, input.body, input.putOptions);
    workflow = transitionManagedObject(workflow, "upload-confirmed");
    if (!object) throw new Error(`R2 did not return metadata for ${input.key}.`);
    if (object.size !== expectedBytes) {
      throw new Error(
        `R2 object size mismatch for ${input.key}: expected ${expectedBytes} bytes but stored ${object.size} bytes.`,
      );
    }
    const committed = await input.guildR2Objects.commitObject({
      guildId,
      key: input.key,
      operationKey,
      actualBytes: object.size,
      committedAtMs: now(),
    });
    if (!committed) throw new Error(`R2 reservation commit failed for ${input.key}.`);
    workflow = transitionManagedObject(workflow, "commit-confirmed");
    return object;
  } catch (error) {
    const absent =
      workflow.kind === "upload-outcome-unknown" &&
      (await objectIsDefinitelyAbsent(input.bucket, input.key));
    if (managedObjectFailureAction(workflow, absent) === "release-reservation") {
      await input.guildR2Objects.releaseReservation({ guildId, key: input.key, operationKey });
    }
    // Once put succeeds, deleting the key could destroy the previous object during a
    // replacement. Keep the bounded reservation until queue repair or reconciliation
    // confirms the actual R2 state instead.
    throw error;
  }
}

async function objectIsDefinitelyAbsent(bucket: R2Bucket, key: string): Promise<boolean> {
  try {
    return (await bucket.head(key)) === null;
  } catch {
    return false;
  }
}

export function readGuildIdFromR2Key(key: string): string {
  const [guildId] = key.split("/");
  if (!guildId) throw new Error(`Invalid R2 object key: missing guild path segment`);
  return guildId;
}

export function resolveR2BodyBytes(
  body: ReadableStream<Uint8Array> | ArrayBuffer | string,
  declaredSizeBytes?: number,
): number {
  const knownBytes = getKnownR2BodyBytes(body);
  if (knownBytes !== null) {
    if (declaredSizeBytes !== undefined && declaredSizeBytes !== knownBytes) {
      throw new Error(
        `R2 declared size mismatch: expected ${declaredSizeBytes} bytes but the body contains ${knownBytes} bytes.`,
      );
    }
    return knownBytes;
  }
  if (!Number.isSafeInteger(declaredSizeBytes) || declaredSizeBytes! < 0) {
    throw new Error("R2 stream uploads require a trusted declared size.");
  }
  return declaredSizeBytes!;
}

export function getKnownR2BodyBytes(
  body: ReadableStream<Uint8Array> | ArrayBuffer | string,
): number | null {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return null;
}
