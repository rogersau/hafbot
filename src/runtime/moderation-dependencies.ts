import type { Env } from "../env";
import type { BotDefenseStore, GuildEntitlementStore, ImageRulesStore } from "./contracts";
import { createChannelMessage, createReaction, deleteChannelMessage } from "../discord";
import { DiscordApiError } from "../discord/client";
import { getChannelParent } from "../discord/channels";
import { createComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../security/sensitive-component-ids";
import type { BotDefenseMessageFilterDependencies } from "../services/bot-defense/message-filter";
import { fingerprintImageAttachments } from "../services/bot-defense/attachment-fingerprint";
import type { ImageRulesMessageFilterDependencies } from "../services/image-rules/message-filter";
import { classifyImage } from "../services/image-rules/classifier";

type ModerationEnvironment = Pick<
  Env,
  "DISCORD_BOT_TOKEN" | "COMPONENT_ID_SIGNING_SECRET" | "COMPONENT_ID_PREVIOUS_SIGNING_SECRET"
>;

export function createImageRulesMessageFilterDependencies(
  env: ModerationEnvironment,
  store: ImageRulesStore,
  options: Pick<
    ImageRulesMessageFilterDependencies,
    "postAuditEvent" | "resolveBotDisplayName" | "createUserDmMessage"
  >,
): ImageRulesMessageFilterDependencies {
  const signer = createModerationSigner(env);
  return {
    ...options,
    readConfig: (guildId) => store.readConfig(guildId),
    classifyImage,
    deleteChannelMessage,
    createReaction,
    createModQueueItem: (item) => store.createModQueueItem(item),
    setModQueueItemQueueMessage: (...args) => store.setModQueueItemQueueMessage(...args),
    createChannelMessage: async (channelId, body, guildId) =>
      createChannelMessage(
        channelId,
        await signSensitiveMessageComponentIds(body, signer, { guildId }),
        env.DISCORD_BOT_TOKEN,
      ),
  };
}

export function createBotDefenseMessageFilterDependencies(
  env: ModerationEnvironment,
  store: BotDefenseStore,
  entitlements: GuildEntitlementStore,
  options: Pick<BotDefenseMessageFilterDependencies, "postAuditEvent" | "resolveBotDisplayName">,
): BotDefenseMessageFilterDependencies {
  const signer = createModerationSigner(env);
  return {
    ...options,
    fingerprintImageAttachments,
    readConfig: (guildId) => store.readConfig(guildId),
    readGuildEntitlement: (guildId) => entitlements.readGuildEntitlement(guildId),
    resolveChannelParent: getChannelParent,
    openBotFlag: (...args) => store.openBotFlag(...args),
    setBotFlagQueueMessage: (...args) => store.setBotFlagQueueMessage(...args),
    recordRateMessage: (...args) => store.recordRateMessage(...args),
    listMatchingMessageChannelsInWindow: (...args) =>
      store.listMatchingMessageChannelsInWindow(...args),
    createChannelMessage: async (channelId, body, token) =>
      createChannelMessage(channelId, await signSensitiveMessageComponentIds(body, signer), token),
    warnUser: (channelId, messageId, userId, detectorType) =>
      warnBotDefenseUser(channelId, messageId, userId, detectorType, env.DISCORD_BOT_TOKEN),
    deleteMessage: (channelId, messageId) =>
      deleteBotDefenseMessage(channelId, messageId, env.DISCORD_BOT_TOKEN),
    nowMs: Date.now,
  };
}

function createModerationSigner(env: ModerationEnvironment) {
  return env.COMPONENT_ID_SIGNING_SECRET
    ? createComponentIdSigner({
        currentSecret: env.COMPONENT_ID_SIGNING_SECRET,
        previousSecret: env.COMPONENT_ID_PREVIOUS_SIGNING_SECRET,
      })
    : undefined;
}

async function warnBotDefenseUser(
  channelId: string,
  messageId: string,
  userId: string,
  detectorType: "honeypot" | "rate",
  botToken: string,
): Promise<void> {
  const detectorLabel = detectorType === "honeypot" ? "Honeypot Detector" : "Rate Detector";
  const content = `Your message triggered Bot Defense's ${detectorLabel}.`;
  try {
    await createChannelMessage(
      channelId,
      {
        content,
        message_reference: { message_id: messageId, channel_id: channelId },
        allowed_mentions: { parse: [], replied_user: true },
        nonce: `bot-defense:${messageId}:${detectorType}`,
        enforce_nonce: true,
      },
      botToken,
    );
  } catch {
    await createChannelMessage(
      channelId,
      {
        content: `<@${userId}> ${content}`,
        allowed_mentions: { parse: [], users: [userId] },
        nonce: `bot-defense:${messageId}:${detectorType}`,
        enforce_nonce: true,
      },
      botToken,
    );
  }
}

async function deleteBotDefenseMessage(
  channelId: string,
  messageId: string,
  botToken: string,
): Promise<void> {
  try {
    await deleteChannelMessage(channelId, messageId, botToken);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return;
    throw error;
  }
}
