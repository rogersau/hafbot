import { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

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

export interface S3ObjectStoreEnvironment {
  NODE_ENV?: string;
  S3_BUCKET_NAME?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_FORCE_PATH_STYLE?: string;
}

export function createS3ObjectStoreFromEnvironment(
  environment: S3ObjectStoreEnvironment,
): ObjectStore {
  const bucket = environment.S3_BUCKET_NAME?.trim();
  const region = environment.S3_REGION?.trim();
  if (!bucket || !region) throw new Error("S3_BUCKET_NAME and S3_REGION are required.");
  const endpoint = validateS3Endpoint(
    environment.S3_ENDPOINT,
    environment.NODE_ENV === "production",
  );
  const config: S3ClientConfig = {
    region,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE === "true",
    ...(endpoint ? { endpoint } : {}),
  };
  return createS3ObjectStore(new S3Client(config), bucket);
}

export function createS3ObjectStore(client: Pick<S3Client, "send">, bucket: string): ObjectStore {
  if (!bucket.trim()) throw new Error("S3 bucket name is required.");
  return {
    async put(key, body, options = {}) {
      validateObjectStoreKey(key);
      const sizeBytes = requireBodySize(body, options);
      const response = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: toS3Body(body),
          ContentLength: sizeBytes,
          ContentType: options.contentType ?? undefined,
          Metadata: encodePortableObjectMetadata(options.metadata),
        }),
      );
      return {
        key,
        sizeBytes,
        contentType: options.contentType ?? null,
        metadata: options.metadata ?? {},
        etag: response.ETag ?? null,
        uploadedAt: new Date(),
      };
    },

    async get(key, options = {}) {
      validateObjectStoreKey(key);
      const range = buildRange(options);
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
        );
        if (!response.Body) throw new Error(`S3 object ${key} did not return a body.`);
        return {
          key,
          body: toWebStream(response.Body),
          sizeBytes: response.ContentLength ?? 0,
          contentType: response.ContentType ?? null,
          metadata: decodeS3Metadata(response.Metadata, response.MissingMeta, key),
          etag: response.ETag ?? null,
          uploadedAt: response.LastModified ?? null,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async head(key) {
      validateObjectStoreKey(key);
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          key,
          sizeBytes: response.ContentLength ?? 0,
          contentType: response.ContentType ?? null,
          metadata: decodeS3Metadata(response.Metadata, response.MissingMeta, key),
          etag: response.ETag ?? null,
          uploadedAt: response.LastModified ?? null,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      validateObjectStoreKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async list(input) {
      validateListInput(input.prefix, input.limit);
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: input.prefix,
          ContinuationToken: input.cursor,
          MaxKeys: input.limit ?? 1_000,
        }),
      );
      const objects: ObjectStoreHead[] = [];
      for (const entry of response.Contents ?? []) {
        if (!entry.Key) continue;
        if (input.includeMetadata) {
          const head = await this.head(entry.Key);
          if (head) objects.push(head);
        } else {
          objects.push({
            key: entry.Key,
            sizeBytes: entry.Size ?? 0,
            contentType: null,
            metadata: {},
            etag: entry.ETag ?? null,
            uploadedAt: entry.LastModified ?? null,
          });
        }
      }
      return { objects, cursor: response.NextContinuationToken ?? null };
    },
  };
}

function decodeS3Metadata(
  metadata: Record<string, string> | undefined,
  missingMeta: number | undefined,
  key: string,
): Record<string, string> {
  if (missingMeta !== undefined && missingMeta > 0) {
    throw new Error(
      `S3 omitted ${missingMeta} custom metadata field(s) for ${key}; refusing to read incomplete metadata.`,
    );
  }
  return decodePortableObjectMetadata(metadata);
}

function requireBodySize(body: ObjectStoreBody, options: ObjectStorePutOptions): number {
  const size = resolveObjectBodySize(body, options.sizeBytes);
  if (size === null) throw new Error("Streaming object uploads require sizeBytes.");
  return size;
}

function toS3Body(body: ObjectStoreBody): string | Uint8Array | Readable {
  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (isRecord(body) && typeof body.transformToWebStream === "function") {
    return body.transformToWebStream() as ReadableStream<Uint8Array>;
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  }
  throw new Error("S3 response body is not a supported stream.");
}

function buildRange(input: { offset?: number; length?: number }): string | undefined {
  if (input.offset === undefined && input.length === undefined) return undefined;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Object range offset must be a non-negative integer.");
  }
  if (input.length !== undefined && (!Number.isSafeInteger(input.length) || input.length < 1)) {
    throw new Error("Object range length must be a positive integer.");
  }
  return input.length === undefined
    ? `bytes=${offset}-`
    : `bytes=${offset}-${offset + input.length - 1}`;
}

function validateListInput(prefix: string, limit: number | undefined): void {
  if (prefix.startsWith("/") || prefix.includes("\\")) throw new Error("Invalid object prefix.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)) {
    throw new Error("Object list limit must be between 1 and 1000.");
  }
}

function validateS3Endpoint(value: string | undefined, production: boolean): string | undefined {
  const endpoint = value?.trim();
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("S3_ENDPOINT must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("S3_ENDPOINT must be an absolute HTTP(S) URL.");
  }
  if (production && url.protocol !== "https:") {
    throw new Error("S3_ENDPOINT must use HTTPS in production.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("S3_ENDPOINT must not contain credentials, a query, or a fragment.");
  }
  return url.href;
}

function isNotFound(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      (isRecord(error.$metadata) && error.$metadata.httpStatusCode === 404))
  );
}
