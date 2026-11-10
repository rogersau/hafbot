import { createHash } from "node:crypto";

import { normalizeLegacyPublicManagedMediaMetadata } from "../runtime/managed-media-object";
import type { ObjectStore, ObjectStoreHead } from "../runtime/object-store";

export interface ObjectMigrationManifestEntry {
  key: string;
  sizeBytes: number;
  contentType: string | null;
  metadata: Record<string, string>;
  etag: string | null;
  uploadedAt: string | null;
  sha256: string | null;
}

export interface ObjectMigrationManifest {
  schemaVersion: 1;
  source: { provider: string; identity: string };
  checksumMode: "none" | "sha256";
  objectCount: number;
  totalBytes: number;
  entriesSha256: string;
  entries: ObjectMigrationManifestEntry[];
}

export interface ObjectSyncCheckpoint {
  schemaVersion: 1;
  manifestSha256: string;
  destinationIdentity: string;
  nextIndex: number;
  copiedObjects: number;
  copiedBytes: number;
}

export async function inventoryObjectStore(input: {
  store: ObjectStore;
  source: ObjectMigrationManifest["source"];
  checksum?: boolean;
  maxObjects?: number;
  pageSize?: number;
}): Promise<ObjectMigrationManifest> {
  const maxObjects = readObjectLimit(input.maxObjects);
  const pageSize = readPageSize(input.pageSize);
  const entries: ObjectMigrationManifestEntry[] = [];
  let cursor: string | undefined;
  let previousCursor: string | undefined;
  do {
    const page = await input.store.list({
      prefix: "",
      cursor,
      limit: pageSize,
      includeMetadata: true,
    });
    for (const object of page.objects) {
      if (entries.length >= maxObjects) {
        throw new Error(`Object inventory exceeded the explicit ${maxObjects}-object safety cap.`);
      }
      entries.push(await inventoryEntry(input.store, object, input.checksum === true));
    }
    previousCursor = cursor;
    cursor = page.cursor ?? undefined;
    if (cursor !== undefined && cursor === previousCursor) {
      throw new Error("Object provider returned a non-advancing list cursor.");
    }
  } while (cursor !== undefined);

  entries.sort((left, right) => compareText(left.key, right.key));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.key === entries[index]?.key) {
      throw new Error(`Object provider listed duplicate key ${entries[index]!.key}.`);
    }
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Object inventory byte total is unsafe.");
  return {
    schemaVersion: 1,
    source: input.source,
    checksumMode: input.checksum ? "sha256" : "none",
    objectCount: entries.length,
    totalBytes,
    entriesSha256: hashManifestEntries(entries),
    entries,
  };
}

