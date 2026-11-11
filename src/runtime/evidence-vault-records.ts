import type {
  evidenceVaultConfigs,
  evidenceVaultRecords,
  identityPatterns,
} from "../db/postgres/app-schema";
import { isRecord } from "../unknown-parse";
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

type EvidenceVaultConfigRow = typeof evidenceVaultConfigs.$inferSelect;
type EvidenceVaultConfigInsert = typeof evidenceVaultConfigs.$inferInsert;
type EvidenceVaultRecordRow = typeof evidenceVaultRecords.$inferSelect;
type EvidenceVaultRecordInsert = typeof evidenceVaultRecords.$inferInsert;
type IdentityPatternRow = typeof identityPatterns.$inferSelect;

export function mapConfigRow(row: EvidenceVaultConfigRow): EvidenceVaultConfig {
  return {
    guildId: row.guildId,
    ...(row.enabled === 0 ? { enabled: false } : {}),
    auditChannelId: row.auditChannelId,
    accessRoleIds: parseAccessRoleIds(row.accessRoleIdsJson),
    subjectsEnabled: Boolean(row.subjectsEnabled),
    evidenceFields: parseEvidenceFieldDefinitions(row.fieldsJson),
    updatedAtMs: row.updatedAtMs,
  };
}

export function configToRow(config: EvidenceVaultConfig): EvidenceVaultConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled === false ? 0 : 1,
    auditChannelId: config.auditChannelId,
    accessRoleIdsJson: JSON.stringify(config.accessRoleIds),
    subjectsEnabled: config.subjectsEnabled,
    fieldsJson: JSON.stringify(config.evidenceFields ?? []),
    updatedAtMs: config.updatedAtMs,
  };
}

function parseAccessRoleIds(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Invalid stored Evidence Vault access roles.");
  }
  return value;
}

export function recordToRow(record: EvidenceVaultRecord): EvidenceVaultRecordInsert {
  return {
    recordId: record.id,
    guildId: record.guildId,
    status: record.status,
    payloadJson: JSON.stringify(record),
    hiddenAtMs: record.hiddenAtMs,
  };
}

export function mapRecordRow(row: EvidenceVaultRecordRow): EvidenceVaultRecord {
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

export function mapIdentityPatternRow(row: IdentityPatternRow): IdentityPattern {
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

export function patternToRow(pattern: IdentityPattern): typeof identityPatterns.$inferInsert {
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
  return {
    id: image.id,
    filename: image.filename,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes,
    r2Key: image.r2Key,
  };
}

function mapStatus(value: string): EvidenceVaultRecordStatus {
  if (value === "source-delete-failed" || value === "placeholder-post-failed") return value;
  return "active";
}
