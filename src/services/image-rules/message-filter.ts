import type { Env } from "../../env";
import type { AuditEventId } from "../../types";
import { createCloudflareImageRulesStore } from "../../runtime/cloudflare-image-rules-store";
import { createCloudflareGuildAuditLogStore } from "../../runtime/cloudflare-guild-audit-log-store";
import type { ImageRulesConfig, DiscordMessageCreate, ImageRulesModQueueItem } from "../../types";
import {
  allowUserMentions,
  formatStaffUserReference,
  formatUserMention,
  suppressMentions,
  type CreateChannelMessageInput,
} from "../../discord/messages";
import {
  createChannelMessage,
  createReaction,
  createUserDmMessage,
  deleteChannelMessage,
} from "../../discord";
import { postMessageAuditEvent, type MessageAuditEventData } from "../guild-audit-log-service";
import { classifyImage, type ClassifyImageError, type ImageRulesConfidences } from "./classifier";
import { parseImageRulesEnv, type ImageRulesClassifierEnv } from "./env";
import {
  selectImagesForClassification,
  verdictFromConfidences,
  worstVerdictOf,
  type ClassifiableImage,
  type ImageRulesVerdict,
} from "./verdict";
import { createComponentIdSigner } from "../../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../../security/sensitive-component-ids";

type ImageRulesEnv = Pick<
  Env,
  | "HAF_DB"
  | "BOT_USER_ID"
  | "DISCORD_BOT_TOKEN"
  | "IMAGE_RULES_API_BASE_URL"
  | "IMAGE_RULES_API_KEY"
  | "IMAGE_RULES_MODEL"
  | "IMAGE_RULES_MAX_IMAGE_BYTES"
  | "IMAGE_RULES_MAX_IMAGE_DIMENSION"
  | "IMAGE_RULES_TIMEOUT_MS"
  | "IMAGE_RULES_MAX_RETRIES"
  | "COMPONENT_ID_SIGNING_SECRET"
  | "COMPONENT_ID_PREVIOUS_SIGNING_SECRET"
>;

export interface ImageRulesMessageFilterDependencies {
  readConfig(guildId: string): Promise<ImageRulesConfig | null>;
  resolveBotDisplayName(guildId: string): Promise<string>;
  classifyImage(options: {
    imageUrl: string;
    topicDescription: string;
    env: ImageRulesClassifierEnv;
  }): Promise<ImageRulesConfidences | ClassifyImageError>;
  deleteChannelMessage(channelId: string, messageId: string, token: string): Promise<void>;
  createReaction(channelId: string, messageId: string, emoji: string, token: string): Promise<void>;
  createUserDmMessage(
    userId: string,
    body: CreateChannelMessageInput,
    token: string,
  ): Promise<{ id?: string; channel_id?: string; content?: string } | void>;
  postAuditEvent(eventId: AuditEventId, data: MessageAuditEventData): Promise<void>;
  createModQueueItem(item: Omit<ImageRulesModQueueItem, "id">): Promise<ImageRulesModQueueItem>;
  setModQueueItemQueueMessage(
    itemId: string,
    queueChannelId: string,
    queueMessageId: string,
    nowMs: number,
  ): Promise<void>;
  createChannelMessage(
    channelId: string,
    body: CreateChannelMessageInput,
    guildId?: string,
  ): Promise<{ id?: string; channel_id?: string; content?: string } | void>;
}