export async function syncObjectManifest(input: {
  source: ObjectStore;
  destination: ObjectStore;
  destinationIdentity: string;
  manifest: ObjectMigrationManifest;
  checkpoint?: ObjectSyncCheckpoint;
  writeCheckpoint?: (checkpoint: ObjectSyncCheckpoint) => Promise<void>;
}): Promise<ObjectSyncCheckpoint> {
  validateManifest(input.manifest, true);
  const manifestSha256 = hashManifestEntries(input.manifest.entries);
  let checkpoint = input.checkpoint ?? {
    schemaVersion: 1 as const,
    manifestSha256,
    destinationIdentity: input.destinationIdentity,
    nextIndex: 0,
    copiedObjects: 0,
    copiedBytes: 0,
  };
  validateCheckpoint(checkpoint, manifestSha256, input.destinationIdentity, input.manifest);
  checkpoint = await reconcileDestinationPrefix({
    destination: input.destination,
    destinationIdentity: input.destinationIdentity,
    manifest: input.manifest,
    checkpoint,
    writeCheckpoint: input.writeCheckpoint,
  });

  for (let index = checkpoint.nextIndex; index < input.manifest.entries.length; index += 1) {
    const entry = input.manifest.entries[index]!;
    const sourceObject = await input.source.get(entry.key);
    if (!sourceObject) throw new Error(`Source object disappeared during sync: ${entry.key}`);
    if (sourceObject.sizeBytes !== entry.sizeBytes) {
      throw new Error(`Source object size changed during sync: ${entry.key}`);
    }
    if (sourceObject.contentType !== entry.contentType) {
      throw new Error(`Source object content type changed during sync: ${entry.key}`);
    }
    if (
      canonicalMetadata(normalizeMigrationMetadata(sourceObject)) !==
      canonicalMetadata(entry.metadata)
    ) {
      throw new Error(`Source object metadata changed during sync: ${entry.key}`);
    }
    if (sourceObject.etag !== entry.etag) {
      throw new Error(`Source object ETag changed during sync: ${entry.key}`);
    }
    if ((sourceObject.uploadedAt?.toISOString() ?? null) !== entry.uploadedAt) {
      throw new Error(`Source object upload timestamp changed during sync: ${entry.key}`);
    }
    const { body, digest } = hashingStream(sourceObject.body);
    const stored = await input.destination.put(entry.key, body, {
      sizeBytes: entry.sizeBytes,
      contentType: entry.contentType,
      metadata: entry.metadata,
    });
    const actualSha256 = await digest;
    if (actualSha256 !== entry.sha256) {
      throw new Error(`Source object checksum changed during sync: ${entry.key}`);
    }
    if (stored.sizeBytes !== entry.sizeBytes || stored.contentType !== entry.contentType) {
      throw new Error(`Destination object properties do not match after sync: ${entry.key}`);
    }
    checkpoint = {
      ...checkpoint,
      nextIndex: index + 1,
      copiedObjects: checkpoint.copiedObjects + 1,
      copiedBytes: checkpoint.copiedBytes + entry.sizeBytes,
    };
    await input.writeCheckpoint?.(checkpoint);
  }
  return checkpoint;
}

export async function verifyObjectManifest(input: {
  destination: ObjectStore;
  destinationIdentity: string;
  manifest: ObjectMigrationManifest;
  maxDifferences?: number;
  pageSize?: number;
}): Promise<{
  status: "pass" | "fail";
  destinationIdentity: string;
  expectedObjects: number;
  actualObjects: number;
  expectedBytes: number;
  actualBytes: number;
  differences: Array<{ key: string; reason: string }>;
}> {
  validateManifest(input.manifest, true);
  const maxDifferences = input.maxDifferences ?? 100;
  if (!Number.isSafeInteger(maxDifferences) || maxDifferences < 1 || maxDifferences > 1_000) {
    throw new Error("maxDifferences must be between 1 and 1000.");
  }
  const actual = await inventoryObjectStore({
    store: input.destination,
    source: { provider: "destination", identity: input.destinationIdentity },
    checksum: true,
    maxObjects: Math.max(input.manifest.objectCount + maxDifferences + 1, 1_000),
    pageSize: input.pageSize,
  });
  const expectedByKey = new Map(input.manifest.entries.map((entry) => [entry.key, entry]));
  const actualByKey = new Map(actual.entries.map((entry) => [entry.key, entry]));
  const differences: Array<{ key: string; reason: string }> = [];
  for (const expected of input.manifest.entries) {
    const found = actualByKey.get(expected.key);
    if (!found) addDifference(expected.key, "missing", differences, maxDifferences);
    else if (found.sizeBytes !== expected.sizeBytes)
      addDifference(expected.key, "size_mismatch", differences, maxDifferences);
    else if (found.sha256 !== expected.sha256)
      addDifference(expected.key, "checksum_mismatch", differences, maxDifferences);
    else if (found.contentType !== expected.contentType)
      addDifference(expected.key, "content_type_mismatch", differences, maxDifferences);
    else if (canonicalMetadata(found.metadata) !== canonicalMetadata(expected.metadata))
      addDifference(expected.key, "metadata_mismatch", differences, maxDifferences);
  }
  for (const found of actual.entries) {
    if (!expectedByKey.has(found.key)) {
      addDifference(found.key, "unexpected", differences, maxDifferences);
    }
  }
  const matchesTotals =
    actual.objectCount === input.manifest.objectCount &&
    actual.totalBytes === input.manifest.totalBytes;
  return {
    status: differences.length === 0 && matchesTotals ? "pass" : "fail",
    destinationIdentity: input.destinationIdentity,
    expectedObjects: input.manifest.objectCount,
    actualObjects: actual.objectCount,
    expectedBytes: input.manifest.totalBytes,
    actualBytes: actual.totalBytes,
    differences,
  };
}

