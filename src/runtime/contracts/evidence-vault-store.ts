import type {
  EvidenceVaultConfig,
  EvidenceVaultRecord,
  EvidenceVaultRecordStatus,
  IdentityPattern,
  SubjectIdentifier,
} from "../../types";

export interface EvidenceVaultStore {
  setEnabled?(guildId: string, enabled: boolean): Promise<boolean>;
  readConfig(guildId: string): Promise<EvidenceVaultConfig | null>;
  upsertConfig(config: EvidenceVaultConfig): Promise<void>;
  createRecord(record: EvidenceVaultRecord): Promise<void>;
  readRecord(recordId: string): Promise<EvidenceVaultRecord | null>;
  listRecords(guildId: string): Promise<EvidenceVaultRecord[]>;
  searchRecordsBySubject(
    guildId: string,
    subject: SubjectIdentifier,
  ): Promise<EvidenceVaultRecord[]>;
  updateRecordEvidenceFieldValues(
    recordId: string,
    values: NonNullable<EvidenceVaultRecord["evidenceFieldValues"]>,
  ): Promise<void>;
  updateRecordStatus(recordId: string, status: EvidenceVaultRecordStatus): Promise<void>;
  updateRecordSubjects(recordId: string, subjects: SubjectIdentifier[]): Promise<void>;
  updateRecordPlaceholder(
    recordId: string,
    placeholder: { channelId: string; messageId: string; status: EvidenceVaultRecordStatus },
  ): Promise<void>;
  readImage(
    recordId: string,
    imageId: string,
  ): Promise<{ r2Key: string; contentType: string } | null>;
  listEnabledIdentityPatterns(): Promise<IdentityPattern[]>;
  listIdentityPatterns(): Promise<IdentityPattern[]>;
  addIdentityPattern(
    input: Omit<IdentityPattern, "id" | "position" | "disabled" | "createdAtMs">,
  ): Promise<IdentityPattern>;
  disableIdentityPattern(id: string): Promise<boolean>;
}
