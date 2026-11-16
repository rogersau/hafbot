/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createPublicRoutes } from "../src/routes/public-routes";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createEvidenceMediaCapability } from "../src/security/evidence-media-capability";

test("public routes serve Evidence Vault images only with a scoped capability", async () => {
  let cancelled = 0;
  const capability = createEvidenceMediaCapability("test-evidence-secret", {
    now: () => 1_000_000,
  });
  const access = await capability.issue({
    guildId: "guild-1",
    recordId: "record",
    imageId: "image",
    expiresAtSeconds: 1_600,
  });
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    evidenceMediaCapability: capability,
    evidenceVaultStore: {
      readRecord: async () => ({
        id: "record",
        guildId: "guild-1",
        status: "active",
        images: [
          {
            id: "image",
            filename: "proof.png",
            contentType: "image/png",
            sizeBytes: 11,
            r2Key: "guild-1/evidence-vault/record/images/image/proof.png",
          },
        ],
      }),
    } as never,
    evidenceVaultBlobs: {
      putImage: async () => {},
      getImage: async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("image-bytes"));
          },
          pull(controller) {
            controller.close();
          },
          cancel() {
            cancelled += 1;
          },
        }),
        contentType: "image/png",
      }),
      deleteImage: async () => {},
    },
  });

  const response = await routes(
    new Request(`https://worker.example/evidence-vault/images/record/image?access=${access}`),
  );

  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("content-type"), "image/png");
  assert.equal(await response?.text(), "image-bytes");
  assert.equal(cancelled, 0);
  const head = await routes(
    new Request(`https://worker.example/evidence-vault/images/record/image?access=${access}`, {
      method: "HEAD",
    }),
  );
  assert.equal(head?.status, 200);
  assert.equal(head?.headers.get("content-type"), "image/png");
  assert.equal(head?.body, null);
  assert.equal(cancelled, 1);
});

test("public routes return safe not found for unknown Evidence Vault images", async () => {
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    evidenceVaultStore: { readRecord: async () => null } as never,
    evidenceVaultBlobs: {
      putImage: async () => {},
      getImage: async () => null,
      deleteImage: async () => {},
    },
  });

  const response = await routes(
    new Request("https://worker.example/evidence-vault/images/missing/image"),
  );

  assert.equal(response?.status, 404);
  assert.deepEqual(await response?.json(), { error: "Not found" });
});
