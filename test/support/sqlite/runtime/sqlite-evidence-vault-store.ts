import { asc, eq } from "drizzle-orm";
import { evidenceVaultConfigs, evidenceVaultRecords, identityPatterns } from "../db/app-schema";
import type { IdentityPattern, EvidenceVaultRecord } from "../../../../src/types";
import type { EvidenceVaultStore } from "../../../../src/runtime/contracts/evidence-vault-store";
import { createD1DrizzleDatabase, type AppDrizzleDatabase } from "./drizzle-db";

import {
  mapConfigRow,
  configToRow,
  recordToRow,
  mapRecordRow,
  mapIdentityPatternRow,
  patternToRow,
} from "../../../../src/runtime/evidence-vault-records";

const storeCache = new WeakMap<D1Database, EvidenceVaultStore>();

export function createSqliteEvidenceVaultStore(database: D1Database): EvidenceVaultStore {
  const cached = storeCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: EvidenceVaultStore = {
    async setEnabled(guildId: string, enabled: boolean): Promise<boolean> {
      const result = await db
        .update(evidenceVaultConfigs)
        .set({ enabled: enabled ? 1 : 0, updatedAtMs: Date.now() })
        .where(eq(evidenceVaultConfigs.guildId, guildId))
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async readConfig(guildId) {
      const row = await db
        .select()
        .from(evidenceVaultConfigs)
        .where(eq(evidenceVaultConfigs.guildId, guildId))
        .limit(1)
        .get();
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
        .run();
    },

    async createRecord(record) {
      await db.insert(evidenceVaultRecords).values(recordToRow(record)).run();
    },

    async readRecord(recordId) {
      const row = await db
        .select()
        .from(evidenceVaultRecords)
        .where(eq(evidenceVaultRecords.recordId, recordId))
        .limit(1)
        .get();
      return row ? mapRecordRow(row) : null;
    },

    async listRecords(guildId) {
      const rows = await db
        .select()
        .from(evidenceVaultRecords)
        .where(eq(evidenceVaultRecords.guildId, guildId))
        .orderBy(asc(evidenceVaultRecords.hiddenAtMs))
        .all();
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
      const record = await this.readRecord(recordId);
      if (!record) return;
      record.status = status;
      await writeRecord(db, record);
    },

    async updateRecordSubjects(recordId, subjects) {
      const record = await this.readRecord(recordId);
      if (!record) return;
      record.subjectUserIds = subjects;
      await writeRecord(db, record);
    },

    async updateRecordEvidenceFieldValues(recordId, values) {
      const record = await this.readRecord(recordId);
      if (!record) return;
      record.evidenceFieldValues = values;
      await writeRecord(db, record);
    },

    async updateRecordPlaceholder(recordId, placeholder) {
      const record = await this.readRecord(recordId);
      if (!record) return;
      record.placeholderChannelId = placeholder.channelId;
      record.placeholderMessageId = placeholder.messageId;
      record.status = placeholder.status;
      await writeRecord(db, record);
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
      await db.insert(identityPatterns).values(patternToRow(pattern)).run();
      return pattern;
    },

    async disableIdentityPattern(id) {
      const row = await db
        .select()
        .from(identityPatterns)
        .where(eq(identityPatterns.id, id))
        .limit(1)
        .get();
      if (!row) return false;
      await db
        .update(identityPatterns)
        .set({ disabled: true })
        .where(eq(identityPatterns.id, id))
        .run();
      return true;
    },
  };

  storeCache.set(database, store);
  return store;
}

async function listPatterns(database: AppDrizzleDatabase): Promise<IdentityPattern[]> {
  const rows = await database
    .select()
    .from(identityPatterns)
    .orderBy(asc(identityPatterns.disabled), asc(identityPatterns.position))
    .all();
  return rows.map(mapIdentityPatternRow);
}

async function writeRecord(
  database: AppDrizzleDatabase,
  record: EvidenceVaultRecord,
): Promise<void> {
  await database
    .update(evidenceVaultRecords)
    .set({ status: record.status, payloadJson: JSON.stringify(record) })
    .where(eq(evidenceVaultRecords.recordId, record.id))
    .run();
}
