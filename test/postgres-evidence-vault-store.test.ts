import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceVaultConfig, EvidenceVaultRecord } from "../src/types";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresEvidenceVaultStore } from "../src/runtime/postgres/postgres-evidence-vault-store";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "native PostgreSQL Evidence Vault persists roles, private metadata and concurrent record updates",
  {
    skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured",
  },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
      throw new Error("PostgreSQL integration tests require a local database ending in _test.");
    }
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await initializePostgresSchema(database);
      const store = createPostgresEvidenceVaultStore(database);
      const config: EvidenceVaultConfig = {
        guildId: "guild-1",
        auditChannelId: "audit",
        accessRoleIds: ["role-1", "role-2"],
        subjectsEnabled: true,
        evidenceFields: [{ key: "reason", label: "Reason", type: "text" }],
        updatedAtMs: 1_800_000_000_000,
      };
      await store.upsertConfig(config);
      assert.deepEqual(await store.readConfig("guild-1"), config);
      assert.equal(await store.readConfig("guild-2"), null);
      await store.upsertConfig({ ...config, accessRoleIds: [], subjectsEnabled: false });
      assert.deepEqual((await store.readConfig("guild-1"))?.accessRoleIds, []);
      assert.equal((await store.readConfig("guild-1"))?.subjectsEnabled, false);
      assert.equal(await store.setEnabled!("guild-1", false), true);
      assert.equal((await store.readConfig("guild-1"))?.enabled, false);
      assert.equal(await store.setEnabled!("guild-2", false), false);

      const record: EvidenceVaultRecord = {
        id: "record-1",
        guildId: "guild-1",
        sourceChannelId: "source",
        sourceMessageId: "message",
        sourceAuthorId: "author",
        sourceAuthorDisplayName: "Author",
        sourceMessageTimestamp: null,
        hiderId: "staff",
        hiderDisplayName: "Staff",
        hiddenAtMs: 1_800_000_000_000,
        status: "active",
        sourceText: "Private evidence",
        links: [],
        images: [
          {
            id: "image-1",
            filename: "proof.png",
            contentType: "image/png",
            sizeBytes: 4,
            r2Key: "guild-1/evidence/record-1/image-1",
          },
        ],
        totalImageBytes: 4,
        placeholderChannelId: null,
        placeholderMessageId: null,
        subjectUserIds: [{ platform: "steam", id: "76561198000000001" }],
        subjectsEnabled: true,
        evidenceFieldValues: [],
      };
      await store.createRecord(record);
      await store.createRecord({ ...record, id: "other-guild", guildId: "guild-2" });
      assert.deepEqual(await store.readRecord("record-1"), record);
      assert.deepEqual(
        (await store.listRecords("guild-1")).map(({ id }) => id),
        ["record-1"],
      );
      assert.deepEqual(await store.readImage("record-1", "image-1"), {
        r2Key: record.images[0].r2Key,
        contentType: "image/png",
      });
      assert.equal(await store.readImage("record-1", "unknown"), null);
      const subject = { platform: "discord" as const, id: "member" };
      const fields = [{ key: "reason", label: "Reason", type: "text" as const, value: "Report" }];
      await Promise.all([
        store.updateRecordStatus("record-1", "source-delete-failed"),
        store.updateRecordSubjects("record-1", [subject]),
        store.updateRecordEvidenceFieldValues("record-1", fields),
      ]);
      const updated = await store.readRecord("record-1");
      assert.equal(updated?.status, "source-delete-failed");
      assert.deepEqual(updated?.subjectUserIds, [subject]);
      assert.deepEqual(updated?.evidenceFieldValues, fields);
      assert.equal(updated?.sourceText, record.sourceText);
      assert.equal((await store.searchRecordsBySubject("guild-1", subject)).length, 1);
      assert.equal((await store.searchRecordsBySubject("guild-2", subject)).length, 0);
      await store.updateRecordPlaceholder("record-1", {
        channelId: "placeholder",
        messageId: "notice",
        status: "placeholder-post-failed",
      });
      const reconstructed = createPostgresEvidenceVaultStore(database);
      assert.equal((await reconstructed.readRecord("record-1"))?.placeholderMessageId, "notice");
      const builtins = await store.listEnabledIdentityPatterns();
      assert.equal(builtins.length, 6);
      const steamProfile = builtins.find((pattern) => pattern.id === "seed-steam-profile-url")!;
      assert.equal(
        new RegExp(steamProfile.pattern).exec(
          "https://steamcommunity.com/profiles/76561198000000001",
        )?.[steamProfile.captureGroup],
        "76561198000000001",
      );
      const pattern = await store.addIdentityPattern({
        platform: "steam",
        pattern: "Steam: (\\d+)",
        captureGroup: 1,
      });
      assert.equal(
        (await store.listEnabledIdentityPatterns()).some(({ id }) => id === pattern.id),
        true,
      );
      assert.equal(await store.disableIdentityPattern(pattern.id), true);
      assert.deepEqual(await store.listEnabledIdentityPatterns(), builtins);
      assert.equal(
        (await store.listIdentityPatterns()).find((item) => item.id === pattern.id)?.disabled,
        true,
      );
    } finally {
      await database.close();
    }
  },
);
