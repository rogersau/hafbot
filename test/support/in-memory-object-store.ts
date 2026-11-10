import {
  resolveObjectBodySize,
  validateObjectStoreKey,
  type ObjectStore,
  type ObjectStoreBody,
  type ObjectStoreHead,
  type ObjectStorePutOptions,
} from "../../src/runtime/object-store";

interface StoredObject extends ObjectStoreHead {
  bytes: Uint8Array;
}

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  #clock = 0;

  async put(
    key: string,
    body: ObjectStoreBody,
    options: ObjectStorePutOptions = {},
  ): Promise<ObjectStoreHead> {
    validateObjectStoreKey(key);
    const bytes = await bodyToBytes(body);
    resolveObjectBodySize(bytes, options.sizeBytes);
    const object: StoredObject = {
      key,
      bytes,
      sizeBytes: bytes.byteLength,
      contentType: options.contentType ?? null,
      metadata: { ...options.metadata },
      etag: `memory-${++this.#clock}`,
      uploadedAt: new Date(Date.UTC(2026, 7, 20, 0, 0, this.#clock)),
    };
    this.objects.set(key, object);
    return copyHead(object);
  }

  async get(key: string, options: { offset?: number; length?: number } = {}) {
    validateObjectStoreKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const offset = options.offset ?? 0;
    const end = options.length === undefined ? undefined : offset + options.length;
    const bytes = object.bytes.slice(offset, end);
    return {
      ...copyHead(object),
      sizeBytes: bytes.byteLength,
      body: new Blob([bytes]).stream(),
    };
  }

  async head(key: string) {
    validateObjectStoreKey(key);
    const object = this.objects.get(key);
    return object ? copyHead(object) : null;
  }

  async delete(key: string): Promise<void> {
    validateObjectStoreKey(key);
    this.objects.delete(key);
  }

  async list(input: { prefix: string; cursor?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(input.prefix)).sort();
    const start = input.cursor ? keys.findIndex((key) => key > input.cursor!) : 0;
    const normalizedStart = start < 0 ? keys.length : start;
    const limit = input.limit ?? 1_000;
    const selected = keys.slice(normalizedStart, normalizedStart + limit);
    const hasMore = normalizedStart + selected.length < keys.length;
    return {
      objects: selected.map((key) => copyHead(this.objects.get(key)!)),
      cursor: hasMore ? selected.at(-1)! : null,
    };
  }
}

async function bodyToBytes(body: ObjectStoreBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function copyHead(object: StoredObject): ObjectStoreHead {
  return {
    key: object.key,
    sizeBytes: object.sizeBytes,
    contentType: object.contentType,
    metadata: { ...object.metadata },
    etag: object.etag,
    uploadedAt: object.uploadedAt ? new Date(object.uploadedAt) : null,
  };
}
