import { z } from "zod";

export const reputationSnowflakeSchema = z.string().regex(/^[1-9]\d{0,19}$/);
export const reputationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    cooldownSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
    giverRoleIds: z.array(reputationSnowflakeSchema).max(25),
    excludedRoleIds: z.array(reputationSnowflakeSchema).max(25),
    rewards: z
      .array(
        z.object({
          threshold: z.number().int().min(1).max(1_000_000),
          roleId: reputationSnowflakeSchema,
        }),
      )
      .max(20),
  })
  .superRefine((settings, context) => {
    if (new Set(settings.rewards.map((reward) => reward.roleId)).size !== settings.rewards.length)
      context.addIssue({
        code: "custom",
        path: ["rewards"],
        message: "Each reward role can appear only once.",
      });
    if (settings.giverRoleIds.some((id) => settings.excludedRoleIds.includes(id)))
      context.addIssue({
        code: "custom",
        path: ["giverRoleIds"],
        message: "A giver role cannot also be excluded.",
      });
  });

export type ReputationSettings = z.infer<typeof reputationSettingsSchema>;
export interface ReputationConfig extends ReputationSettings {
  guildId: string;
  revision: number;
}
export interface ReputationMember {
  userId: string;
  displayName: string;
  bot: boolean;
  roleIds: string[];
}
export interface ReputationAwardInput {
  guildId: string;
  interactionId: string;
  giver: ReputationMember;
  recipient: ReputationMember;
  reason: string | null;
  nowMs: number;
}
export interface ReputationAward {
  interactionId: string;
  recipientId: string;
  total: number;
  duplicate: boolean;
}
export interface ReputationScore {
  userId: string;
  total: number;
}
export interface ReputationRewardJob {
  guildId: string;
  userId: string;
  roleId: string;
  threshold: number;
}
export interface ReputationStore {
  getConfig(guildId: string): Promise<ReputationConfig>;
  saveConfig(
    guildId: string,
    settings: ReputationSettings,
    expectedRevision: number,
  ): Promise<ReputationConfig>;
  award(input: ReputationAwardInput): Promise<ReputationAward>;
  score(guildId: string, userId: string): Promise<number>;
  topScores(guildId: string, limit: number): Promise<ReputationScore[]>;
  setMembership(guildId: string, userId: string, current: boolean): Promise<void>;
  pendingRewards(nowMs: number, limit: number, guildId?: string): Promise<ReputationRewardJob[]>;
  completeReward(job: ReputationRewardJob, nowMs: number): Promise<void>;
  deferReward(job: ReputationRewardJob, nextAttemptAtMs: number): Promise<void>;
  eraseMember(guildId: string, userId: string): Promise<void>;
}

export class ReputationError extends Error {
  constructor(
    message: string,
    readonly code: "disabled" | "invalid" | "cooldown" | "conflict" | "member" = "invalid",
  ) {
    super(message);
    this.name = "ReputationError";
  }
}

export function defaultReputationConfig(guildId: string): ReputationConfig {
  return {
    guildId,
    revision: 0,
    enabled: false,
    cooldownSeconds: 86_400,
    giverRoleIds: [],
    excludedRoleIds: [],
    rewards: [],
  };
}

export function assertReputationEligibility(config: ReputationConfig, input: ReputationAwardInput) {
  if (!config.enabled)
    throw new ReputationError("Reputation is disabled in this server.", "disabled");
  if (input.giver.userId === input.recipient.userId)
    throw new ReputationError("You cannot give reputation to yourself.");
  if (input.giver.bot || input.recipient.bot)
    throw new ReputationError("Reputation is available to server members, not bots.");
  if (
    config.giverRoleIds.length &&
    !config.giverRoleIds.some((roleId) => input.giver.roleIds.includes(roleId))
  )
    throw new ReputationError("You do not have a role that can give reputation.");
  if (
    [input.giver, input.recipient].some((member) =>
      config.excludedRoleIds.some((roleId) => member.roleIds.includes(roleId)),
    )
  )
    throw new ReputationError("A member's role excludes them from reputation.");
}
