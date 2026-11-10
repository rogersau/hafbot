/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareEvidenceVaultStore } from "../src/runtime/cloudflare-evidence-vault-store";
import type { EvidenceVaultConfig, EvidenceVaultRecord } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareEvidenceVaultStore reads and writes Evidence Vault config", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEvidenceVaultStore(database as unknown as D1Database);

  assert.equal(await store.readConfig("guild-1"), null);

  const config: EvidenceVaultConfig = {
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    accessRoleIds: ["staff-role-1", "staff-role-2"],
    subjectsEnabled: true,
    evidenceFields: [
      { key: "field_type", label: "Evidence type", type: "enum", allowedValues: ["video"] },
      { key: "case_ref", label: "Case reference", type: "short_text" },
    ],
    updatedAtMs: 100,
  };
  await store.upsertConfig(config);

  assert.deepEqual(await store.readConfig("guild-1"), config);

  const updated: EvidenceVaultConfig = {
    guildId: "guild-1",
    auditChannelId: "audit-channel-2",
    accessRoleIds: [],
    subjectsEnabled: false,
    evidenceFields: [],
    updatedAtMs: 200,
  };
  await store.upsertConfig(updated);

  assert.deepEqual(await store.readConfig("guild-1"), updated);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareEvidenceVaultStore reads and writes hidden evidence records", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEvidenceVaultStore(database as unknown as D1Database);
  const record = buildEvidenceVaultRecord();

  assert.equal(await store.readRecord("record-1"), null);
  assert.equal(await store.readImage("record-1", "image-1"), null);

  await store.createRecord(record);

  assert.deepEqual(await store.readRecord("record-1"), record);
  assert.deepEqual(await store.readImage("record-1", "image-1"), {
    r2Key: "guild-1/evidence/record-1/image-1",
    contentType: "image/png",
  });
  assert.equal(await store.readImage("record-1", "missing-image"), null);

  await store.updateRecordPlaceholder("record-1", {
    channelId: "placeholder-channel-1",
    messageId: "placeholder-message-1",
    status: "active",
  });

  assert.deepEqual(await store.readRecord("record-1"), {
    ...record,
    placeholderChannelId: "placeholder-channel-1",
    placeholderMessageId: "placeholder-message-1",
  });

  await store.updateRecordStatus("record-1", "source-delete-failed");

  assert.deepEqual(await store.readRecord("record-1"), {
    ...record,
    status: "source-delete-failed",
    placeholderChannelId: "placeholder-channel-1",
    placeholderMessageId: "placeholder-message-1",
  });

  await store.updateRecordStatus("missing-record", "placeholder-post-failed");
  await store.updateRecordPlaceholder("missing-record", {
    channelId: "placeholder-channel-2",
    messageId: "placeholder-message-2",
    status: "placeholder-post-failed",
  });

  assert.equal(await store.readRecord("missing-record"), null);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareEvidenceVaultStore searches and amends subjects", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEvidenceVaultStore(database as unknown as D1Database);
  await store.createRecord(buildEvidenceVaultRecord({ id: "old", hiddenAtMs: 100 }));
  await store.createRecord(buildEvidenceVaultRecord({ id: "new", hiddenAtMs: 200 }));
  await store.createRecord(
    buildEvidenceVaultRecord({
      id: "other",
      hiddenAtMs: 300,
      subjectUserIds: [{ platform: "discord", id: "123456789012345678" }],
    }),
  );

  assert.deepEqual(
    (
      await store.searchRecordsBySubject("guild-1", { platform: "steam", id: "76561198000000000" })
    ).map((record) => record.id),
    ["new", "old"],
  );

  await store.updateRecordSubjects("old", [{ platform: "discord", id: "123456789012345678" }]);
  assert.deepEqual((await store.readRecord("old"))?.subjectUserIds, [
    { platform: "discord", id: "123456789012345678" },
  ]);

  await store.updateRecordEvidenceFieldValues("old", [
    { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
  ]);
  assert.deepEqual((await store.readRecord("old"))?.evidenceFieldValues, [
    { key: "case_ref", label: "Case reference", type: "short_text", value: "CASE-123" },
  ]);
  assert.deepEqual(
    (await store.listRecords("guild-1")).map((record) => record.id),
    ["other", "new", "old"],
  );
});

test("createCloudflareEvidenceVaultStore lists adds and disables identity patterns", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEvidenceVaultStore(database as unknown as D1Database);

  const seeded = await store.listEnabledIdentityPatterns();
  assert.equal(seeded[0]?.id, "seed-steam-profile-url");

  const added = await store.addIdentityPattern({
    platform: "discord",
    pattern: "discord.example/(\\d+)",
    captureGroup: 1,
  });
  assert.equal(added.position > seeded[seeded.length - 1]!.position, true);
  assert.equal(await store.disableIdentityPattern(added.id), true);
  assert.equal(await store.disableIdentityPattern("missing"), false);
  assert.equal(
    (await store.listEnabledIdentityPatterns()).some((pattern) => pattern.id === added.id),
    false,
  );
  assert.equal(
    (await store.listIdentityPatterns()).some(
      (pattern) => pattern.id === added.id && pattern.disabled,
    ),
    true,
  );
});

function buildEvidenceVaultRecord(
  overrides: Partial<EvidenceVaultRecord> = {},
): EvidenceVaultRecord {
  return {
    id: "record-1",
    guildId: "guild-1",
    sourceChannelId: "source-channel-1",
    sourceMessageId: "source-message-1",
    sourceAuthorId: "author-1",
    sourceAuthorDisplayName: "Author",
    sourceMessageTimestamp: "2026-05-30T12:00:00.000Z",
    hiderId: "hider-1",
    hiderDisplayName: "Hider",
    hiddenAtMs: 300,
    status: "active",
    sourceText: "hidden evidence text",
    links: ["https://example.com/report"],
    images: [
      {
        id: "image-1",
        filename: "proof.png",
        contentType: "image/png",
        sizeBytes: 1234,
        r2Key: "guild-1/evidence/record-1/image-1",
        url: "/evidence-vault/images/record-1/image-1",
      },
    ],
    totalImageBytes: 1234,
    placeholderChannelId: null,
    placeholderMessageId: null,
    subjectUserIds: [{ platform: "steam", id: "76561198000000000" }],
    subjectsEnabled: true,
    evidenceFieldValues: [],
    ...overrides,
  };
}
