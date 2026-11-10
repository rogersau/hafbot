import type {
  LfgApplication,
  LfgApplicationStatus,
  LfgConfig,
  LfgPost,
  LfgVoiceChannel,
} from "../../types";

export interface LfgStore {
  readLfgConfig(guildId: string): Promise<LfgConfig | null>;
  upsertLfgConfig(config: LfgConfig): Promise<void>;
  /** Replace a notice only while the saved channel, message, and configuration version match. */
  refreshLfgNotice(input: {
    guildId: string;
    channelId: string;
    previousMessageId: string | null;
    expectedUpdatedAtMs: number;
    messageId: string;
    updatedAtMs: number;
  }): Promise<boolean>;
  listLfgPosts(
    guildId: string,
    options?: { activeOnly?: boolean; limit?: number },
  ): Promise<LfgPost[]>;
  countActiveLfgPosts(guildId: string): Promise<number>;
  readLfgPost(guildId: string, postId: string): Promise<LfgPost | null>;
  readActiveLfgPostByOwner(guildId: string, ownerId: string): Promise<LfgPost | null>;
  createLfgPost(post: LfgPost): Promise<void>;
  updateLfgPostMessage(body: { guildId: string; postId: string; messageId: string }): Promise<void>;
  updateLfgPost(body: LfgPost): Promise<void>;
  closeLfgPost(body: {
    guildId: string;
    postId: string;
    closedByUserId: string;
    closedAtMs: number;
  }): Promise<LfgPost>;
  createLfgApplication(application: LfgApplication): Promise<void>;
  readLfgApplication(
    guildId: string,
    postId: string,
    applicantId: string,
  ): Promise<LfgApplication | null>;
  listLfgApplicationsForPost(
    guildId: string,
    postId: string,
    options?: { status?: LfgApplicationStatus },
  ): Promise<LfgApplication[]>;
  updateLfgApplication(application: LfgApplication): Promise<void>;
  readLfgVoiceChannel(guildId: string, postId: string): Promise<LfgVoiceChannel | null>;
  readLfgVoiceChannelByChannelId(channelId: string): Promise<LfgVoiceChannel | null>;
  upsertLfgVoiceChannel(channel: LfgVoiceChannel): Promise<void>;
  deleteLfgVoiceChannel(guildId: string, postId: string): Promise<void>;
  listDueLfgPostExpiries(
    nowMs: number,
    limit: number,
    excludedGuildIds?: readonly string[],
  ): Promise<LfgPost[]>;
  listDueLfgRenewalReminders(
    nowMs: number,
    limit: number,
    excludedGuildIds?: readonly string[],
  ): Promise<LfgPost[]>;
}
