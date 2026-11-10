import { Readable } from "node:stream";

import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type BlockBlobClient, type ContainerClient } from "@azure/storage-blob";

import { isRecord } from "../unknown-parse";
import {
  decodePortableObjectMetadata,
  encodePortableObjectMetadata,
  resolveObjectBodySize,
  validateObjectStoreKey,
  type ObjectStore,
  type ObjectStoreBody,
  type ObjectStoreHead,
  type ObjectStorePutOptions,
} from "../runtime/object-store";

export interface AzureBlobEnvironment {
  NODE_ENV?: string;
  AZURE_STORAGE_ACCOUNT_URL?: string;
  AZURE_STORAGE_CONNECTION_STRING?: string;
  BLOB_CONTAINER_NAME?: string;
}

export function createAzureBlobObjectStoreFromEnvironment(
  environment: AzureBlobEnvironment,
): ObjectStore {
  const containerName = environment.BLOB_CONTAINER_NAME?.trim();
  if (!containerName) throw new Error("BLOB_CONTAINER_NAME is required for Azure Blob storage.");
  const connectionString = environment.AZURE_STORAGE_CONNECTION_STRING?.trim();
  const production = environment.NODE_ENV === "production";
  if (production && connectionString) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING is not supported in production; use managed identity.",
    );
  }
  const accountUrl = validateAzureStorageAccountUrl(
    environment.AZURE_STORAGE_ACCOUNT_URL,
    production,
  );
  const service = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : accountUrl
      ? new BlobServiceClient(accountUrl, new DefaultAzureCredential())
      : null;
  if (!service) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_URL or AZURE_STORAGE_CONNECTION_STRING is required for Azure Blob storage.",
    );
  }
  return createAzureBlobObjectStore(service.getContainerClient(containerName));
}

export function createAzureBlobObjectStore(container: ContainerClient): ObjectStore {
  return {
    async put(key, body, options = {}) {
      validateObjectStoreKey(key);
      const sizeBytes = requireBodySize(body, options);
      const client = container.getBlockBlobClient(key);
      const uploadOptions = {
        blobHTTPHeaders: options.contentType ? { blobContentType: options.contentType } : undefined,
        metadata: encodePortableObjectMetadata(options.metadata),
      };
      if (body instanceof ReadableStream) {
        await client.uploadStream(
          Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          4 * 1024 * 1024,
          2,
          uploadOptions,
        );
      } else {
        const bytes = toBuffer(body);
        await client.uploadData(bytes, uploadOptions);
      }
      const object = mapHead(key, await client.getProperties());
      if (object.sizeBytes !== sizeBytes) {
        throw new Error(
          `Azure Blob size mismatch for ${key}: expected ${sizeBytes}, stored ${object.sizeBytes}.`,
        );
      }
      return object;
    },

    async get(key, options = {}) {
      validateObjectStoreKey(key);
      validateRange(options);
      const client = container.getBlobClient(key);
      try {
        const response = await client.download(options.offset, options.length);
        if (!response.readableStreamBody) {
          throw new Error(`Azure Blob ${key} did not return a readable body.`);
        }
        return {
          key,
          body: Readable.toWeb(
            response.readableStreamBody as unknown as Readable,
          ) as ReadableStream<Uint8Array>,
          sizeBytes: response.contentLength ?? 0,
          contentType: response.contentType ?? null,
          metadata: decodePortableObjectMetadata(response.metadata),
          etag: response.etag ?? null,
          uploadedAt: response.lastModified ?? null,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async head(key) {
      validateObjectStoreKey(key);
      try {
        return mapHead(key, await container.getBlobClient(key).getProperties());
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      validateObjectStoreKey(key);
      await container.getBlobClient(key).deleteIfExists({ deleteSnapshots: "include" });
    },

    async list(input) {
      validateListInput(input.prefix, input.limit);
      const pageSize = input.limit ?? 1_000;
      const iterator = container
        .listBlobsFlat({ prefix: input.prefix, includeMetadata: input.includeMetadata ?? false })
        .byPage({ continuationToken: input.cursor, maxPageSize: pageSize });
      const page = await iterator.next();
      if (page.done) return { objects: [], cursor: null };
      return {
        objects: page.value.segment.blobItems.map((blob) => ({
          key: blob.name,
          sizeBytes: blob.properties.contentLength ?? 0,
          contentType: blob.properties.contentType ?? null,
          metadata: decodePortableObjectMetadata(blob.metadata),
          etag: blob.properties.etag ?? null,
          uploadedAt: blob.properties.lastModified ?? null,
        })),
        cursor: page.value.continuationToken ?? null,
      };
    },
  };
}

type BlobProperties = Awaited<ReturnType<BlockBlobClient["getProperties"]>>;

function mapHead(key: string, properties: BlobProperties): ObjectStoreHead {
  return {
    key,
    sizeBytes: properties.contentLength ?? 0,
    contentType: properties.contentType ?? null,
    metadata: decodePortableObjectMetadata(properties.metadata),
    etag: properties.etag ?? null,
    uploadedAt: properties.lastModified ?? null,
  };
}

function requireBodySize(body: ObjectStoreBody, options: ObjectStorePutOptions): number {
  const size = resolveObjectBodySize(body, options.sizeBytes);
  if (size === null) throw new Error("Streaming object uploads require sizeBytes.");
  return size;
}

function toBuffer(body: Exclude<ObjectStoreBody, ReadableStream<Uint8Array>>): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(body);
}

function validateRange(options: { offset?: number; length?: number }): void {
  if (
    options.offset !== undefined &&
    (!Number.isSafeInteger(options.offset) || options.offset < 0)
  ) {
    throw new Error("Object range offset must be a non-negative integer.");
  }
  if (
    options.length !== undefined &&
    (!Number.isSafeInteger(options.length) || options.length < 1)
  ) {
    throw new Error("Object range length must be a positive integer.");
  }
}

function validateListInput(prefix: string, limit: number | undefined): void {
  if (prefix.startsWith("/") || prefix.includes("\\")) throw new Error("Invalid object prefix.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)) {
    throw new Error("Object list limit must be between 1 and 1000.");
  }
}

function validateAzureStorageAccountUrl(
  value: string | undefined,
  production: boolean,
): string | undefined {
  const accountUrl = value?.trim();
  if (!accountUrl) return undefined;
  let url: URL;
  try {
    url = new URL(accountUrl);
  } catch {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL must be an absolute HTTP(S) URL.");
  }
  if (production && url.protocol !== "https:") {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL must use HTTPS in production.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_URL must not contain credentials, a query, or a fragment.",
    );
  }
  return url.href;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.statusCode === 404;
}
