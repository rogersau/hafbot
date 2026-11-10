import type { CreateForumThreadInput, ForumThread } from "../discord/threads";
import type { CreateChannelMessageInput, DiscordEmbed } from "../discord/messages";
import { assertGuildPremiumTier } from "../runtime/entitlement-checks";
import type { GuildEntitlementStore, GuildAuditLogStore } from "../runtime/contracts";
import type { BanCaseStore } from "../runtime/contracts";
import type { BanCase, BanCaseConfig, BanCaseSource, SubjectIdentifier } from "../types";

export class BanCaseSourceNotFoundError extends Error {}

const BAN_CASE_SOURCE_CACHE_TTL_MS = 2 * 60 * 1000;
const BAN_CASE_SOURCE_CACHE_MAX_ENTRIES = 1_024;

export interface CachedBanCaseSourceEntry {
  readonly expiresAtMs: number;
  readonly promise: Promise<BanCaseSource | null>;
}

export type BanCaseSourceCache = Map<string, CachedBanCaseSourceEntry>;

export interface ExtractedBanDetails {
  subject: SubjectIdentifier;
  username: string;
  reason: string;
}

/**
 * Discord REST operations the service performs, injected so the token stays in
 * one place and the service is testable without module mocking. Mirrors the
 * `discordMessages` adapter pattern used by the service factory.
 */
export interface BanCaseDiscordAdapter {
  createForumThread(input: CreateForumThreadInput): Promise<ForumThread>;
  createChannelMessage(channelId: string, body: CreateChannelMessageInput): Promise<void>;
  editChannelMessage(
    channelId: string,
    messageId: string,
    body: CreateChannelMessageInput,
  ): Promise<void>;
  modifyThread(threadId: string, appliedTags: string[]): Promise<void>;
  postAudit(
    eventId: "ban-case.create" | "ban-case.status-change",
    data: {
      guildId: string;
      channelId: string;
      messageId: string;
      content: string;
      authorId: string;
    },
  ): Promise<void>;
}

export interface BanCaseServiceOptions {
  discord: BanCaseDiscordAdapter;
  guildEntitlements: GuildEntitlementStore;
  guildAuditLog: GuildAuditLogStore;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
  /**
   * Resolved forum tag ids for a guild's Ban Case Forum. Called once before a
   * thread is created. An implementation reads the {@link BanCaseConfig} and
   * returns the `{ new, completed }` tag ids, creating them if missing.
   */
  resolveForumTags?: (guildId: string, forumChannelId: string) => Promise<ForumTagIds>;
  logger?: Pick<Console, "error" | "warn">;
  sourceCache?: BanCaseSourceCache;
}

export interface ForumTagIds {
  new: string | null;
  completed: string | null;
}

export interface BanCaseAcceptResult {
  accepted: boolean;
  reason?: "source-not-found" | "source-disabled" | "not-premium" | "no-forum" | "no-extract";
}

const REASON_MAX_LENGTH = 1000;
const USERNAME_MAX_LENGTH = 100;

/**
 * Parses a ban-webhook text body into a subject, username, and reason using
 * the source's extraction regex and named capture groups. Returns null when the
 * pattern does not match or the subject id group is empty.
 */
export function extractBanDetails(source: BanCaseSource, body: string): ExtractedBanDetails | null {
  let matcher: RegExp;
  try {
    matcher = new RegExp(source.pattern, source.flags || undefined);
  } catch {
    return null;
  }

  const match = matcher.exec(body);
  if (!match) {
    return null;
  }

  const subjectId = readCaptureGroup(match, source.subjectIdGroup);
  if (!subjectId) {
    return null;
  }

  const username = truncate(
    readCaptureGroup(match, source.nameGroup) ?? "Unknown",
    USERNAME_MAX_LENGTH,
  );
  const reason = truncate(
    readCaptureGroup(match, source.reasonGroup) ?? "No reason provided",
    REASON_MAX_LENGTH,
  );

  return {
    subject: { platform: source.platform, id: subjectId },
    username,
    reason,
  };
}