export async function moderateImageRulesMessageCreate(
  message: DiscordMessageCreate | null,
  env: ImageRulesEnv,
  partialDependencies: Partial<ImageRulesMessageFilterDependencies> = {},
  resolveBotDisplayName?: (guildId: string) => Promise<string>,
): Promise<void> {
  const componentIdSigner = env.COMPONENT_ID_SIGNING_SECRET
    ? createComponentIdSigner({
        currentSecret: env.COMPONENT_ID_SIGNING_SECRET,
        previousSecret: env.COMPONENT_ID_PREVIOUS_SIGNING_SECRET,
      })
    : undefined;
  const dependencies: ImageRulesMessageFilterDependencies = {
    readConfig: partialDependencies.readConfig ?? ((guildId) => readConfig(guildId, env)),
    resolveBotDisplayName:
      resolveBotDisplayName ?? partialDependencies.resolveBotDisplayName ?? (async () => "HAF Bot"),
    classifyImage: partialDependencies.classifyImage ?? classifyImage,
    deleteChannelMessage: partialDependencies.deleteChannelMessage ?? deleteChannelMessage,
    createReaction: partialDependencies.createReaction ?? createReaction,
    createUserDmMessage: partialDependencies.createUserDmMessage ?? createUserDmMessage,
    postAuditEvent:
      partialDependencies.postAuditEvent ?? ((eventId, data) => postAuditEvent(eventId, data, env)),
    createModQueueItem:
      partialDependencies.createModQueueItem ??
      (async (item) => createCloudflareImageRulesStore(env.HAF_DB!).createModQueueItem(item)),
    setModQueueItemQueueMessage:
      partialDependencies.setModQueueItemQueueMessage ??
      (async (itemId, queueChannelId, queueMessageId, nowMs) =>
        createCloudflareImageRulesStore(env.HAF_DB!).setModQueueItemQueueMessage(
          itemId,
          queueChannelId,
          queueMessageId,
          nowMs,
        )),
    createChannelMessage:
      partialDependencies.createChannelMessage ??
      ((channelId, body, guildId) =>
        signSensitiveMessageComponentIds(body, componentIdSigner, { guildId }).then((signed) =>
          createChannelMessage(channelId, signed, env.DISCORD_BOT_TOKEN),
        )),
  };

  if (!message?.guild_id || !env.HAF_DB) {
    return;
  }

  let config: ImageRulesConfig | null;
  try {
    config = await dependencies.readConfig(message.guild_id);
  } catch (error) {
    console.error("Failed to load image rules config", error);
    return;
  }

  if (!config?.enabled || !message.attachments?.length) {
    return;
  }

  if (config.targetChannelIds.length > 0 && !config.targetChannelIds.includes(message.channel_id)) {
    return;
  }

  const memberRoleIds = message.member?.roles ?? [];
  if (config.excludedRoleIds.some((roleId) => memberRoleIds.includes(roleId))) {
    return;
  }

  const classifierEnv = parseImageRulesEnv(env);
  if (!classifierEnv) {
    return;
  }

  const images = selectImagesForClassification(message.attachments, {
    maxBytes: classifierEnv.maxImageBytes,
    maxDimension: classifierEnv.maxImageDimension,
  });
  if (images.length === 0) {
    return;
  }

  const classifications: Array<{
    image: ClassifiableImage;
    confidences: ImageRulesConfidences;
    verdict: ImageRulesVerdict;
  }> = [];
  for (const image of images) {
    try {
      const result = await dependencies.classifyImage({
        imageUrl: image.url,
        topicDescription: config.topicDescription,
        env: classifierEnv,
      });
      if (isClassifierError(result)) {
        await dependencies.postAuditEvent("image-rule.classification-failed", {
          guildId: config.guildId,
          channelId: message.channel_id,
          messageId: message.id,
          content: `Image classification failed: ${result.error}`,
          author: message.author,
        });
        return;
      }
      classifications.push({
        image,
        confidences: result,
        verdict: verdictFromConfidences(result, config),
      });
    } catch (error) {
      console.error("Failed to classify image rules attachment", error);
      await dependencies.postAuditEvent("image-rule.classification-failed", {
        guildId: config.guildId,
        channelId: message.channel_id,
        messageId: message.id,
        content: "Image classification failed: unexpected_error",
        author: message.author,
      });
      return;
    }
  }

  const verdict = worstVerdictOf(classifications.map((c) => c.verdict));
  if (verdict === "on-topic") {
    await handleOnTopicMessage(message, config, env, dependencies, classifications[0]);
    return;
  }

  if (verdict === "off-topic") {
    const primary = selectPrimaryOffTopicClassification(classifications);
    if (primary) {
      await handleOffTopicMessage(message, config, env, dependencies, primary);
    }
  } else if (verdict === "uncertain") {
    await handleUncertainMessage(
      message,
      config,
      env,
      dependencies,
      images[0]?.url ?? "",
      classifications.map((c) => c.verdict),
    );
  }

  return;
}

function selectPrimaryOffTopicClassification(
  classifications: Array<{
    image: ClassifiableImage;
    confidences: ImageRulesConfidences;
    verdict: ImageRulesVerdict;
  }>,
): (typeof classifications)[0] | undefined {
  if (classifications.length === 0) {
    return undefined;
  }
  const offTopic = classifications.filter((c) => c.verdict === "off-topic");
  if (offTopic.length === 0) {
    return classifications[0];
  }
  return offTopic.reduce((max, current) =>
    current.confidences.off_topic_confidence > max.confidences.off_topic_confidence ? current : max,
  );
}

