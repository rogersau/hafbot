import { asc, eq } from "drizzle-orm";
import {
  evidenceVaultConfigs,
  evidenceVaultRecords,
  identityPatterns,
} from "../../db/postgres/app-schema";
import type { IdentityPattern, EvidenceVaultRecord } from "../../types";
import type { EvidenceVaultStore } from "../contracts/evidence-vault-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";
type EvidenceDatabase = PostgresDatabaseCapability["drizzle"];

import {
  mapConfigRow,
  configToRow,
  recordToRow,
  mapRecordRow,
  mapIdentityPatternRow,
  patternToRow,
} from "../evidence-vault-records";

export function createPostgresEvidenceVaultStore(
  database: PostgresDatabaseCapability,
): EvidenceVaultStore {
  const db = database.drizzle;
  const store: EvidenceVaultStore = {
    async setEnabled(guildId: string, enabled: boolean): Promise<boolean> {
      const result = await db
        .update(evidenceVaultConfigs)
        .set({ enabled: enabled ? 1 : 0, updatedAtMs: Date.now() })
        .where(eq(evidenceVaultConfigs.guildId, guildId))
        .execute();
      return (result.rowCount ?? 0) > 0;
    },

    async readConfig(guildId) {
      const row = await db
        .select()
        .from(evidenceVaultConfigs)
        .where(eq(evidenceVaultConfigs.guildId, guildId))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? mapConfigRow(row) : null;
    },

    async upsertConfig(config) {
      const values = configToRow(config);
      await db
        .insert(evidenceVaultConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: evidenceVaultConfigs.guildId,
          set: {
            auditChannelId: values.auditChannelId,
            accessRoleIdsJson: values.accessRoleIdsJson,
            subjectsEnabled: values.subjectsEnabled,
            fieldsJson: values.fieldsJson,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .execute();
    },

    async createRecord(record) {
      await db.insert(evidenceVaultRecords).values(recordToRow(record)).execute();
    },

    async readRecord(recordId) {
      const row = await db
        .select()
        .from(evidenceVaultRecords)
        .where(eq(evidenceVaultRecords.recordId, recordId))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? mapRecordRow(row) : null;
    },

    async listRecords(guildId) {
      const rows = await db
        .select()
        .from(evidenceVaultRecords)
        .where(eq(evidenceVaultRecords.guildId, guildId))
        .orderBy(asc(evidenceVaultRecords.hiddenAtMs));
      return rows.map(mapRecordRow).sort((left, right) => right.hiddenAtMs - left.hiddenAtMs);
    },

    async searchRecordsBySubject(guildId, subject) {
      return (await this.listRecords(guildId)).filter((record) =>
        record.subjectUserIds.some(
          (entry) => entry.platform === subject.platform && entry.id === subject.id,
        ),
      );
    },

    async updateRecordStatus(recordId, status) {
      await patchRecord(database, recordId, { status });
    },
    async updateRecordSubjects(recordId, subjects) {
      await patchRecord(database, recordId, { subjectUserIds: subjects });
    },
    async updateRecordEvidenceFieldValues(recordId, values) {
      await patchRecord(database, recordId, { evidenceFieldValues: values });
    },
    async updateRecordPlaceholder(recordId, placeholder) {
      await patchRecord(database, recordId, {
        placeholderChannelId: placeholder.channelId,
        placeholderMessageId: placeholder.messageId,
        status: placeholder.status,
      });
    },

    async readImage(recordId, imageId) {
      const record = await this.readRecord(recordId);
      const image = record?.images.find((entry) => entry.id === imageId) ?? null;
      return image ? { r2Key: image.r2Key, contentType: image.contentType } : null;
    },

    async listEnabledIdentityPatterns() {
      return (await listPatterns(db)).filter((pattern) => !pattern.disabled);
    },

    async listIdentityPatterns() {
      return listPatterns(db);
    },

    async addIdentityPattern(input) {
      const current = await listPatterns(db);
      const nextPosition = current.reduce((max, pattern) => Math.max(max, pattern.position), 0) + 1;
      const pattern: IdentityPattern = {
        ...input,
        id: crypto.randomUUID().replace(/-/g, ""),
        position: nextPosition,
        disabled: false,
        createdAtMs: Date.now(),
      };
      await db.insert(identityPatterns).values(patternToRow(pattern)).execute();
      return pattern;
    },

    async disableIdentityPattern(id) {
      const row = await db
        .select()
        .from(identityPatterns)
        .where(eq(identityPatterns.id, id))
        .limit(1)
        .then((rows) => rows[0]);
      if (!row) return false;
      await db
        .update(identityPatterns)
        .set({ disabled: true })
        .where(eq(identityPatterns.id, id))
        .execute();
      return true;
    },
  };

  return store;
}

async function listPatterns(database: EvidenceDatabase): Promise<IdentityPattern[]> {
  const rows = await database
    .select()
    .from(identityPatterns)
    .orderBy(asc(identityPatterns.disabled), asc(identityPatterns.position));
  return rows.map(mapIdentityPatternRow);
}

type EvidenceRecordPatch = Partial<
  Pick<
    EvidenceVaultRecord,
    | "status"
    | "subjectUserIds"
    | "evidenceFieldValues"
    | "placeholderChannelId"
    | "placeholderMessageId"
  >
>;

async function patchRecord(
  database: PostgresDatabaseCapability,
  recordId: string,
  patch: EvidenceRecordPatch,
): Promise<void> {
  await database.execute(
    `UPDATE evidence_vault_records
    SET payload_json = (payload_json::jsonb || $2::jsonb)::text,
        status = COALESCE($3::text, status)
    WHERE record_id = $1`,
    [recordId, JSON.stringify(patch), patch.status ?? null],
  );
}
