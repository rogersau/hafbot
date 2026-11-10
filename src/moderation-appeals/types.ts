import { z } from "zod";

export const banAppealGuildIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
export const banAppealIdSchema = z.string().uuid();
export const banAppealSettingsSchema = z.object({
  enabled: z.boolean(),
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().max(1000),
  cooldownHours: z.number().int().min(1).max(720),
});
export type BanAppealSettings = z.infer<typeof banAppealSettingsSchema>;
export interface BanAppealConfig extends BanAppealSettings {
  guildId: string;
  revision: number;
}
export type BanAppealStatus = "pending" | "unban_pending" | "unbanned" | "rejected";
export interface BanAppeal {
  id: string;
  guildId: string;
  userId: string;
  displayName: string;
  text: string;
  banReason: string | null;
  status: BanAppealStatus;
  revision: number;
  createdAtMs: number;
  resolvedAtMs: number | null;
  reviewerUserId: string | null;
  decisionReason: string | null;
  operationId: string | null;
}
export interface BanAppealOperation {
  id: string;
  appealId: string;
  actorUserId: string;
  reason: string;
  outcome: "started" | "succeeded" | "failed" | "uncertain";
  createdAtMs: number;
  completedAtMs: number | null;
}
export interface BanAppealStore {
  getConfig(guildId: string): Promise<BanAppealConfig>;
  saveConfig(
    guildId: string,
    settings: BanAppealSettings,
    expectedRevision: number,
  ): Promise<BanAppealConfig>;
  latestForUser(guildId: string, userId: string): Promise<BanAppeal | null>;
  nextSubmissionAt(guildId: string, userId: string): Promise<number>;
  list(guildId: string): Promise<BanAppeal[]>;
  read(guildId: string, id: string): Promise<BanAppeal | null>;
  operations(guildId: string, id: string): Promise<BanAppealOperation[]>;
  submit(input: {
    guildId: string;
    id: string;
    userId: string;
    displayName: string;
    text: string;
    banReason: string | null;
    nowMs: number;
  }): Promise<BanAppeal>;
  claimReview(input: {
    guildId: string;
    id: string;
    actorUserId: string;
    reason: string;
    action: "reject" | "unban";
    expectedRevision: number;
    operationId: string;
    nowMs: number;
  }): Promise<{ appeal: BanAppeal; operation: BanAppealOperation | null; execute: boolean }>;
  finishUnban(
    guildId: string,
    appealId: string,
    operationId: string,
    outcome: "succeeded" | "failed" | "uncertain",
    nowMs: number,
  ): Promise<BanAppeal>;
}

export class BanAppealError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BanAppealError";
  }
}
export function defaultBanAppealConfig(guildId: string): BanAppealConfig {
  return {
    guildId,
    revision: 0,
    enabled: false,
    title: "Discord ban appeal",
    instructions:
      "Explain what happened and why you believe the ban should be reviewed. Do not include passwords or other private credentials.",
    cooldownHours: 168,
  };
}

export interface BanAppealPublicState {
  config: BanAppealConfig;
  signedInName: string | null;
  currentBan: boolean;
  nextSubmissionAtMs: number;
  appeal: Pick<BanAppeal, "id" | "text" | "status" | "createdAtMs" | "resolvedAtMs"> | null;
}
