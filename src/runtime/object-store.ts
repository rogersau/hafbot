export type ObjectStoreBody = ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;

export interface ObjectStorePutOptions {
  contentType?: string | null;
  metadata?: Record<string, string>;
  sizeBytes?: number;
}

export interface ObjectStoreObject {
  key: string;
  body: ReadableStream<Uint8Array>;
  sizeBytes: number;
  contentType: string | null;
  metadata: Record<string, string>;
  etag: string | null;
  uploadedAt: Date | null;
}

export interface ObjectStoreHead {
  key: string;
  sizeBytes: number;
  contentType: string | null;
  metadata: Record<string, string>;
  etag: string | null;
  uploadedAt: Date | null;
}

export interface ObjectStoreListPage {
  objects: ObjectStoreHead[];
  cursor: string | null;
}

export interface ObjectStore {
  put(
    key: string,
    body: ObjectStoreBody,
    options?: ObjectStorePutOptions,
  ): Promise<ObjectStoreHead>;
  get(
    key: string,
    options?: { offset?: number; length?: number },
  ): Promise<ObjectStoreObject | null>;
  head(key: string): Promise<ObjectStoreHead | null>;
  delete(key: string): Promise<void>;
  list(input: {
    prefix: string;
    cursor?: string;
    limit?: number;
    includeMetadata?: boolean;
  }): Promise<ObjectStoreListPage>;
}

const METADATA_PREFIX = "hafm_";

export function encodePortableObjectMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      assertMetadataKey(key);
      assertMetadataValue(value, key);
      return [
        `${METADATA_PREFIX}${toHex(new TextEncoder().encode(key))}`,
        toBase64Url(new TextEncoder().encode(value)),
      ];
    }),
  );
}

export function decodePortableObjectMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  if (!metadata) return {};
  const decoded: Record<string, string> = {};
  for (const [encodedKey, encodedValue] of Object.entries(metadata)) {
    if (!encodedKey.toLowerCase().startsWith(METADATA_PREFIX)) continue;
    const hexadecimal = encodedKey.slice(METADATA_PREFIX.length);
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(hexadecimal)) continue;
    try {
      const key = new TextDecoder().decode(fromHex(hexadecimal));
      const value = new TextDecoder().decode(fromBase64Url(encodedValue));
      if (key) decoded[key] = value;
    } catch {
      // Ignore metadata that was not written by this adapter.
    }
  }
  return decoded;
}

export function validateObjectStoreKey(key: string): void {
  if (
    !key ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    [...key].some((character) => character.codePointAt(0)! < 32)
  ) {
    throw new Error("Object storage key must be a safe relative path.");
  }
}

export function resolveObjectBodySize(body: ObjectStoreBody, declared?: number): number | null {
  let actual: number | null = null;
  if (typeof body === "string") actual = new TextEncoder().encode(body).byteLength;
  else if (body instanceof ArrayBuffer) actual = body.byteLength;
  else if (body instanceof Uint8Array) actual = body.byteLength;
  if (declared !== undefined) {
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new Error("Object storage sizeBytes must be a non-negative safe integer.");
    }
    if (actual !== null && actual !== declared) {
      throw new Error(`Object storage size mismatch: declared ${declared}, actual ${actual}.`);
    }
    return declared;
  }
  return actual;
}

function assertMetadataKey(value: string): void {
  if (!value || new TextEncoder().encode(value).byteLength > 1_024) {
    throw new Error("metadata key must contain between 1 and 1024 UTF-8 bytes.");
  }
}

function assertMetadataValue(value: string, key: string): void {
  if (new TextEncoder().encode(value).byteLength > 1_024) {
    throw new Error(`metadata value for ${key} must contain at most 1024 UTF-8 bytes.`);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (entry) => Number.parseInt(entry, 16));
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
