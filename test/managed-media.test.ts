/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  ManagedMediaError,
  ManagedMediaService,
  buildManagedMediaStorageKey,
  parseManagedMediaPath,
} from "../src/managed-media";
import { createPublicRoutes } from "../src/routes/public-routes";
import { createAdminApiHandler } from "./helpers/admin-api";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createSqlitePublicManagedMediaStore } from "./support/sqlite/runtime/sqlite-public-managed-media-store";
import { createPortablePublicManagedMediaStore } from "../src/runtime/portable-blob-stores";

const IMAGE_ID = "11111111-1111-4111-8111-111111111111";
const PNG_BASE64 = "iVBORw0KGgo=";

test("managed media stores release downloads rejected by the visibility boundary", async () => {
  for (const [runtime, errored] of [
    ["sqlite", false],
    ["native", false],
    ["sqlite", true],
    ["native", true],
  ] as const) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (errored) controller.error(new Error("upstream download failed"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const metadata = { visibility: "private", contentClass: "ticket-transcript" };
    const store =
      runtime === "sqlite"
        ? createSqlitePublicManagedMediaStore({
            bucket: { get: async () => ({ body, customMetadata: metadata }) } as never,
            guildEntitlements: {} as never,
            guildR2Objects: {} as never,
          })
        : createPortablePublicManagedMediaStore({
            objects: { get: async () => ({ body, metadata }) } as never,
            guildEntitlements: {} as never,
            guildObjects: {} as never,
          });
    assert.equal(await store.getImage({ guildId: "guild-1", filename: `${IMAGE_ID}.png` }), null);
    assert.equal(cancelled, !errored, runtime);
  }
});

function createBlobStore() {
  const objects = new Map<string, { body: ArrayBuffer; contentType: string; sizeBytes: number }>();
  return {
    objects,
    store: {
      async putImage(input: {
        guildId: string;
        filename: string;
        body: ArrayBuffer;
        contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
        sizeBytes: number;
      }) {
        objects.set(buildManagedMediaStorageKey(input.guildId, input.filename), {
          body: input.body,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
        });
      },
      async getImage(input: { guildId: string; filename: string }) {
        const object = objects.get(buildManagedMediaStorageKey(input.guildId, input.filename));
        return object ? { body: object.body, contentType: object.contentType } : null;
      },
      async deleteImage(input: { guildId: string; filename: string }) {
        objects.delete(buildManagedMediaStorageKey(input.guildId, input.filename));
      },
    },
  };
}

test("Managed Media validates and stores Guild-scoped images", async () => {
  const { objects, store } = createBlobStore();
  const service = new ManagedMediaService(store, () => IMAGE_ID);

  const uploaded = await service.upload({
    guildId: "guild-1",
    contentType: "image/png",
    dataBase64: PNG_BASE64,
    requestOrigin: "https://hafbot.xyz/admin/guilds/guild-1/managed-messages",
  });

  const key = buildManagedMediaStorageKey("guild-1", `${IMAGE_ID}.png`);
  assert.equal(uploaded.url, `https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`);
  assert.equal(uploaded.contentType, "image/png");
  assert.equal(uploaded.sizeBytes, 8);
  assert.equal(objects.get(key)?.contentType, "image/png");
  assert.equal(objects.get(key)?.sizeBytes, 8);
  assert.deepEqual(parseManagedMediaPath(new URL(uploaded.url).pathname), {
    guildId: "guild-1",
    filename: `${IMAGE_ID}.png`,
    key,
  });
});

test("Managed Media paths reject traversal, encoded separators, and malformed filenames", () => {
  for (const pathname of [
    `/managed-media/..%2Fprivate/${IMAGE_ID}.png`,
    `/managed-media/guild-1/${IMAGE_ID}%2Fproof.png`,
    "/managed-media/guild-1/not-a-uuid.png",
    `/managed-media/guild-1/${IMAGE_ID}.html`,
  ]) {
    assert.equal(parseManagedMediaPath(pathname), null);
  }
});

test("Managed Media rejects content that does not match the declared image type", async () => {
  const { store } = createBlobStore();
  const service = new ManagedMediaService(store, () => IMAGE_ID);

  await assert.rejects(
    service.upload({
      guildId: "guild-1",
      contentType: "image/jpeg",
      dataBase64: PNG_BASE64,
      requestOrigin: "https://hafbot.xyz/admin",
    }),
    (error: unknown) =>
      error instanceof ManagedMediaError &&
      error.message === "The uploaded file does not match its image type.",
  );
});

test("Managed Media maps quota failures to a safe Guild-facing error", async () => {
  const service = new ManagedMediaService(
    {
      async putImage() {
        throw new Error("R2 storage quota exceeded for guild guild-1: the 8-byte write cannot fit");
      },
      async getImage() {
        return null;
      },
      async deleteImage() {},
    },
    () => IMAGE_ID,
  );

  await assert.rejects(
    service.upload({
      guildId: "guild-1",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      requestOrigin: "https://hafbot.xyz/admin",
    }),
    (error: unknown) =>
      error instanceof ManagedMediaError &&
      error.message === "This image would exceed the Guild R2 storage quota.",
  );
});

test("Managed Media Admin API uploads through the typed Managed Messages contract", async () => {
  const { objects, store } = createBlobStore();
  const registeredMedia: Array<{ guildId: string; filename: string }> = [];
  const handler = createAdminApiHandler({
    stores: {} as never,
    discordBotToken: "token",
    services: {
      managedMessageService: {
        async registerMediaAsset(guildId: string, filename: string) {
          registeredMedia.push({ guildId, filename });
        },
      } as never,
      managedMediaService: new ManagedMediaService(store, () => IMAGE_ID),
    },
  });
  const request = new Request("https://hafbot.xyz/admin/api/managed-messages/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      guildId: "guild-1",
      filename: "rules.png",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
    }),
  });

  const response = await handler(request, new URL(request.url));

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    media: {
      url: `https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`,
      filename: `${IMAGE_ID}.png`,
      contentType: "image/png",
      sizeBytes: 8,
    },
  });
  assert.ok(objects.has(`guild-1/managed-media/${IMAGE_ID}.png`));
  assert.deepEqual(registeredMedia, [{ guildId: "guild-1", filename: `${IMAGE_ID}.png` }]);
});

