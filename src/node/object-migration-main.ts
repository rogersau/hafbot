import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { isRecord } from "../unknown-parse";
import { createAzureBlobObjectStoreFromEnvironment } from "./azure-blob-object-store";
import {
  inventoryObjectStore,
  syncObjectManifest,
  validateManifest,
  verifyObjectManifest,
  type ObjectMigrationManifest,
  type ObjectSyncCheckpoint,
} from "./object-migration";
import { createS3ObjectStoreFromEnvironment } from "./s3-object-store";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: "string" },
      manifest: { type: "string" },
      checkpoint: { type: "string" },
      checksum: { type: "boolean", default: false },
      "max-objects": { type: "string", default: "1000000" },
      "confirm-destination": { type: "string" },
    },
  });

  const command = positionals[0];
  if (!values.output) usage();

  if (command === "inventory") {
    const source = createMigrationSourceStore();
    const sourceIdentity = s3Identity();
    const manifest = await inventoryObjectStore({
      store: source,
      source: { provider: "s3-compatible", identity: sourceIdentity },
      checksum: values.checksum,
      maxObjects: Number(values["max-objects"]),
    });
    await writeRestrictedJson(values.output, manifest);
    console.info(
      `Wrote restricted object manifest for ${manifest.objectCount} objects and ${manifest.totalBytes} bytes (${manifest.checksumMode}).`,
    );
  } else if (command === "sync") {
    if (!values.manifest || !values.checkpoint || !values["confirm-destination"]) usage();
    const manifest = await readManifest(values.manifest);
    validateManifest(manifest, true);
    const destinationIdentity = azureIdentity();
    if (values["confirm-destination"] !== destinationIdentity) {
      throw new Error(`Destination confirmation must exactly equal ${destinationIdentity}.`);
    }
    const checkpoint = await readCheckpoint(values.checkpoint);
    const result = await syncObjectManifest({
      source: createMigrationSourceStore(),
      destination: createAzureBlobObjectStoreFromEnvironment(process.env),
      destinationIdentity,
      manifest,
      checkpoint,
      writeCheckpoint: (next) => writeRestrictedJson(values.checkpoint!, next),
    });
    await writeRestrictedJson(values.output, {
      schemaVersion: 1,
      status: "copied",
      destinationIdentity,
      manifestSha256: result.manifestSha256,
      copiedObjects: result.copiedObjects,
      copiedBytes: result.copiedBytes,
      requiresDestinationVerification: true,
    });
    console.info(
      `Copied ${result.copiedObjects} objects; destination verification is still required.`,
    );
  } else if (command === "verify") {
    if (!values.manifest || !values["confirm-destination"]) usage();
    const manifest = await readManifest(values.manifest);
    const destinationIdentity = azureIdentity();
    if (values["confirm-destination"] !== destinationIdentity) {
      throw new Error(`Destination confirmation must exactly equal ${destinationIdentity}.`);
    }
    const report = await verifyObjectManifest({
      destination: createAzureBlobObjectStoreFromEnvironment(process.env),
      destinationIdentity,
      manifest,
    });
    await writeRestrictedJson(values.output, report);
    console.info(
      `Destination object verification ${report.status}: ${report.actualObjects} objects and ${report.actualBytes} bytes.`,
    );
    if (report.status !== "pass") process.exitCode = 2;
  } else {
    usage();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Object migration failed.");
  process.exitCode = 1;
});

function createMigrationSourceStore() {
  return createS3ObjectStoreFromEnvironment(process.env, { metadataReadMode: "r2-workers" });
}

async function readManifest(path: string): Promise<ObjectMigrationManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Object migration manifest must be an object.");
  return parsed as unknown as ObjectMigrationManifest;
}

async function readCheckpoint(path: string): Promise<ObjectSyncCheckpoint | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("Object sync checkpoint must be an object.");
    return parsed as unknown as ObjectSyncCheckpoint;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeRestrictedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function s3Identity(): string {
  const bucket = process.env.S3_BUCKET_NAME?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim() ?? "https://s3.amazonaws.com";
  if (!bucket) throw new Error("S3_BUCKET_NAME is required.");
  return `${new URL(endpoint).host}/${bucket}`;
}

function azureIdentity(): string {
  const container = process.env.BLOB_CONTAINER_NAME?.trim();
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL?.trim();
  if (!container || !accountUrl) {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL and BLOB_CONTAINER_NAME are required.");
  }
  return `${new URL(accountUrl).host}/${container}`;
}

function usage(): never {
  console.error(
    "Usage:\n" +
      "  object-migration inventory --output <manifest.json> [--checksum] [--max-objects N]\n" +
      "  object-migration sync --manifest <manifest.json> --checkpoint <checkpoint.json> --output <report.json> --confirm-destination <account/container>\n" +
      "  object-migration verify --manifest <manifest.json> --output <report.json> --confirm-destination <account/container>",
  );
  process.exit(1);
}
