import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { createAzureBlobObjectStoreFromEnvironment } from "../src/node/azure-blob-object-store";
import { createMemoryJsonCache } from "../src/node/memory-json-cache";
import {
  createS3ObjectStore,
  createS3ObjectStoreFromEnvironment,
} from "../src/node/s3-object-store";
import {
  decodePortableObjectMetadata,
  encodePortableObjectMetadata,
  resolveObjectBodySize,
  validateObjectStoreKey,
} from "../src/runtime/object-store";
import { InMemoryObjectStore } from "./support/in-memory-object-store";

test("portable object metadata preserves Unicode without exposing provider-invalid keys", () => {
  const metadata = { "Content Class": "ticket/履歴", visibility: "privaté", empty: "" };
  const encoded = encodePortableObjectMetadata(metadata);
  assert.ok(Object.keys(encoded).every((key) => /^[a-z0-9_]+$/.test(key)));
  assert.deepEqual(decodePortableObjectMetadata(encoded), metadata);
  assert.deepEqual(
    decodePortableObjectMetadata({ unrelated: "kept-by-provider", hafm_nothex: "invalid" }),
    {},
  );
});

test("portable object keys and declared sizes reject ambiguous writes", () => {
  for (const key of ["", "/root", "a\\b", "a//b", "a/../b", "a/./b", "control\u0000key"]) {
    assert.throws(() => validateObjectStoreKey(key), /safe relative path/);
  }
  assert.doesNotThrow(() => validateObjectStoreKey("guild/channel/object.bin"));
  assert.equal(resolveObjectBodySize("hello"), 5);
  assert.throws(() => resolveObjectBodySize("hello", 4), /size mismatch/);
});

test("production S3 endpoints cannot expose object credentials over plaintext or URL fields", () => {
  const base = { NODE_ENV: "production", S3_BUCKET_NAME: "objects", S3_REGION: "auto" };
  assert.throws(
    () => createS3ObjectStoreFromEnvironment({ ...base, S3_ENDPOINT: "http://objects.example" }),
    /use HTTPS in production/,
  );
  for (const endpoint of [
    "ftp://objects.example",
    "https://user:secret@objects.example",
    "https://objects.example?credential=secret",
    "https://objects.example/#secret",
  ]) {
    assert.throws(
      () => createS3ObjectStoreFromEnvironment({ ...base, S3_ENDPOINT: endpoint }),
      /HTTP\(S\)|credentials/,
    );
  }
  assert.doesNotThrow(() =>
    createS3ObjectStoreFromEnvironment({
      ...base,
      S3_ENDPOINT: "https://objects.example/account",
      S3_FORCE_PATH_STYLE: "true",
    }),
  );
});

test("production Azure Blob storage requires HTTPS managed identity configuration", () => {
  const base = { NODE_ENV: "production", BLOB_CONTAINER_NAME: "objects" };
  assert.throws(
    () =>
      createAzureBlobObjectStoreFromEnvironment({
        ...base,
        AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      }),
    /not supported in production/,
  );
  assert.throws(
    () =>
      createAzureBlobObjectStoreFromEnvironment({
        ...base,
        AZURE_STORAGE_ACCOUNT_URL: "http://account.blob.core.windows.net",
      }),
    /use HTTPS in production/,
  );
  assert.doesNotThrow(() =>
    createAzureBlobObjectStoreFromEnvironment({
      ...base,
      AZURE_STORAGE_ACCOUNT_URL: "https://account.blob.core.windows.net",
    }),
  );
});

for (const clientId of [undefined, "11111111-2222-4333-8444-555555555555"]) {
  test(`Azure Blob authenticates through DefaultAzureCredential with ${clientId ? "user" : "system"}-assigned managed identity`, async (t) => {
    const requests: Array<{ url: URL; identityHeader: string | string[] | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({
        url: new URL(request.url!, "http://127.0.0.1"),
        identityHeader: request.headers["x-identity-header"],
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "azure-managed-identity-test-token",
          expires_on: String(Math.floor(Date.now() / 1_000) + 3_600),
          token_type: "Bearer",
          resource: "https://storage.azure.com",
          ...(clientId ? { client_id: clientId } : {}),
        }),
      );
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    // A fresh process isolates SDK identity-source caches and prevents local Azure
    // credentials from taking precedence over the controlled App Service endpoint.
    const probe = `
      const assert = require("node:assert/strict");
      const { DefaultAzureCredential } = require("@azure/identity");
      const { BlobServiceClient } = require("@azure/storage-blob");
      const { createAzureBlobObjectStore, createAzureBlobObjectStoreFromEnvironment } = require(process.argv[1]);
      const accountUrl = "https://account.blob.core.windows.net";
      createAzureBlobObjectStoreFromEnvironment({
        NODE_ENV: "production", BLOB_CONTAINER_NAME: "objects", AZURE_STORAGE_ACCOUNT_URL: accountUrl,
      });
      let blobRequests = 0;
      const service = new BlobServiceClient(accountUrl, new DefaultAzureCredential(), {
        httpClient: {
          async sendRequest(request) {
            assert.equal(request.method, "HEAD");
            assert.equal(new URL(request.url).pathname, "/objects/guild/test.txt");
            assert.equal(request.headers.get("authorization"), "Bearer azure-managed-identity-test-token");
            blobRequests++;
            const headers = request.headers.clone();
            headers.set("content-length", "6");
            headers.set("content-type", "text/plain");
            headers.set("x-ms-blob-type", "BlockBlob");
            headers.set("etag", '"fixture-etag"');
            return { request, status: 200, headers };
          },
        },
      });
      (async () => {
        const store = createAzureBlobObjectStore(service.getContainerClient("objects"));
        for (let i = 0; i < 2; i++) {
          const head = await store.head("guild/test.txt");
          assert.equal(head.sizeBytes, 6);
          assert.equal(head.contentType, "text/plain");
          assert.equal(head.etag, '"fixture-etag"');
        }
        assert.equal(blobRequests, 2);
        console.log("Managed identity Blob requests passed");
      })().catch(() => { console.error("Managed identity Blob probe failed"); process.exitCode = 1; });
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["-e", probe, require.resolve("../src/node/azure-blob-object-store")],
      {
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          IDENTITY_ENDPOINT: `http://127.0.0.1:${address.port}/metadata/identity/oauth2/token`,
          IDENTITY_HEADER: "azure-test-identity-header",
          ...(clientId ? { AZURE_CLIENT_ID: clientId } : {}),
        },
      },
    );
    assert.match(stdout, /Managed identity Blob requests passed/);
    assert.equal(requests.length, 1, "the managed identity token is cached between Blob requests");
    assert.equal(requests[0].url.pathname, "/metadata/identity/oauth2/token");
    assert.equal(requests[0].url.searchParams.get("resource"), "https://storage.azure.com");
    assert.equal(requests[0].url.searchParams.get("client_id"), clientId ?? null);
    assert.equal(requests[0].identityHeader, "azure-test-identity-header");
  });
}

