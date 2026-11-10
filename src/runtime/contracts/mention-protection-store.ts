import type {
  MentionProtectionActionKey,
  MentionProtectionActionOutcome,
  MentionProtectionActionClaim,
  MentionProtectionBreach,
  MentionProtectionClaimInput,
  MentionProtectionConfig,
} from "../../types";

export interface MentionProtectionStore {
  readConfig(guildId: string): Promise<MentionProtectionConfig | null>;
  upsertConfig(config: MentionProtectionConfig): Promise<void>;
  deleteConfig(guildId: string): Promise<void>;
  clearBurstWindow(guildId: string): Promise<void>;
  recordBurstMessage(input: {
    guildId: string;
    userId: string;
    messageId: string;
    messageTimestampMs: number;
    windowMs: number;
  }): Promise<number>;
  claimMessageBreaches(input: MentionProtectionClaimInput): Promise<MentionProtectionBreach[]>;
  claimAction(
    guildId: string,
    messageId: string,
    action: MentionProtectionActionKey,
    nowMs?: number,
  ): Promise<MentionProtectionActionClaim>;
  recordActionOutcome(outcome: MentionProtectionActionOutcome): Promise<void>;
}
