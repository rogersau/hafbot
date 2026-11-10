import type { WhiteLabelBot } from "../types";
import type { WhiteLabelBotStore } from "./contracts";

export interface VerifyWhiteLabelBotCutoverInput {
  guildId: string;
  whiteLabelBots: WhiteLabelBotStore;
  resolveToken(secretRef: string): Promise<string>;
  readBotUserId(token: string): Promise<string>;
  listBotGuilds(
    token: string,
  ): Promise<Array<{ guildId: string; name: string; icon: string | null }>>;
  now?: () => number;
}

export async function verifyWhiteLabelBotCutover(
  input: VerifyWhiteLabelBotCutoverInput,
): Promise<WhiteLabelBot> {
  const record = await input.whiteLabelBots.readWhiteLabelBot(input.guildId);
  if (!record) {
    throw new Error("White-Label Bot metadata was not found for this Guild.");
  }
  if (record.status === "active") {
    throw new Error("This Guild already active with a White-Label Bot.");
  }
  const activeBot = (await input.whiteLabelBots.listActiveWhiteLabelBots()).find(
    (bot) => bot.guildId === input.guildId,
  );
  if (activeBot) {
    throw new Error("This Guild already active with a White-Label Bot.");
  }

  const token = await input.resolveToken(record.tokenSecretRef);
  const [actualBotUserId, guilds] = await Promise.all([
    input.readBotUserId(token),
    input.listBotGuilds(token),
  ]);
  if (actualBotUserId !== record.botUserId) {
    throw new Error("The provided token does not belong to the expected White-Label Bot.");
  }
  if (!guilds.some((guild) => guild.guildId === record.guildId)) {
    throw new Error("The expected White-Label Bot has not joined the expected Guild.");
  }

  const active: WhiteLabelBot = {
    ...record,
    status: "active",
    updatedAtMs: input.now?.() ?? Date.now(),
  };
  await input.whiteLabelBots.upsertWhiteLabelBot(active);
  return active;
}
