import type {
  MemberVerificationConfig,
  MemberVerificationState,
  MemberVerificationAttempt,
} from "../../types";

export interface MemberVerificationStore {
  readConfig(guildId: string): Promise<MemberVerificationConfig | null>;
  upsertConfig(config: MemberVerificationConfig): Promise<void>;
  readVerificationState(guildId: string, userId: string): Promise<MemberVerificationState | null>;
  upsertVerificationState(state: MemberVerificationState): Promise<void>;
  createVerificationAttempt(attempt: MemberVerificationAttempt): Promise<void>;
  readVerificationAttempt(id: string): Promise<MemberVerificationAttempt | null>;
  updateVerificationAttempt(attempt: MemberVerificationAttempt): Promise<void>;
  deleteVerificationAttempt(id: string): Promise<void>;
  listActiveVerificationAttempts(
    guildId: string,
    userId: string,
  ): Promise<MemberVerificationAttempt[]>;
  tryClaimVerificationAttempt(id: string, nowMs: number): Promise<boolean>;
  consumeManualDmRateLimit(input: {
    guildId: string;
    scopeType: "guild" | "actor" | "target";
    scopeId: string;
    nowMs: number;
    windowMs: number;
    limit: number;
  }): Promise<{ allowed: boolean; retryAfterMs: number }>;
}