export class BanCaseService {
  private readonly logger: Pick<Console, "error" | "warn">;
  private readonly now: () => number;
  private readonly sourceCache: BanCaseSourceCache;

  constructor(
    private readonly store: BanCaseStore,
    private readonly options: BanCaseServiceOptions,
  ) {
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.sourceCache = options.sourceCache ?? new Map();
  }

  /**
   * Entry point for an inbound ban webhook. Extracts and dedups in-request so a
   * duplicate returns fast, then runs the Discord-creating work under
   * {@link BanCaseServiceOptions.waitUntil}. Always resolves for expected drop
   * cases so the public route can return HTTP 200 and avoid game-server retries.
   */
  async handleInboundBanWebhook(publicId: string, body: string): Promise<BanCaseAcceptResult> {
    const source = await this.readCachedBanCaseSource(publicId);
    if (!source) {
      this.logger.warn("Ban Case webhook dropped: source not found", { publicId });
      return { accepted: false, reason: "source-not-found" };
    }
    if (!source.enabled) {
      this.logger.warn("Ban Case webhook dropped: source disabled", {
        guildId: source.guildId,
        sourceId: source.sourceId,
      });
      return { accepted: false, reason: "source-disabled" };
    }

    const tierCheck = await assertGuildPremiumTier(this.options.guildEntitlements, source.guildId);
    if (!tierCheck.ok) {
      this.logger.warn("Ban Case webhook dropped: guild is below premium tier", {
        guildId: source.guildId,
        sourceId: source.sourceId,
      });
      return { accepted: false, reason: "not-premium" };
    }

    const config = await this.store.readConfig(source.guildId);
    if (!config?.enabled || !config.forumChannelId) {
      this.logger.warn("Ban Case webhook dropped: no configured forum", {
        guildId: source.guildId,
        sourceId: source.sourceId,
      });
      return { accepted: false, reason: "no-forum" };
    }

    const details = extractBanDetails(source, body);
    if (!details) {
      this.logger.warn("Ban Case webhook dropped: extraction rule did not match", {
        guildId: source.guildId,
        sourceId: source.sourceId,
      });
      return { accepted: false, reason: "no-extract" };
    }

    const existing = await this.store.readBanCaseBySubject(
      source.guildId,
      details.subject.platform,
      details.subject.id,
    );

    const work = existing
      ? this.appendToExistingCase(existing, source, details)
      : this.createNewCase(source, config, details);

    if (this.options.waitUntil) {
      this.options.waitUntil(
        work.catch((error) => this.logger.error("Ban Case delivery failed", error)),
      );
      return { accepted: true };
    }

    await work;
    return { accepted: true };
  }

  async hasInboundBanCaseSource(publicId: string): Promise<boolean> {
    return (await this.readCachedBanCaseSource(publicId))?.enabled === true;
  }

  async readCachedInboundBanCaseSource(publicId: string): Promise<boolean | null> {
    const cached = this.getCachedBanCaseSource(publicId);
    return cached ? (await cached.promise)?.enabled === true : null;
  }

  invalidateInboundBanCaseSources(): void {
    this.sourceCache.clear();
  }

  private readCachedBanCaseSource(publicId: string): Promise<BanCaseSource | null> {
    const existing = this.getCachedBanCaseSource(publicId);
    if (existing) return existing.promise;

    const promise = this.store.readBanCaseSourceByPublicId(publicId).catch((error) => {
      this.sourceCache.delete(publicId);
      throw error;
    });
    while (this.sourceCache.size >= BAN_CASE_SOURCE_CACHE_MAX_ENTRIES) {
      const oldest = this.sourceCache.keys().next().value;
      if (oldest === undefined) break;
      this.sourceCache.delete(oldest);
    }
    this.sourceCache.set(publicId, {
      expiresAtMs: Date.now() + BAN_CASE_SOURCE_CACHE_TTL_MS,
      promise,
    });
    return promise;
  }

