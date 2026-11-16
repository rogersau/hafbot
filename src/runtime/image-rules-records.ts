import type { imageRulesConfigs, imageRulesModQueueItems } from "../db/postgres/app-schema";
import type { ImageRulesConfig, ImageRulesModQueueItem } from "../types";

type ImageRulesConfigRow = typeof imageRulesConfigs.$inferSelect;
type ImageRulesConfigInsert = typeof imageRulesConfigs.$inferInsert;
type ImageRulesModQueueItemRow = typeof imageRulesModQueueItems.$inferSelect;
type ImageRulesModQueueItemInsert = typeof imageRulesModQueueItems.$inferInsert;

export function modQueueItemToRow(item: ImageRulesModQueueItem): ImageRulesModQueueItemInsert {
  return { ...item };
}

export function mapModQueueItemRow(row: ImageRulesModQueueItemRow): ImageRulesModQueueItem {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    authorId: row.authorId,
    imageUrl: row.imageUrl,
    topicDescription: row.topicDescription,
    offTopicConfidence: row.offTopicConfidence,
    onTopicConfidence: row.onTopicConfidence,
    status: row.status as ImageRulesModQueueItem["status"],
    queueChannelId: row.queueChannelId,
    queueMessageId: row.queueMessageId,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    decidedByUserId: row.decidedByUserId,
    decidedAtMs: row.decidedAtMs,
    failureReason: row.failureReason,
    restoreClaimToken: row.restoreClaimToken,
    restoreClaimExpiresAtMs: row.restoreClaimExpiresAtMs,
    restoredMessageId: row.restoredMessageId,
  };
}

export function mapConfigRow(row: ImageRulesConfigRow): ImageRulesConfig {
  return {
    guildId: row.guildId,
    enabled: row.enabled === 1,
    topicDescription: row.topicDescription,
    autoDeleteThreshold: row.autoDeleteThreshold,
    modReviewThreshold: row.modReviewThreshold,
    targetChannelIds: parseJsonStringArray(row.targetChannelIdsJson),
    excludedRoleIds: parseJsonStringArray(row.excludedRoleIdsJson),
    modQueueChannelId: row.modQueueChannelId ?? null,
    modRoleIds: parseJsonStringArray(row.modRoleIdsJson),
    pingOnQueuePost: row.pingOnQueuePost === 1,
    reactOnTopic: row.reactOnTopic === 1,
    auditOnTopic: row.auditOnTopic === 1,
    dryRun: row.dryRun === 1,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

export function configToRow(config: ImageRulesConfig): ImageRulesConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled ? 1 : 0,
    topicDescription: config.topicDescription,
    autoDeleteThreshold: config.autoDeleteThreshold,
    modReviewThreshold: config.modReviewThreshold,
    targetChannelIdsJson: JSON.stringify(config.targetChannelIds),
    excludedRoleIdsJson: JSON.stringify(config.excludedRoleIds),
    modQueueChannelId: config.modQueueChannelId,
    modRoleIdsJson: JSON.stringify(config.modRoleIds),
    pingOnQueuePost: config.pingOnQueuePost ? 1 : 0,
    reactOnTopic: config.reactOnTopic ? 1 : 0,
    auditOnTopic: config.auditOnTopic ? 1 : 0,
    dryRun: config.dryRun ? 1 : 0,
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