async function handleOnTopicMessage(
  message: DiscordMessageCreate,
  config: ImageRulesConfig,
  env: ImageRulesEnv,
  dependencies: ImageRulesMessageFilterDependencies,
  primary:
    | {
        image: ClassifiableImage;
        confidences: ImageRulesConfidences;
        verdict: ImageRulesVerdict;
      }
    | undefined,
): Promise<void> {
  if (config.reactOnTopic && !config.dryRun && !message.author?.bot && !message.webhook_id) {
    try {
      await dependencies.createReaction(
        message.channel_id,
        message.id,
        "✅",
        env.DISCORD_BOT_TOKEN,
      );
    } catch (error) {
      console.error("Failed to add on-topic image rules reaction", error);
    }
  }

  const shouldAudit = config.dryRun || config.auditOnTopic;
  if (!shouldAudit || !primary) {
    return;
  }

  await dependencies.postAuditEvent("image-rule.on-topic", {
    guildId: config.guildId,
    channelId: message.channel_id,
    messageId: message.id,
    content: message.content,
    author: message.author,
    image: {
      imageUrl: primary.image.url,
      imageDescription: primary.confidences.image_description,
      classificationReason: primary.confidences.classification_reason,
      offTopicConfidence: primary.confidences.off_topic_confidence,
      onTopicConfidence: primary.confidences.on_topic_confidence,
    },
    ...(config.dryRun && { dryRun: true }),
  });
}

async function handleUncertainMessage(
  message: DiscordMessageCreate,
  config: ImageRulesConfig,
  env: ImageRulesEnv,
  dependencies: ImageRulesMessageFilterDependencies,
  imageUrl: string,
  verdicts: ImageRulesVerdict[],
): Promise<void> {
  if (!imageUrl) {
    return;
  }

  if (config.dryRun) {
    if (!message.author?.id) {
      return;
    }
    await dependencies.postAuditEvent("image-rule.on-topic", {
      guildId: config.guildId,
      channelId: message.channel_id,
      messageId: message.id,
      content: message.content,
      author: message.author,
      image: {
        imageUrl,
        imageDescription: "Dry run would have queued this image for mod review.",
        classificationReason:
          "The image was classified as uncertain. In normal mode the bot would have deleted the message and posted it to the mod queue.",
        offTopicConfidence: verdicts.includes("uncertain") ? config.modReviewThreshold : 0,
        onTopicConfidence: 1 - (verdicts.includes("uncertain") ? config.modReviewThreshold : 0),
      },
      dryRun: true,
    });
    return;
  }

  if (!config.modQueueChannelId || !message.author?.id) {
    return;
  }

  try {
    await dependencies.deleteChannelMessage(message.channel_id, message.id, env.DISCORD_BOT_TOKEN);
  } catch (error) {
    console.error("Failed to delete uncertain image rules message", error);
    return;
  }

  if (!message.author.bot && !message.webhook_id) {
    try {
      const botDisplayName = await dependencies.resolveBotDisplayName(config.guildId);
      await dependencies.createUserDmMessage(
        message.author.id,
        {
          content:
            `Your message was removed by ${botDisplayName} and is pending Image Rules Mod Queue review.\n` +
            `Topic: ${config.topicDescription}`,
          allowed_mentions: allowUserMentions([message.author.id]),
        },
        env.DISCORD_BOT_TOKEN,
      );
    } catch (error) {
      console.error("Failed to DM user about image rules mod queue review", error);
    }
  }

  const now = Date.now();
  const item = await dependencies.createModQueueItem({
    guildId: config.guildId,
    channelId: message.channel_id,
    messageId: message.id,
    authorId: message.author.id,
    imageUrl,
    topicDescription: config.topicDescription,
    offTopicConfidence: verdicts.includes("uncertain") ? config.modReviewThreshold : 0,
    onTopicConfidence: 1 - (verdicts.includes("uncertain") ? config.modReviewThreshold : 0),
    status: "pending",
    queueChannelId: config.modQueueChannelId,
    queueMessageId: null,
    createdAtMs: now,
    updatedAtMs: now,
    decidedByUserId: null,
    decidedAtMs: null,
    failureReason: null,
    restoreClaimToken: null,
    restoreClaimExpiresAtMs: null,
    restoredMessageId: null,
  });

  const roleMentions = config.pingOnQueuePost
    ? config.modRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")
    : "";
  const queueMessage = await dependencies.createChannelMessage(
    config.modQueueChannelId,
    {
      content: roleMentions,
      embeds: [
        {
          title: "Image Rules Review",
          color: 0xfee75c,
          fields: [
            { name: "Author", value: formatStaffUserReference(message.author.id), inline: false },
            { name: "Channel", value: `<#${message.channel_id}>`, inline: false },
            { name: "Message ID", value: message.id, inline: false },
            { name: "Topic", value: config.topicDescription, inline: false },
            { name: "Status", value: item.status, inline: false },
          ],
          image: { url: imageUrl },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: "Approve Deletion",
              custom_id: `image-rules:approve:${item.id}`,
            },
            {
              type: 2,
              style: 2,
              label: "Restore Message",
              custom_id: `image-rules:restore:${item.id}`,
            },
          ],
        },
      ],
      allowed_mentions: config.pingOnQueuePost
        ? { parse: [], roles: config.modRoleIds }
        : suppressMentions(),
      nonce: `ir:${message.id}`,
      enforce_nonce: true,
    },
    config.guildId,
  );
  const queueMessageId = getCreatedMessageId(queueMessage);
  if (queueMessageId) {
    await dependencies.setModQueueItemQueueMessage(
      item.id,
      config.modQueueChannelId,
      queueMessageId,
      Date.now(),
    );
  }
}

