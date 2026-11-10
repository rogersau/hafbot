export class MemoryR2 {
  #objects = new Map<string, { body: Uint8Array; httpMetadata?: R2HTTPMetadata }>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const body = new Uint8Array(await new Response(value).arrayBuffer());
    this.#objects.set(key, { body, httpMetadata: options?.httpMetadata });
    return {
      key,
      size: body.byteLength,
      etag: `test-${key}`,
      httpEtag: `"test-${key}"`,
      uploaded: new Date(),
      version: "test",
      checksums: {},
    } as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.#objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.body.byteLength,
      etag: `test-${key}`,
      httpEtag: `"test-${key}"`,
      uploaded: new Date(),
      version: "test",
      checksums: {},
      body: new Response(object.body).body!,
      bodyUsed: false,
      arrayBuffer: async () => object.body.buffer.slice(0),
      text: async () => new TextDecoder().decode(object.body),
      json: async <T>() => JSON.parse(new TextDecoder().decode(object.body)) as T,
      blob: async () => new Blob([object.body]),
      writeHttpMetadata: (headers) => {
        if (object.httpMetadata?.contentType)
          headers.set("content-type", object.httpMetadata.contentType);
      },
    } as R2ObjectBody;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.#objects.delete(key);
  }

  asBinding(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
