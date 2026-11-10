import { z } from "zod";

export const snowflake = z.string().regex(/^\d{1,20}$/);
const ids = z.array(snowflake).max(25).default([]);
const text = z.string().trim().min(1).max(1800);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

export const customReplySchema = z.object({
  id,
  enabled: z.boolean().default(false),
  trigger: z.string().trim().min(1).max(100),
  match: z.enum(["exact", "prefix", "contains"]).default("exact"),
  response: text,
  channelIds: ids,
  requiredRoleIds: ids,
  cooldownSeconds: z.number().int().min(5).max(86400).default(30),
});
export const recurringMessageSchema = z.object({
  id,
  enabled: z.boolean().default(false),
  channelId: snowflake,
  content: text,
  intervalMinutes: z.number().int().min(15).max(43200),
  startsAtMs: z.number().int().positive().max(8_640_000_000_000_000),
  notifyRoleIds: ids,
});
export const automationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  commands: z.array(customReplySchema).max(50).default([]),
  schedules: z.array(recurringMessageSchema).max(10).default([]),
});
export const moderationRuleSchema = z.object({
  id,
  enabled: z.boolean().default(false),
  name: z.string().trim().min(1).max(80),
  trigger: z.enum(["words", "domains", "invites", "message-rate"]),
  values: z
    .array(z.string().trim().max(150))
    .max(50)
    .default([])
    .transform((values) => values.filter(Boolean)),
  messageLimit: z.number().int().min(3).max(100).default(8),
  windowSeconds: z.number().int().min(5).max(86400).default(60),
  channelIds: ids,
  excludedRoleIds: ids,
  deleteMessage: z.boolean().default(false),
  warn: z.boolean().default(true),
  timeoutAfter: z.number().int().min(0).max(100).default(0),
  timeoutMinutes: z.number().int().min(1).max(40320).default(10),
});
export const moderationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  moderatorRoleIds: ids,
  reportChannelId: snowflake.nullable().default(null),
  rules: z.array(moderationRuleSchema).max(25).default([]),
});
export const contentFeedSchema = z.object({
  id,
  enabled: z.boolean().default(false),
  name: z.string().trim().min(1).max(80),
  provider: z.enum(["rss", "youtube", "reddit", "twitch"]),
  source: z.string().trim().min(1).max(1000),
  channelId: snowflake,
  notifyRoleIds: ids,
});
export const feedConfigSchema = z.object({
  enabled: z.boolean().default(false),
  feeds: z.array(contentFeedSchema).max(10).default([]),
});
export const communityConfigSchemas = {
  automation: automationConfigSchema,
  moderation: moderationConfigSchema,
  feeds: feedConfigSchema,
};
export type CommunityFeature = keyof typeof communityConfigSchemas;
export type AutomationConfig = z.infer<typeof automationConfigSchema>;
export type ModerationConfig = z.infer<typeof moderationConfigSchema>;
export type FeedConfig = z.infer<typeof feedConfigSchema>;
export type ContentFeed = z.infer<typeof contentFeedSchema>;
export type CommunityConfig = AutomationConfig | ModerationConfig | FeedConfig;
export interface ConfigSnapshot {
  config: CommunityConfig;
  revision: number;
}
export interface CommunityMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  content: string;
  eventKey: string;
  receivedAtMs: number;
}
export interface ModerationCase {
  id: string;
  guildId: string;
  userId: string;
  actorUserId: string | null;
  action: string;
  reason: string;
  createdAtMs: number;
}
export class CommunityToolsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function parseCommunityConfig(feature: CommunityFeature, value: unknown): CommunityConfig {
  const result = communityConfigSchemas[feature].safeParse(value);
  if (!result.success)
    throw new CommunityToolsError(
      "Check the settings, text lengths, IDs and limits before saving.",
    );
  const config = result.data;
  const entries =
    "commands" in config
      ? [...config.commands, ...config.schedules]
      : "rules" in config
        ? config.rules
        : config.feeds;
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new CommunityToolsError("Each item needs a different ID.");
  if (
    "rules" in config &&
    config.rules.some(
      (rule) => ["words", "domains"].includes(rule.trigger) && rule.values.length === 0,
    )
  )
    throw new CommunityToolsError("Word and domain rules need at least one value.");
  return config;
}

export function matchesReply(
  content: string,
  trigger: string,
  mode: "exact" | "prefix" | "contains",
): boolean {
  const normalized = content.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const match = trigger.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return mode === "exact"
    ? normalized === match
    : mode === "prefix"
      ? normalized.startsWith(match)
      : normalized.includes(match);
}

export function recurringOccurrence(
  nowMs: number,
  startsAtMs: number,
  intervalMinutes: number,
): number | null {
  if (nowMs < startsAtMs) return null;
  const intervalMs = intervalMinutes * 60000;
  const occurrence = startsAtMs + Math.floor((nowMs - startsAtMs) / intervalMs) * intervalMs;
  return nowMs - occurrence <= 5 * 60000 ? occurrence : null;
}

export function moderationMatches(
  rule: z.infer<typeof moderationRuleSchema>,
  content: string,
): boolean {
  const normalized = content.normalize("NFKC").toLocaleLowerCase("en-US");
  if (rule.trigger === "message-rate") return true;
  if (rule.trigger === "invites")
    return /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/i.test(
      normalized,
    );
  if (rule.trigger === "words")
    return rule.values.some((value) =>
      normalized.includes(value.normalize("NFKC").toLocaleLowerCase("en-US")),
    );
  const domains = Array.from(normalized.matchAll(/https?:\/\/[^\s<>]+/g)).flatMap(([raw]) => {
    try {
      return [new URL(raw).hostname];
    } catch {
      return [];
    }
  });
  return rule.values.some((value) =>
    domains.some(
      (host) => host === value.toLowerCase() || host.endsWith(`.${value.toLowerCase()}`),
    ),
  );
}
