import type { WhiteLabelBot } from "../../types";

export interface WhiteLabelBotStore {
  readWhiteLabelBot(guildId: string): Promise<WhiteLabelBot | null>;
  listActiveWhiteLabelBots(): Promise<WhiteLabelBot[]>;
  upsertWhiteLabelBot(record: WhiteLabelBot): Promise<void>;
}
