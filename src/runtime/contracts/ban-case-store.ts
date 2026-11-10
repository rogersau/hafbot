import type {
  BanCase,
  BanCaseConfig,
  BanCaseSource,
  BanCaseStatus,
  SubjectIdentifier,
  SubjectIdentifierPlatform,
} from "../../types";

export interface BanCaseStore {
  readConfig(guildId: string): Promise<BanCaseConfig | null>;
  upsertConfig(config: BanCaseConfig): Promise<void>;

  readBanCaseSourceByPublicId(publicId: string): Promise<BanCaseSource | null>;
  listBanCaseSources(guildId: string): Promise<BanCaseSource[]>;
  upsertBanCaseSource(source: BanCaseSource): Promise<void>;
  deleteBanCaseSource(body: { guildId: string; sourceId: string }): Promise<void>;

  createBanCase(banCase: BanCase): Promise<void>;
  readBanCase(guildId: string, caseId: string): Promise<BanCase | null>;
  readBanCaseBySubject(
    guildId: string,
    platform: SubjectIdentifierPlatform,
    id: string,
  ): Promise<BanCase | null>;
  listBanCases(guildId: string): Promise<BanCase[]>;
  updateBanCaseStatus(
    guildId: string,
    caseId: string,
    status: BanCaseStatus,
    updatedAtMs: number,
  ): Promise<BanCase | null>;
  updateBanCaseThread(
    guildId: string,
    caseId: string,
    thread: { threadChannelId: string; threadMessageId: string; publicId: string },
    updatedAtMs: number,
  ): Promise<void>;
}

export type { BanCase, SubjectIdentifier };
