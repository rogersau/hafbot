import type { BotDefenseConfig, BotFlag } from "../../types";
import { createChannelMessage } from "../../discord";
import { createComponentIdSigner } from "../../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../../security/sensitive-component-ids";
import { buildBotFlagQueueMessageBody } from "./message-filter";

const DEFAULT_GRACE_MS = 10 * 60 * 1_000;
const DEFAULT_LIMIT = 20;

export interface BotDefenseQueueRepairStore {
  listOpenBotFlagsMissingQueueMessage(
    nowMs: number,
    graceMs: number,
    limit: number,
  ): Promise<BotFlag[]>;
  readConfig(guildId: string): Promise<BotDefenseConfig | null>;
  setBotFlagQueueMessage(
    guildId: string,
    userId: string,
    expectedCreatedAtMs: number,
    queueMessageId: string,
    nowMs: number,
  ): Promise<void>;
}

export interface BotDefenseQueueRepairOptions {
  store: BotDefenseQueueRepairStore;
  resolveBotToken(guildId: string): Promise<string>;
  componentIdSigningSecret?: string;
  componentIdPreviousSigningSecret?: string;
  graceMs?: number;
  limit?: number;
  nowMs?: () => number;
}

/**
 * Re-delivers Bot Defense mod queue messages for open flags whose first
 * delivery failed after the flag was persisted. Bounded per sweep; failures
 * are logged and left for the next sweep.
 */
export async function repairStrandedBotFlagQueueMessages(
  options: BotDefenseQueueRepairOptions,
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const componentIdSigner = options.componentIdSigningSecret
    ? createComponentIdSigner({
        currentSecret: options.componentIdSigningSecret,
        previousSecret: options.componentIdPreviousSigningSecret,
      })
    : undefined;

  const flags = await options.store.listOpenBotFlagsMissingQueueMessage(nowMs(), graceMs, limit);
  let repaired = 0;
  for (const flag of flags) {
    try {
      if (await repairFlag(flag, options, componentIdSigner, nowMs())) repaired += 1;
    } catch (error) {
      console.error("Failed to repair Bot Defense queue delivery", {
        guildId: flag.guildId,
        userId: flag.userId,
        error,
      });
    }
  }
  return repaired;
}

async function repairFlag(
  flag: BotFlag,
  options: BotDefenseQueueRepairOptions,
  componentIdSigner: ReturnType<typeof createComponentIdSigner> | undefined,
  now: number,
): Promise<boolean> {
  const config = await options.store.readConfig(flag.guildId);
  if (!config?.modQueueChannelId) return false;

  const body = await signSensitiveMessageComponentIds(
    buildBotFlagQueueMessageBody(
      flag.guildId,
      flag.userId,
      flag.detectorType,
      flag.evidence,
      config,
      now,
      flag.createdAtMs,
    ),
    componentIdSigner,
    { guildId: flag.guildId },
  );
  const message = await createChannelMessage(
    config.modQueueChannelId,
    body,
    await options.resolveBotToken(flag.guildId),
  );
  if (!message.id) return false;

  await options.store.setBotFlagQueueMessage(
    flag.guildId,
    flag.userId,
    flag.createdAtMs,
    message.id,
    now,
  );
  return true;
}
