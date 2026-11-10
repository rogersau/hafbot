/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  verdictFromConfidences,
  worstVerdictOf,
  selectImagesForClassification,
  type ClassifiableImage,
} from "../src/services/image-rules/verdict";

const THRESHOLDS = { autoDeleteThreshold: 0.85, modReviewThreshold: 0.65 };

function makeAttachment(overrides: Partial<ClassifiableImage> = {}): ClassifiableImage {
  return {
    id: "attachment-1",
    url: "https://cdn.discordapp.com/attachments/1/1/image.png",
    contentType: "image/png",
    sizeBytes: 1000,
    ...overrides,
  };
}

test("verdictFromConfidences returns off-topic at or above auto-delete threshold", () => {
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.85, on_topic_confidence: 0.15 }, THRESHOLDS),
    "off-topic",
  );
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.9, on_topic_confidence: 0.1 }, THRESHOLDS),
    "off-topic",
  );
});

test("verdictFromConfidences returns uncertain at or above mod-review but below auto-delete threshold", () => {
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.65, on_topic_confidence: 0.35 }, THRESHOLDS),
    "uncertain",
  );
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.7, on_topic_confidence: 0.3 }, THRESHOLDS),
    "uncertain",
  );
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.84, on_topic_confidence: 0.16 }, THRESHOLDS),
    "uncertain",
  );
});

test("verdictFromConfidences returns on-topic below mod-review threshold", () => {
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.0, on_topic_confidence: 1.0 }, THRESHOLDS),
    "on-topic",
  );
  assert.equal(
    verdictFromConfidences({ off_topic_confidence: 0.64, on_topic_confidence: 0.36 }, THRESHOLDS),
    "on-topic",
  );
});

test("worstVerdictOf prefers off-topic over uncertain and on-topic", () => {
  assert.equal(worstVerdictOf(["on-topic", "uncertain", "off-topic"]), "off-topic");
  assert.equal(worstVerdictOf(["off-topic", "on-topic"]), "off-topic");
});

test("worstVerdictOf prefers uncertain over on-topic", () => {
  assert.equal(worstVerdictOf(["on-topic", "uncertain", "on-topic"]), "uncertain");
  assert.equal(worstVerdictOf(["uncertain"]), "uncertain");
});

test("worstVerdictOf returns on-topic when all verdicts are on-topic", () => {
  assert.equal(worstVerdictOf(["on-topic", "on-topic"]), "on-topic");
});

test("worstVerdictOf returns on-topic for an empty array", () => {
  assert.equal(worstVerdictOf([]), "on-topic");
});

test("selectImagesForClassification keeps supported images within limits", () => {
  const attachments: ClassifiableImage[] = [
    makeAttachment({
      id: "a1",
      contentType: "image/png",
      sizeBytes: 1000,
      width: 100,
      height: 100,
    }),
    makeAttachment({ id: "a2", contentType: "image/jpeg", sizeBytes: 2000 }),
    makeAttachment({
      id: "a3",
      contentType: "image/webp",
      sizeBytes: 3000,
      width: 4096,
      height: 100,
    }),
    makeAttachment({
      id: "a4",
      contentType: "image/gif",
      sizeBytes: 4000,
      width: 100,
      height: 4096,
    }),
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 5000,
    maxDimension: 4096,
  });

  assert.deepEqual(
    selected.map((image) => image.id),
    ["a1", "a2", "a3", "a4"],
  );
});

test("selectImagesForClassification skips non-image attachments", () => {
  const attachments = [
    makeAttachment({ id: "a1", contentType: "text/plain", sizeBytes: 100 }),
    makeAttachment({ id: "a2", contentType: "video/mp4", sizeBytes: 100 }),
    makeAttachment({ id: "a3", contentType: "application/pdf", sizeBytes: 100 }),
    { id: "a4", url: "https://example.com/file", filename: "file.txt", size: 100 },
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.deepEqual(
    selected.map((image) => image.id),
    [],
  );
});

test("selectImagesForClassification rejects unsupported image formats", () => {
  const attachments = [
    makeAttachment({ id: "a1", contentType: "image/bmp", sizeBytes: 100 }),
    makeAttachment({ id: "a2", contentType: "image/svg+xml", sizeBytes: 100 }),
    makeAttachment({ id: "a3", contentType: "image/tiff", sizeBytes: 100 }),
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.deepEqual(
    selected.map((image) => image.id),
    [],
  );
});

test("selectImagesForClassification skips oversized images", () => {
  const attachments = [
    makeAttachment({ id: "a1", contentType: "image/png", sizeBytes: 1000 }),
    makeAttachment({ id: "a2", contentType: "image/png", sizeBytes: 10_001 }),
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.deepEqual(
    selected.map((image) => image.id),
    ["a1"],
  );
});

test("selectImagesForClassification skips images exceeding dimension limits", () => {
  const attachments = [
    makeAttachment({
      id: "a1",
      contentType: "image/png",
      sizeBytes: 1000,
      width: 100,
      height: 100,
    }),
    makeAttachment({
      id: "a2",
      contentType: "image/png",
      sizeBytes: 1000,
      width: 4097,
      height: 100,
    }),
    makeAttachment({
      id: "a3",
      contentType: "image/png",
      sizeBytes: 1000,
      width: 100,
      height: 4097,
    }),
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.deepEqual(
    selected.map((image) => image.id),
    ["a1"],
  );
});

test("selectImagesForClassification allows images with missing dimensions", () => {
  const attachments = [makeAttachment({ id: "a1", contentType: "image/png", sizeBytes: 1000 })];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, "a1");
});

test("selectImagesForClassification maps Discord-style attachment fields", () => {
  const attachments = [
    {
      id: "discord-1",
      url: "https://cdn.discordapp.com/attachments/1/1/image.png",
      proxy_url: "https://media.discordapp.net/attachments/1/1/image.png",
      content_type: "image/png",
      size: 2048,
      width: 512,
      height: 512,
    },
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.equal(selected.length, 1);
  const image = selected[0] as ClassifiableImage;
  assert.equal(image.id, "discord-1");
  assert.equal(image.url, "https://cdn.discordapp.com/attachments/1/1/image.png");
  assert.equal(image.proxyUrl, "https://media.discordapp.net/attachments/1/1/image.png");
  assert.equal(image.contentType, "image/png");
  assert.equal(image.sizeBytes, 2048);
  assert.equal(image.width, 512);
  assert.equal(image.height, 512);
});

test("selectImagesForClassification has no side effects on unsupported input", () => {
  const attachments = [
    null,
    undefined,
    "not-an-object",
    123,
    {},
    { id: "no-url" },
    { url: "no-id" },
  ];

  const selected = selectImagesForClassification(attachments, {
    maxBytes: 10_000,
    maxDimension: 4096,
  });

  assert.deepEqual(selected, []);
});