  private getCachedBanCaseSource(publicId: string): CachedBanCaseSourceEntry | null {
    const existing = this.sourceCache.get(publicId);
    if (!existing) return null;
    if (existing.expiresAtMs <= Date.now()) {
      this.sourceCache.delete(publicId);
      return null;
    }
    this.sourceCache.delete(publicId);
    this.sourceCache.set(publicId, existing);
    return existing;
  }

  private async createNewCase(
    source: BanCaseSource,
    config: BanCaseConfig,
    details: ExtractedBanDetails,
  ): Promise<void> {
    const nowMs = this.now();
    const caseId = createId();

    let tagIds: ForumTagIds = { new: null, completed: null };
    if (this.options.resolveForumTags) {
      try {
        tagIds = await this.options.resolveForumTags(source.guildId, config.forumChannelId!);
      } catch (error) {
        this.logger.error("Ban Case forum tag resolution failed", error);
      }
    }

    let threadChannelId: string;
    let threadMessageId: string;
    try {
      const thread = await this.options.discord.createForumThread({
        channelId: config.forumChannelId!,
        name: buildThreadName(details),
        message: buildStarterMessage(source, details, caseId),
        appliedTags: tagIds.new ? [tagIds.new] : [],
      });
      threadChannelId = thread.id;
      threadMessageId = thread.message.id;
    } catch (error) {
      this.logger.error("Ban Case forum thread creation failed", error);
      return;
    }

    const banCase: BanCase = {
      guildId: source.guildId,
      caseId,
      sourceId: source.sourceId,
      publicId: source.publicId,
      subject: details.subject,
      username: details.username,
      status: "new",
      threadChannelId,
      threadMessageId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    try {
      await this.store.createBanCase(banCase);
    } catch (error) {
      this.logger.error("Ban Case record persistence failed", error);
      // The thread exists but we couldn't persist; leave the thread and log.
      return;
    }

    await this.options.discord.postAudit("ban-case.create", {
      guildId: source.guildId,
      channelId: threadChannelId,
      messageId: threadMessageId,
      content: `Ban Case created for ${details.username} (${details.subject.platform}:${details.subject.id}). Reason: ${details.reason}`,
      authorId: source.publicId,
    });
  }

  private async appendToExistingCase(
    existing: BanCase,
    source: BanCaseSource,
    details: ExtractedBanDetails,
  ): Promise<void> {
    // If the subject already has a case, record the source/publicId of the
    // latest feed and post the new ban details into the thread without altering
    // status (per the dedup-by-subject rule).
    try {
      await this.options.discord.createChannelMessage(
        existing.threadChannelId,
        buildAppendMessage(source, details),
      );
    } catch (error) {
      this.logger.error("Ban Case append message failed", error);
    }

    const nowMs = this.now();
    try {
      await this.store.updateBanCaseThread(
        existing.guildId,
        existing.caseId,
        {
          threadChannelId: existing.threadChannelId,
          threadMessageId: existing.threadMessageId,
          publicId: source.publicId,
        },
        nowMs,
      );
    } catch (error) {
      this.logger.error("Ban Case append persistence failed", error);
    }
  }

  /**
   * Transitions a Ban Case to COMPLETED. Called by the interaction handler after
   * role-gating; performs the embed edit + tag swap + persistence + audit.
   */
  async markCompleted(
    guildId: string,
    caseId: string,
    actorUserId: string,
    config: BanCaseConfig,
  ): Promise<BanCase | null> {
    const banCase = await this.store.readBanCase(guildId, caseId);
    if (!banCase || banCase.status !== "new") {
      return null;
    }

    let tagIds: ForumTagIds = { new: null, completed: null };
    if (config.forumChannelId && this.options.resolveForumTags) {
      try {
        tagIds = await this.options.resolveForumTags(guildId, config.forumChannelId);
      } catch (error) {
        this.logger.error("Ban Case forum tag resolution failed", error);
      }
    }

    const nowMs = this.now();

    try {
      await this.options.discord.editChannelMessage(
        banCase.threadChannelId,
        banCase.threadMessageId,
        {
          content: "Ban Case completed.",
          embeds: [buildCompletedEmbed(banCase, actorUserId, nowMs)],
          components: [buildDisabledCompletedButton(banCase)],
          allowed_mentions: { parse: [] },
        },
      );
    } catch (error) {
      this.logger.error("Ban Case completion embed edit failed", error);
    }

    if (tagIds.completed) {
      try {
        await this.options.discord.modifyThread(banCase.threadChannelId, [tagIds.completed]);
      } catch (error) {
        this.logger.error("Ban Case tag swap failed", error);
      }
    }

    const updated = await this.store.updateBanCaseStatus(guildId, caseId, "completed", nowMs);

    await this.options.discord.postAudit("ban-case.status-change", {
      guildId,
      channelId: banCase.threadChannelId,
      messageId: banCase.threadMessageId,
      content: `Ban Case marked completed by <@${actorUserId}>.`,
      authorId: banCase.subject.id,
    });

    return updated ?? { ...banCase, status: "completed", updatedAtMs: nowMs };
  }
}

export function buildStarterMessage(
  source: BanCaseSource,
  details: ExtractedBanDetails,
  caseId: string,
): { embeds: DiscordEmbed[]; components: unknown[]; allowed_mentions: { parse: [] } } {
  const embed: DiscordEmbed = {
    title: "Ban Case: NEW",
    color: 0xed4245,
    description: `A ban was reported by **${source.name}**.`,
    fields: [
      {
        name: "Subject",
        value: `${details.username}\n${details.subject.platform}:${details.subject.id}`,
        inline: false,
      },
      { name: "Ban reason", value: details.reason, inline: false },
      { name: "Source", value: source.name, inline: false },
    ],
    footer: { text: "hafbot.xyz" },
    timestamp: new Date().toISOString(),
  };

  return {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Mark Completed",
            custom_id: `ban-case:complete:${source.guildId}:${caseId}`,
          },
          {
            type: 2,
            style: 2,
            label: "Server actions",
            custom_id: `ban-case:actions:${source.guildId}:${caseId}`,
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function buildAppendMessage(
  source: BanCaseSource,
  details: ExtractedBanDetails,
): { content: string; allowed_mentions: { parse: [] } } {
  return {
    content:
      `**New ban report from ${source.name}**\n` +
      `Subject: ${details.username} (${details.subject.platform}:${details.subject.id})\n` +
      `Reason: ${details.reason}`,
    allowed_mentions: { parse: [] },
  };
}

export function buildCompletedEmbed(
  banCase: BanCase,
  actorUserId: string,
  completedAtMs: number = Date.now(),
): DiscordEmbed {
  return {
    title: "Ban Case: COMPLETED",
    color: 0x2f855a,
    description: `\u2705 Completed by <@${actorUserId}> at <t:${Math.floor(completedAtMs / 1000)}:F>.`,
    fields: [
      {
        name: "Subject",
        value: `${banCase.username}\n${banCase.subject.platform}:${banCase.subject.id}`,
        inline: false,
      },
    ],
    footer: { text: "hafbot.xyz" },
    timestamp: new Date().toISOString(),
  };
}

function buildDisabledCompletedButton(banCase: BanCase): { type: 1; components: unknown[] } {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "Mark Completed",
        custom_id: `ban-case:complete:${banCase.guildId}:${banCase.caseId}`,
        disabled: true,
      },
      {
        type: 2,
        style: 2,
        label: "Server actions",
        custom_id: `ban-case:actions:${banCase.guildId}:${banCase.caseId}`,
      },
    ],
  };
}

function buildThreadName(details: ExtractedBanDetails): string {
  const name = details.username.slice(0, 80);
  return `Ban Case — ${name}`;
}

function readCaptureGroup(match: RegExpExecArray, groupName: string): string | null {
  const groups = match.groups;
  if (!groups || !(groupName in groups)) {
    return null;
  }
  const value = groups[groupName];
  return value && value.trim().length > 0 ? value.trim() : null;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function createId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
