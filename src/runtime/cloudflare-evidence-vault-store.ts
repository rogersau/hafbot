import { asc, eq } from "drizzle-orm";
import { isRecord } from "../unknown-parse";
import { evidenceVaultConfigs, evidenceVaultRecords, identityPatterns } from "../db/app-schema";
import type {
  EvidenceFieldDefinition,
  EvidenceFieldValue,
  EvidenceVaultConfig,
  EvidenceVaultImage,
  EvidenceVaultRecord,
  EvidenceVaultRecordStatus,
  IdentityPattern,
  SubjectIdentifierPlatform,
} from "../types";
import type { EvidenceVaultStore } from "./contracts/evidence-vault-store";
import { createD1DrizzleDatabase, type AppDrizzleDatabase } from "./drizzle-db";

type EvidenceVaultConfigRow = typeof evidenceVaultConfigs.$inferSelect;
type EvidenceVaultConfigInsert = typeof evidenceVaultConfigs.$inferInsert;
type EvidenceVaultRecordRow = typeof evidenceVaultRecords.$inferSelect;
type EvidenceVaultRecordInsert = typeof evidenceVaultRecords.$inferInsert;
type IdentityPatternRow = typeof identityPatterns.$inferSelect;

const storeCache = new WeakMap<D1Database, EvidenceVaultStore>();

export function createCloudflareEvidenceVaultStore(database: D1Database): EvidenceVaultStore {
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
            accessRoleId: values.accessRoleId,
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

function mapConfigRow(row: EvidenceVaultConfigRow): EvidenceVaultConfig {
  return {
    guildId: row.guildId,
    ...(row.enabled === 0 ? { enabled: false } : {}),
    auditChannelId: row.auditChannelId,
    accessRoleIds: parseAccessRoleIds(row.accessRoleIdsJson, row.accessRoleId),
    subjectsEnabled: Boolean(row.subjectsEnabled),
    evidenceFields: parseEvidenceFieldDefinitions(row.fieldsJson),
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: EvidenceVaultConfig): EvidenceVaultConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled === false ? 0 : 1,
    auditChannelId: config.auditChannelId,
    accessRoleId: config.accessRoleIds[0] ?? null,
    accessRoleIdsJson: JSON.stringify(config.accessRoleIds),
    subjectsEnabled: config.subjectsEnabled,
    fieldsJson: JSON.stringify(config.evidenceFields ?? []),
    updatedAtMs: config.updatedAtMs,
  };
}

function parseAccessRoleIds(
  accessRoleIdsJson: string | null,
  legacyAccessRoleId: string | null,
): string[] {
  try {
    const parsed = accessRoleIdsJson ? (JSON.parse(accessRoleIdsJson) as unknown) : [];
    if (Array.isArray(parsed)) {
      const roleIds = parsed.filter((entry): entry is string => typeof entry === "string");
      if (roleIds.length > 0 || accessRoleIdsJson !== "[]") {
        return roleIds;
      }
    }
  } catch {
    // Fall back to the legacy single access role column below.
  }

  return legacyAccessRoleId ? [legacyAccessRoleId] : [];
}

function recordToRow(record: EvidenceVaultRecord): EvidenceVaultRecordInsert {
  return {
    recordId: record.id,
    guildId: record.guildId,
    status: record.status,
    payloadJson: JSON.stringify(record),
    hiddenAtMs: record.hiddenAtMs,
  };
}

function mapRecordRow(row: EvidenceVaultRecordRow): EvidenceVaultRecord {
  const parsed = JSON.parse(row.payloadJson) as EvidenceVaultRecord;
  return {
    ...parsed,
    id: row.recordId,
    guildId: row.guildId,
    status: mapStatus(row.status),
    images: Array.isArray(parsed.images) ? parsed.images.map(mapImage) : [],
    subjectUserIds: Array.isArray(parsed.subjectUserIds) ? parsed.subjectUserIds : [],
    subjectsEnabled: parsed.subjectsEnabled === true,
    evidenceFieldValues: parseEvidenceFieldValues(parsed.evidenceFieldValues),
  };
}

function parseEvidenceFieldDefinitions(value: string | null): EvidenceFieldDefinition[] {
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const type = mapEvidenceFieldType(entry.type);
      if (!key || !label || !type) return [];
      const allowedValues = Array.isArray(entry.allowedValues)
        ? entry.allowedValues.filter((item): item is string => typeof item === "string")
        : undefined;
      return [{ key, label, type, ...(allowedValues ? { allowedValues } : {}) }];
    });
  } catch {
    return [];
  }
}

function parseEvidenceFieldValues(value: unknown): EvidenceFieldValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const key = typeof entry.key === "string" ? entry.key : "";
    const label = typeof entry.label === "string" ? entry.label : "";
    const type = mapEvidenceFieldType(entry.type);
    const fieldValue = typeof entry.value === "string" ? entry.value : "";
    if (!key || !label || !type || !fieldValue) return [];
    return [{ key, label, type, value: fieldValue }];
  });
}

function mapEvidenceFieldType(value: unknown): EvidenceFieldDefinition["type"] | null {
  return value === "text" || value === "short_text" || value === "enum" ? value : null;
}

function mapIdentityPatternRow(row: IdentityPatternRow): IdentityPattern {
  return {
    id: row.id,
    platform: mapSubjectPlatform(row.platform),
    pattern: row.pattern,
    captureGroup: row.captureGroup,
    position: row.position,
    disabled: Boolean(row.disabled),
    createdAtMs: row.createdAtMs,
  };
}

function patternToRow(pattern: IdentityPattern): typeof identityPatterns.$inferInsert {
  return pattern;
}

function mapSubjectPlatform(value: string): SubjectIdentifierPlatform {
  if (
    value === "discord" ||
    value === "steam" ||
    value === "xbox" ||
    value === "playstation" ||
    value === "cftools"
  ) {
    return value;
  }
  return "discord";
}

function mapImage(image: EvidenceVaultImage): EvidenceVaultImage {
  return image;
}

function mapStatus(value: string): EvidenceVaultRecordStatus {
  if (value === "source-delete-failed" || value === "placeholder-post-failed") return value;
  return "active";
}