test("public routes serve managed images with immutable cache headers", async () => {
  const { store } = createBlobStore();
  await store.putImage({
    guildId: "guild-1",
    filename: `${IMAGE_ID}.png`,
    body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer,
    contentType: "image/png",
    sizeBytes: 4,
  });
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    publicManagedMedia: store,
  });

  const response = await routes(
    new Request(`https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`),
  );

  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("content-type"), "image/png");
  assert.equal(response?.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response?.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(
    new Uint8Array(await response!.arrayBuffer()),
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  );
});

test("public routes do not serve missing or non-image managed objects", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    publicManagedMedia: {
      async putImage() {},
      async getImage() {
        return { body: "not-an-image", contentType: "text/plain" };
      },
      async deleteImage() {},
    },
  });

  const response = await routes(
    new Request(`https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`),
  );

  assert.equal(response?.status, 404);
  assert.deepEqual(await response?.json(), { error: "Not found" });
});

test("public routes cancel managed media streams for HEAD and rejected content types", async () => {
  for (const [method, contentType, status, errored] of [
    ["HEAD", "image/png", 200, false],
    ["GET", "text/html", 404, false],
    ["HEAD", "image/png", 200, true],
    ["GET", "text/html", 404, true],
  ] as const) {
    let cancelled = false;
    const routes = createPublicRoutes({
      features: ALL_FEATURES_ENABLED,
      publicManagedMedia: {
        putImage: async () => {},
        deleteImage: async () => {},
        getImage: async () => ({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              if (errored) controller.error(new Error("upstream download failed"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          contentType,
        }),
      },
    });
    const response = await routes(
      new Request(`https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`, { method }),
    );
    assert.equal(response?.status, status);
    assert.equal(cancelled, !errored);
    if (method === "HEAD") assert.equal(response?.body, null);
  }
});

test("public routes cannot read Managed Media through the Evidence Vault blob capability", async () => {
  let evidenceRead = false;
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    evidenceVaultBlobs: {
      async putImage() {},
      async getImage() {
        evidenceRead = true;
        return { body: "private evidence", contentType: "image/png" };
      },
    },
  });

  const response = await routes(
    new Request(`https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`),
  );

  assert.equal(response?.status, 404);
  assert.equal(evidenceRead, false);
});

test("deleted public Managed Media returns the same generic 404 as a missing object", async () => {
  const { store } = createBlobStore();
  await store.putImage({
    guildId: "guild-1",
    filename: `${IMAGE_ID}.png`,
    body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer,
    contentType: "image/png",
    sizeBytes: 4,
  });
  await store.deleteImage({ guildId: "guild-1", filename: `${IMAGE_ID}.png` });
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED, publicManagedMedia: store });

  const response = await routes(
    new Request(`https://hafbot.xyz/managed-media/guild-1/${IMAGE_ID}.png`),
  );

  assert.equal(response?.status, 404);
  assert.deepEqual(await response?.json(), { error: "Not found" });
});