export function validateManifest(
  manifest: ObjectMigrationManifest,
  requireChecksums: boolean,
): void {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error("Unsupported object migration manifest.");
  }
  if (manifest.objectCount !== manifest.entries.length) {
    throw new Error("Object manifest count does not match its entries.");
  }
  if (hashManifestEntries(manifest.entries) !== manifest.entriesSha256) {
    throw new Error("Object manifest entries checksum is invalid.");
  }
  let bytes = 0;
  let previousKey: string | undefined;
  for (const entry of manifest.entries) {
    if (!entry.key || entry.key <= (previousKey ?? "")) {
      throw new Error("Object manifest entries must have unique sorted keys.");
    }
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error(`Object manifest has an invalid size for ${entry.key}.`);
    }
    if (requireChecksums && !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new Error(`Object manifest requires a SHA-256 checksum for ${entry.key}.`);
    }
    bytes += entry.sizeBytes;
    previousKey = entry.key;
  }
  if (bytes !== manifest.totalBytes || !Number.isSafeInteger(bytes)) {
    throw new Error("Object manifest byte total is invalid.");
  }
}

function validateCheckpoint(
  checkpoint: ObjectSyncCheckpoint,
  manifestSha256: string,
  destinationIdentity: string,
  manifest: ObjectMigrationManifest,
): void {
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.manifestSha256 !== manifestSha256 ||
    checkpoint.destinationIdentity !== destinationIdentity
  ) {
    throw new Error("Object sync checkpoint does not match this manifest and destination.");
  }
  if (
    !Number.isSafeInteger(checkpoint.nextIndex) ||
    checkpoint.nextIndex < 0 ||
    checkpoint.nextIndex > manifest.objectCount ||
    checkpoint.copiedObjects !== checkpoint.nextIndex
  ) {
    throw new Error("Object sync checkpoint position is invalid.");
  }
  if (checkpoint.copiedBytes !== copiedBytesThrough(manifest, checkpoint.nextIndex)) {
    throw new Error("Object sync checkpoint byte total is invalid.");
  }
}

async function reconcileDestinationPrefix(input: {
  destination: ObjectStore;
  destinationIdentity: string;
  manifest: ObjectMigrationManifest;
  checkpoint: ObjectSyncCheckpoint;
  writeCheckpoint?: (checkpoint: ObjectSyncCheckpoint) => Promise<void>;
}): Promise<ObjectSyncCheckpoint> {
  const maximumInventory = Math.min(Math.max(input.manifest.objectCount + 1, 1), 10_000_000);
  const actual = await inventoryObjectStore({
    store: input.destination,
    source: { provider: "destination-prefix", identity: input.destinationIdentity },
    checksum: true,
    maxObjects: maximumInventory,
  });
  if (actual.objectCount > input.manifest.objectCount) {
    throw new Error("Object sync destination contains objects outside the migration manifest.");
  }
  for (let index = 0; index < actual.entries.length; index += 1) {
    const found = actual.entries[index]!;
    const expected = input.manifest.entries[index];
    if (!expected || !matchingMigratedObject(found, expected)) {
      throw new Error(`Object sync destination is not a verified manifest prefix at ${found.key}.`);
    }
  }
  if (actual.objectCount < input.checkpoint.nextIndex) {
    throw new Error("Object sync destination is behind its checkpoint.");
  }
  if (actual.objectCount === input.checkpoint.nextIndex) return input.checkpoint;

  const reconciled = {
    ...input.checkpoint,
    nextIndex: actual.objectCount,
    copiedObjects: actual.objectCount,
    copiedBytes: copiedBytesThrough(input.manifest, actual.objectCount),
  };
  await input.writeCheckpoint?.(reconciled);
  return reconciled;
}