function getCreatedMessageId(message: unknown): string | null {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

async function handleOffTopicMessage(
  message: DiscordMessageCreate,
  config: ImageRulesConfig,
  env: ImageRulesEnv,
  dependencies: ImageRulesMessageFilterDependencies,
  primary: {
    image: ClassifiableImage;
    confidences: ImageRulesConfidences;
    verdict: ImageRulesVerdict;
  },
): Promise<void> {
  if (!config.dryRun) {
    try {
      await dependencies.deleteChannelMessage(
        message.channel_id,
        message.id,
        env.DISCORD_BOT_TOKEN,
      );
    } catch (error) {
      console.error("Failed to delete off-topic image rules message", error);
      return;
    }

    if (message.author?.id && !message.author.bot && !message.webhook_id) {
      try {
        const botDisplayName = await dependencies.resolveBotDisplayName(config.guildId);
        await dependencies.createUserDmMessage(
          message.author.id,
          {
            content:
              `Your message was deleted by ${botDisplayName}.\n` +
              `Who sent it: ${formatUserMention(message.author.id)}\n` +
              `Topic: ${config.topicDescription}\n` +
              `Reason: One or more images were classified as off-topic for this guild.`,
            allowed_mentions: allowUserMentions([message.author.id]),
          },
          env.DISCORD_BOT_TOKEN,
        );
      } catch (error) {
        console.error("Failed to DM user about off-topic image rules message", error);
      }
    }
  }

  await dependencies.postAuditEvent("image-rule.off-topic-delete", {
    guildId: config.guildId,
    channelId: message.channel_id,
    messageId: message.id,
    content: message.content,
    author: message.author,
    image: {
      imageUrl: primary.image.url,
      imageDescription: primary.confidences.image_description,
      classificationReason: primary.confidences.classification_reason,
      offTopicConfidence: primary.confidences.off_topic_confidence,
      onTopicConfidence: primary.confidences.on_topic_confidence,
    },
    ...(config.dryRun && { dryRun: true }),
  });
}

async function readConfig(guildId: string, env: ImageRulesEnv): Promise<ImageRulesConfig | null> {
  if (!env.HAF_DB) {
    return null;
  }
  return createCloudflareImageRulesStore(env.HAF_DB).readConfig(guildId);
}

async function postAuditEvent(
  eventId: AuditEventId,
  data: MessageAuditEventData,
  env: ImageRulesEnv,
): Promise<void> {
  if (!env.HAF_DB) {
    return;
  }
  await postMessageAuditEvent(
    eventId,
    data,
    createCloudflareGuildAuditLogStore(env.HAF_DB),
    env.DISCORD_BOT_TOKEN,
    env.BOT_USER_ID,
  );
}

function isClassifierError(
  result: ImageRulesConfidences | ClassifyImageError,
): result is ClassifyImageError {
  return "error" in result;
}