test("S3 head and get round-trip canonical portable metadata", async () => {
  const metadata = { "Content Class": "ticket/履歴", visibility: "private" };
  const encoded = encodePortableObjectMetadata(metadata);
  const objectResponse = {
    ContentLength: 7,
    ContentType: "text/plain",
    LastModified: new Date("2026-08-14T00:00:00Z"),
    Metadata: encoded,
    MissingMeta: 0,
    ETag: '"fixture-etag"',
  };
  const responses = [
    objectResponse,
    {
      ...objectResponse,
      Body: Readable.from([Buffer.from("payload")]),
    },
  ];
  const client = {
    async send() {
      return responses.shift();
    },
  };
  const store = createS3ObjectStore(client as never, "objects");

  const head = await store.head("guild/object.txt");
  assert.deepEqual(head?.metadata, metadata);
  const object = await store.get("guild/object.txt");
  assert.deepEqual(object?.metadata, metadata);
  assert.equal(await new Response(object!.body).text(), "payload");
});

test("S3 rejects responses that omit custom metadata instead of returning incomplete security metadata", async () => {
  const responses = [
    { ContentLength: 7, Metadata: {}, MissingMeta: 1 },
    {
      ContentLength: 7,
      Metadata: {},
      MissingMeta: 1,
      Body: Readable.from([Buffer.from("payload")]),
    },
  ];
  const client = {
    async send() {
      return responses.shift();
    },
  };
  const store = createS3ObjectStore(client as never, "objects");

  await assert.rejects(store.head("guild/object.txt"), /omitted 1 custom metadata field/);
  await assert.rejects(store.get("guild/object.txt"), /omitted 1 custom metadata field/);
});

test("object-store contract supports streams, ranges, listing, and idempotent deletion", async () => {
  const store = new InMemoryObjectStore();
  await store.put("guild/a.txt", new Blob(["abcdef"]).stream(), {
    sizeBytes: 6,
    contentType: "text/plain",
    metadata: { visibility: "private" },
  });
  await store.put("guild/b.txt", "second");
  assert.equal(
    await new Response((await store.get("guild/a.txt", { offset: 2, length: 3 }))!.body).text(),
    "cde",
  );
  assert.deepEqual(
    (await store.list({ prefix: "guild/", limit: 1 })).objects.map(({ key }) => key),
    ["guild/a.txt"],
  );
  const first = await store.list({ prefix: "guild/", limit: 1 });
  assert.deepEqual(
    (await store.list({ prefix: "guild/", cursor: first.cursor!, limit: 1 })).objects.map(
      ({ key }) => key,
    ),
    ["guild/b.txt"],
  );
  await store.delete("guild/a.txt");
  await store.delete("guild/a.txt");
  assert.equal(await store.head("guild/a.txt"), null);
});

test("memory JSON cache is TTL-aware, LRU-bounded, and isolates object mutations", async () => {
  let nowMs = 1_000;
  const cache = createMemoryJsonCache<{ value: number }>({
    maxEntries: 2,
    maxBytes: 1_000,
    now: () => nowMs,
  });
  const original = { value: 1 };
  await cache.put("a", original, { ttlSeconds: 1 });
  original.value = 99;
  assert.deepEqual(await cache.get("a"), { value: 1 });
  await cache.put("b", { value: 2 });
  await cache.put("c", { value: 3 });
  assert.equal(await cache.get("a"), null);
  assert.deepEqual(await cache.get("c"), { value: 3 });
  nowMs = 2_001;
  await cache.put("expiring", { value: 4 }, { ttlSeconds: 1 });
  nowMs = 3_002;
  assert.equal(await cache.get("expiring"), null);
});