function matchingMigratedObject(
  found: ObjectMigrationManifestEntry,
  expected: ObjectMigrationManifestEntry,
): boolean {
  return (
    found.key === expected.key &&
    found.sizeBytes === expected.sizeBytes &&
    found.contentType === expected.contentType &&
    canonicalMetadata(found.metadata) === canonicalMetadata(expected.metadata) &&
    found.sha256 === expected.sha256
  );
}

function copiedBytesThrough(manifest: ObjectMigrationManifest, nextIndex: number): number {
  return manifest.entries.slice(0, nextIndex).reduce((total, entry) => total + entry.sizeBytes, 0);
}

async function inventoryEntry(
  store: ObjectStore,
  head: ObjectStoreHead,
  checksum: boolean,
): Promise<ObjectMigrationManifestEntry> {
  let sha256: string | null = null;
  if (checksum) {
    const object = await store.get(head.key);
    if (!object) throw new Error(`Object disappeared during inventory: ${head.key}`);
    if (object.sizeBytes !== head.sizeBytes) {
      throw new Error(`Object size changed during inventory: ${head.key}`);
    }
    sha256 = await hashBody(object.body, object.sizeBytes, head.key);
  }
  return {
    key: head.key,
    sizeBytes: head.sizeBytes,
    contentType: head.contentType,
    metadata: normalizeMigrationMetadata(head),
    etag: head.etag,
    uploadedAt: head.uploadedAt?.toISOString() ?? null,
    sha256,
  };
}

function hashingStream(body: ReadableStream<Uint8Array>): {
  body: ReadableStream<Uint8Array>;
  digest: Promise<string>;
} {
  const hash = createHash("sha256");
  let resolveDigest: (value: string) => void;
  let rejectDigest: (reason: unknown) => void;
  const digest = new Promise<string>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  const transformed = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        resolveDigest(hash.digest("hex"));
      },
      cancel(reason) {
        rejectDigest(reason);
      },
    }),
  );
  return { body: transformed, digest };
}

async function hashBody(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  key: string,
): Promise<string> {
  const hash = createHash("sha256");
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      hash.update(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes !== expectedBytes) {
    throw new Error(`Object body length does not match metadata for ${key}.`);
  }
  return hash.digest("hex");
}

function hashManifestEntries(entries: readonly ObjectMigrationManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`);
  return hash.digest("hex");
}

function sortMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => compareText(left, right)),
  );
}

function normalizeMigrationMetadata(
  object: Pick<ObjectStoreHead, "key" | "metadata" | "uploadedAt">,
): Record<string, string> {
  return sortMetadata(
    normalizeLegacyPublicManagedMediaMetadata({
      key: object.key,
      metadata: object.metadata,
      uploadedAt: object.uploadedAt,
    }),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalMetadata(metadata: Record<string, string>): string {
  return JSON.stringify(sortMetadata(metadata));
}

function addDifference(
  key: string,
  reason: string,
  differences: Array<{ key: string; reason: string }>,
  limit: number,
): void {
  if (differences.length < limit) differences.push({ key, reason });
}

function readObjectLimit(value: number | undefined): number {
  const result = value ?? 1_000_000;
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000_000) {
    throw new Error("maxObjects must be between 1 and 10000000.");
  }
  return result;
}

function readPageSize(value: number | undefined): number {
  const result = value ?? 1_000;
  if (!Number.isSafeInteger(result) || result < 1 || result > 1_000) {
    throw new Error("pageSize must be between 1 and 1000.");
  }
  return result;
}

export const __testing = { hashManifestEntries };
