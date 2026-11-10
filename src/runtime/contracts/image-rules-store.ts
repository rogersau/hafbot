import type { ImageRulesConfig, ImageRulesModQueueItem } from "../../types";

export interface ImageRulesStore {
  readConfig(guildId: string): Promise<ImageRulesConfig | null>;
  upsertConfig(config: ImageRulesConfig): Promise<void>;
  deleteConfig(guildId: string): Promise<void>;
  createModQueueItem(item: Omit<ImageRulesModQueueItem, "id">): Promise<ImageRulesModQueueItem>;
  readModQueueItem(itemId: string): Promise<ImageRulesModQueueItem | null>;
  setModQueueItemQueueMessage(
    itemId: string,
    queueChannelId: string,
    queueMessageId: string,
    nowMs: number,
  ): Promise<void>;
  claimModQueueItemRestore(
    itemId: string,
    claimToken: string,
    actorUserId: string,
    nowMs: number,
    leaseMs: number,
  ): Promise<ImageRulesModQueueItem | null>;
  markModQueueItemApproved(
    itemId: string,
    actorUserId: string,
    nowMs: number,
  ): Promise<ImageRulesModQueueItem | null>;
  markModQueueItemRestored(
    itemId: string,
    claimToken: string,
    actorUserId: string,
    restoredMessageId: string,
    nowMs: number,
  ): Promise<ImageRulesModQueueItem | null>;
  markModQueueItemRestoreFailed(
    itemId: string,
    claimToken: string,
    actorUserId: string,
    failureReason: string,
    nowMs: number,
  ): Promise<ImageRulesModQueueItem | null>;
}
