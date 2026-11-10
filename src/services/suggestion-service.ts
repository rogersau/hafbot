import { decideSuggestionStatusChange } from "./suggestion-status-workflow";
import type { SuggestionStore } from "../runtime/contracts";
import {
  defaultSuggestionsConfig,
  isTerminalSuggestionStatus,
  normalizeSuggestionText,
  type ConsideredReply,
  type ConsideredReplyPerspective,
  type PendingSuggestionSubmission,
  type Suggestion,
  type SuggestionAnswer,
  type SuggestionMemberContext,
  type SuggestionOutcome,
  type SuggestionsConfig,
  type SuggestionStatus,
  type SuggestionVoteValue,
} from "../suggestions";

const DAY_MS = 86_400_000;
const PENDING_SUBMISSION_TTL_MS = 15 * 60_000;
const ACTIVE_STATUSES = new Set<SuggestionStatus>([
  "gathering_feedback",
  "needs_work",
  "under_review",
]);

export class SuggestionDomainError extends Error {
  constructor(
    public readonly code:
      | "eligibility"
      | "authority"
      | "invalid-transition"
      | "stale-interaction"
      | "rate-limit"
      | "duplicate-confirmation-expired"
      | "discord-permission"
      | "provider-failure"
      | "degraded-projection"
      | "not-found",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "SuggestionDomainError";
  }
}

export interface SuggestionProjection {
  createSuggestion?(
    suggestion: Suggestion,
  ): Promise<{ threadId: string; starterMessageId: string }>;
  updateSuggestion?(suggestion: Suggestion): Promise<void>;
  setThreadLocked?(suggestion: Suggestion, locked: boolean): Promise<void>;
  postStatusUpdate?(
    suggestion: Suggestion,
    from: SuggestionStatus,
    reason: string | null,
  ): Promise<void>;
  publishConsideredReply?(reply: ConsideredReply): Promise<{ messageId: string }>;
  collapseConsideredReply?(reply: ConsideredReply): Promise<{ queueMessageId: string | null }>;
  restoreConsideredReply?(reply: ConsideredReply): Promise<void>;
  deleteConsideredReply?(reply: ConsideredReply): Promise<void>;
  resolveConsideredReplyQueue?(reply: ConsideredReply): Promise<void>;
  notifyAuthorOfStatus?(suggestion: Suggestion, from: SuggestionStatus): Promise<void>;
  publishDigest?(input: {
    config: SuggestionsConfig;
    periodKey: string;
    newSuggestions: Suggestion[];
    needingFeedback: Suggestion[];
    recentlyDecided: Suggestion[];
  }): Promise<{ messageId: string }>;
}

export interface SuggestionAuditEvent {
  event: string;
  guildId: string;
  actorUserId: string;
  suggestionId?: string;
  consideredReplyId?: string;
  detail?: unknown;
  createdAtMs: number;
}

export type SuggestionAuditWriter = (event: SuggestionAuditEvent) => Promise<void>;

export type SubmitSuggestionResult =
  | { kind: "created"; suggestion: Suggestion }
  | { kind: "duplicate-warning"; pending: PendingSuggestionSubmission; matches: Suggestion[] };

export class SuggestionService {
  constructor(
    private readonly store: SuggestionStore,
    private readonly projection: SuggestionProjection = {},
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly audit?: SuggestionAuditWriter,
  ) {}

  async getConfig(guildId: string): Promise<SuggestionsConfig> {
    return (await this.store.readConfig(guildId)) ?? defaultSuggestionsConfig(guildId, this.now());
  }

  async getSuggestion(guildId: string, suggestionId: string): Promise<Suggestion> {
    return this.requireSuggestion(guildId, suggestionId);
  }

  async repairProjection(
    guildId: string,
    suggestionId: string,
    actorUserId: string,
  ): Promise<Suggestion> {
    const suggestion = await this.requireSuggestion(guildId, suggestionId);
    let next = suggestion;
    if (suggestion.threadId && suggestion.starterMessageId) {
      if (!this.projection.updateSuggestion) {
        throw new SuggestionDomainError(
          "degraded-projection",
          "Discord projection is unavailable.",
        );
      }
      await this.projection.updateSuggestion(suggestion);
    } else {
      if (!this.projection.createSuggestion) {
        throw new SuggestionDomainError(
          "degraded-projection",
          "Discord projection is unavailable.",
        );
      }
      const projected = await this.projection.createSuggestion(suggestion);
      next = { ...suggestion, ...projected };
    }
    next = { ...next, projectionError: null, updatedAtMs: this.now() };
    if (!(await this.store.updateSuggestion(next, suggestion.revision))) {
      throw new SuggestionDomainError("stale-interaction", "The Suggestion changed during repair.");
    }
    await this.record("projection.repaired", guildId, actorUserId, {
      suggestionId,
      threadId: next.threadId,
    });
    return next;
  }

  async updateConfig(config: SuggestionsConfig, actorUserId: string): Promise<SuggestionsConfig> {
    assertConfig(config);
    const next = { ...config, updatedAtMs: this.now() };
    await this.store.upsertConfig(next);
    await this.record("config.updated", config.guildId, actorUserId, { config: next });
    return next;
  }

  async recordPanelPublished(guildId: string, actorUserId: string): Promise<void> {
    await this.record("panel.published", guildId, actorUserId, {});
  }

  async submit(input: {
    guildId: string;
    authorId: string;
    title: string;
    answers: SuggestionAnswer[];
    category?: string | null;
    skipDuplicateWarning?: boolean;
  }): Promise<SubmitSuggestionResult> {
    const config = await this.getConfig(input.guildId);
    if (!config.enabled || !config.forumChannelId) {
      throw new SuggestionDomainError(
        "degraded-projection",
        "Suggestions is not ready in this Guild.",
      );
    }
    const nowMs = this.now();
    if (!input.skipDuplicateWarning) {
      await this.assertActionRateLimit(input.guildId, input.authorId, "submit", 5, 60_000);
    }
    const title = requiredText(input.title, "Title", 100);
    const answers = validateAnswers(config, input.answers);
    const category = validateCategory(config, input.category ?? null);
    const latest = await this.store.readLatestSuggestionByAuthor(input.guildId, input.authorId);
    if (latest && latest.createdAtMs + config.submissionCooldownSeconds * 1000 > nowMs) {
      throw new SuggestionDomainError(
        "rate-limit",
        "The Suggestion submission cooldown is active.",
      );
    }
    if (
      (await this.store.countActiveSuggestionsByAuthor(input.guildId, input.authorId)) >=
      config.activeSuggestionLimit
    ) {
      throw new SuggestionDomainError(
        "rate-limit",
        "You have reached this Guild's active Suggestion limit.",
      );
    }
    const normalizedSearchText = normalizeSuggestionText(
      `${title} ${answers.map((answer) => answer.answer).join(" ")}`,
    );
    const active = await this.store.listActiveSuggestions(input.guildId);
    const matches = input.skipDuplicateWarning
      ? []
      : active
          .filter((candidate) =>
            likelyDuplicate(normalizedSearchText, candidate.normalizedSearchText),
          )
          .slice(0, 3);
    if (matches.length > 0) {
      const pending: PendingSuggestionSubmission = {
        id: this.createId(),
        guildId: input.guildId,
        authorId: input.authorId,
        title,
        answers,
        category,
        likelyDuplicateIds: matches.map((match) => match.id),
        expiresAtMs: nowMs + PENDING_SUBMISSION_TTL_MS,
      };
      await this.store.savePendingSubmission(pending);
      return { kind: "duplicate-warning", pending, matches };
    }
    return {
      kind: "created",
      suggestion: await this.createSuggestion({
        guildId: input.guildId,
        authorId: input.authorId,
        title,
        answers,
        category,
        normalizedSearchText,
      }),
    };
  }

  async confirmDuplicateSubmission(
    guildId: string,
    pendingId: string,
    authorId: string,
  ): Promise<Suggestion> {
    const pending = await this.store.readPendingSubmission(pendingId);
    if (!pending || pending.guildId !== guildId) {
      throw new SuggestionDomainError(
        "duplicate-confirmation-expired",
        "This duplicate confirmation has expired.",
      );
    }
    if (pending.authorId !== authorId || pending.expiresAtMs <= this.now()) {
      await this.store.deletePendingSubmission(pending.id);
      throw new SuggestionDomainError(
        "duplicate-confirmation-expired",
        "This duplicate confirmation has expired.",
      );
    }
    await this.store.deletePendingSubmission(pending.id);
    const result = await this.submit({ ...pending, skipDuplicateWarning: true });
    if (result.kind !== "created") throw new Error("Unreachable duplicate confirmation result.");
    return result.suggestion;
  }

  async revise(input: {
    guildId: string;
    suggestionId: string;
    authorId: string;
    expectedRevision: number;
    title: string;
    answers: SuggestionAnswer[];
    category?: string | null;
  }): Promise<Suggestion> {
    await this.assertActionRateLimit(input.guildId, input.authorId, "revise", 5, 60_000);
    const suggestion = await this.requireSuggestion(input.guildId, input.suggestionId);
    if (suggestion.authorId !== input.authorId) {
      throw new SuggestionDomainError("authority", "Only the Suggestion author may edit it.");
    }
    if (suggestion.status !== "gathering_feedback" && suggestion.status !== "needs_work") {
      throw new SuggestionDomainError(
        "invalid-transition",
        "This Suggestion cannot be edited now.",
      );
    }
    if (suggestion.revision !== input.expectedRevision) {
      throw new SuggestionDomainError("stale-interaction", "The Suggestion has changed.");
    }
    const config = await this.getConfig(input.guildId);
    const nowMs = this.now();
    const title = requiredText(input.title, "Title", 100);
    const answers = validateAnswers(config, input.answers);
    const next: Suggestion = {
      ...suggestion,
      title,
      answers,
      category: validateCategory(config, input.category ?? null),
      normalizedSearchText: normalizeSuggestionText(
        `${title} ${answers.map((answer) => answer.answer).join(" ")}`,
      ),
      revision: suggestion.revision + 1,
      editedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.createRevision({
      id: this.createId(),
      suggestionId: suggestion.id,
      guildId: suggestion.guildId,
      revision: suggestion.revision,
      title: suggestion.title,
      answers: suggestion.answers,
      category: suggestion.category,
      editedByUserId: input.authorId,
      createdAtMs: nowMs,
    });
    if (!(await this.store.updateSuggestion(next, suggestion.revision))) {
      throw new SuggestionDomainError("stale-interaction", "The Suggestion has changed.");
    }
    await this.bestEffortProjection(next);
    await this.record("suggestion.revised", next.guildId, input.authorId, {
      suggestionId: next.id,
      revision: next.revision,
    });
    return next;
  }

  async setVote(input: {
    guildId: string;
    suggestionId: string;
    memberId: string;
    value: SuggestionVoteValue | null;
    member: SuggestionMemberContext;
  }): Promise<Suggestion> {
    await this.assertActionRateLimit(input.guildId, input.memberId, "vote", 30, 60_000);
    const suggestion = await this.requireSuggestion(input.guildId, input.suggestionId);
    if (!ACTIVE_STATUSES.has(suggestion.status)) {
      throw new SuggestionDomainError("invalid-transition", "Voting is closed.");
    }
    if (input.value !== null) {
      this.assertEligible(await this.getConfig(input.guildId), input.member);
    }
    await this.store.upsertVote(
      input.guildId,
      input.suggestionId,
      input.memberId,
      input.value,
      this.now(),
    );
    const counts = await this.store.recountVotes(input.guildId, input.suggestionId);
    const next = {
      ...suggestion,
      supportCount: counts.support,
      opposeCount: counts.oppose,
      updatedAtMs: this.now(),
    };
    await this.store.updateSuggestion(next, suggestion.revision);
    await this.bestEffortProjection(next);
    console.info("suggestion_vote_updated", {
      guildId: input.guildId,
      suggestionId: input.suggestionId,
      value: input.value,
      supportCount: next.supportCount,
      opposeCount: next.opposeCount,
    });
    return next;
  }

  async memberLeftGuild(guildId: string, memberId: string): Promise<number> {
    return this.store.deactivateVotesForMember(guildId, memberId, this.now());
  }

  async addConsideredReply(input: {
    guildId: string;
    suggestionId: string;
    authorId: string;
    perspective: ConsideredReplyPerspective;
    reasoning: string;
    improvement?: string | null;
  }): Promise<ConsideredReply> {
    await this.assertActionRateLimit(input.guildId, input.authorId, "reply", 5, 300_000);
    const suggestion = await this.requireSuggestion(input.guildId, input.suggestionId);
    if (!ACTIVE_STATUSES.has(suggestion.status)) {
      throw new SuggestionDomainError("invalid-transition", "Replies are closed.");
    }
    const nowMs = this.now();
    let reply: ConsideredReply = {
      id: this.createId(),
      suggestionId: suggestion.id,
      threadId: suggestion.threadId,
      guildId: suggestion.guildId,
      authorId: input.authorId,
      perspective: input.perspective,
      reasoning: requiredText(input.reasoning, "Reasoning", 2000),
      improvement: optionalText(input.improvement, 1000),
      state: "visible",
      flagCount: 0,
      webhookMessageId: null,
      queueMessageId: null,
      collapsedAtMs: null,
      resolvedAtMs: null,
      resolvedByUserId: null,
      resolutionReason: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.createConsideredReply(reply);
    if (this.projection.publishConsideredReply) {
      try {
        const delivered = await this.projection.publishConsideredReply(reply);
        const next = { ...reply, webhookMessageId: delivered.messageId, updatedAtMs: this.now() };
        if (await this.store.updateConsideredReply(next, "visible")) reply = next;
      } catch (error) {
        throw providerError("The Considered Reply was saved but Discord delivery failed.", error);
      }
    }
    console.info("suggestion_reply_created", {
      guildId: reply.guildId,
      suggestionId: reply.suggestionId,
      consideredReplyId: reply.id,
      perspective: reply.perspective,
    });
    return reply;
  }

  async setReplyFlag(input: {
    guildId: string;
    replyId: string;
    memberId: string;
    active: boolean;
    member: SuggestionMemberContext;
  }): Promise<ConsideredReply> {
    await this.assertActionRateLimit(input.guildId, input.memberId, "flag", 20, 60_000);
    const reply = await this.requireReply(input.guildId, input.replyId);
    if (reply.authorId === input.memberId) {
      throw new SuggestionDomainError("eligibility", "Authors cannot flag their own reply.");
    }
    this.assertEligible(await this.getConfig(input.guildId), input.member);
    await this.store.setReplyFlag(
      input.guildId,
      input.replyId,
      input.memberId,
      input.active,
      this.now(),
    );
    const count = await this.store.countReplyFlags(input.guildId, input.replyId);
    let next = { ...reply, flagCount: count, updatedAtMs: this.now() };
    const config = await this.getConfig(input.guildId);
    if (reply.state === "visible" && count >= config.collapseThreshold) {
      next = { ...next, state: "collapsed", collapsedAtMs: this.now() };
      if (!(await this.store.updateConsideredReply(next, "visible"))) {
        return this.requireReply(input.guildId, input.replyId);
      }
      if (this.projection.collapseConsideredReply) {
        try {
          const delivered = await this.projection.collapseConsideredReply(next);
          if (delivered.queueMessageId) {
            const withQueue = { ...next, queueMessageId: delivered.queueMessageId };
            if (await this.store.updateConsideredReply(withQueue, "collapsed")) next = withQueue;
          }
        } catch {
          // Collapse is authoritative even when the Mod Queue delivery is degraded.
        }
      }
      await this.record("reply.collapsed", input.guildId, input.memberId, {
        suggestionId: reply.suggestionId,
        consideredReplyId: reply.id,
        flagCount: count,
      });
      return next;
    }
    await this.store.updateConsideredReply(next, reply.state);
    console.info("suggestion_reply_flag_updated", {
      guildId: input.guildId,
      suggestionId: reply.suggestionId,
      consideredReplyId: reply.id,
      active: input.active,
      flagCount: count,
    });
    return next;
  }

  async resolveCollapsedReply(input: {
    guildId: string;
    replyId: string;
    actorUserId: string;
    actorRoleIds: string[];
    isGuildAdmin: boolean;
    action: "keep-collapsed" | "restore" | "hard-delete";
    reason?: string | null;
  }): Promise<ConsideredReply> {
    const reply = await this.getConsideredReplyTarget(input.replyId);
    if (reply.guildId !== input.guildId) {
      throw new SuggestionDomainError("not-found", "Considered Reply not found.");
    }
    await this.assertActionRateLimit(input.guildId, input.actorUserId, "moderation", 20, 60_000);
    const config = await this.getConfig(input.guildId);
    assertMod(config, input.actorRoleIds, input.isGuildAdmin);
    if (reply.state !== "collapsed") {
      throw new SuggestionDomainError("stale-interaction", "This reply was already resolved.");
    }
    if (input.action === "hard-delete" && !optionalText(input.reason, 500)) {
      throw new SuggestionDomainError("invalid-transition", "Hard Delete requires a reason.");
    }
    const state =
      input.action === "keep-collapsed"
        ? "kept_collapsed"
        : input.action === "restore"
          ? "restored"
          : "deleted";
    const next: ConsideredReply = {
      ...reply,
      state,
      resolvedAtMs: this.now(),
      resolvedByUserId: input.actorUserId,
      resolutionReason: optionalText(input.reason, 500),
      updatedAtMs: this.now(),
    };
    if (!(await this.store.updateConsideredReply(next, "collapsed"))) {
      throw new SuggestionDomainError("stale-interaction", "This reply was already resolved.");
    }
    try {
      if (state === "restored") await this.projection.restoreConsideredReply?.(next);
      if (state === "deleted") await this.projection.deleteConsideredReply?.(next);
      await this.projection.resolveConsideredReplyQueue?.(next);
    } catch (error) {
      throw providerError("The decision was saved but Discord delivery failed.", error);
    }
    await this.record(`reply.${state}`, input.guildId, input.actorUserId, {
      suggestionId: reply.suggestionId,
      consideredReplyId: reply.id,
      reason: next.resolutionReason,
    });
    return next;
  }

  async getConsideredReplyTarget(replyId: string): Promise<ConsideredReply> {
    const reply = await this.store.readConsideredReplyById(replyId);
    if (!reply) throw new SuggestionDomainError("not-found", "Considered Reply not found.");
    return reply;
  }

  async transition(input: {
    guildId: string;
    suggestionId: string;
    actorUserId: string;
    actorRoleIds: string[];
    isGuildAdmin: boolean;
    isAuthor: boolean;
    expectedRevision: number;
    toStatus: SuggestionStatus;
    reason?: string | null;
    outcome?: { summary: string; nextStepOrLink?: string | null } | null;
  }): Promise<Suggestion> {
    await this.assertActionRateLimit(input.guildId, input.actorUserId, "transition", 20, 60_000);
    const suggestion = await this.requireSuggestion(input.guildId, input.suggestionId);
    if (suggestion.revision !== input.expectedRevision) {
      throw new SuggestionDomainError("stale-interaction", "The Suggestion has changed.");
    }
    const config = await this.getConfig(input.guildId);
    const isMod =
      input.isGuildAdmin || config.modRoleIds.some((roleId) => input.actorRoleIds.includes(roleId));
    const decision = decideSuggestionStatusChange(suggestion.status, input.toStatus, {
      isModerator: isMod,
      isAuthor: input.isAuthor,
    });
    if (decision.kind === "forbidden") {
      throw new SuggestionDomainError("authority", "You cannot change this Suggestion status.");
    }
    if (decision.kind === "unchanged") {
      throw new SuggestionDomainError("invalid-transition", "The status is unchanged.");
    }
    const { reopening } = decision;
    if (reopening && !optionalText(input.reason, 500)) {
      throw new SuggestionDomainError("invalid-transition", "Reopening requires a reason.");
    }
    let outcome: SuggestionOutcome | null = null;
    if (decision.requiresOutcome) {
      if (!input.outcome?.summary.trim()) {
        throw new SuggestionDomainError(
          "invalid-transition",
          "Planned, Implemented, and Rejected require an outcome.",
        );
      }
      outcome = {
        summary: requiredText(input.outcome.summary, "Outcome", 2000),
        nextStepOrLink: optionalText(input.outcome.nextStepOrLink, 500),
        recordedByUserId: input.actorUserId,
        recordedAtMs: this.now(),
      };
    }
    const next: Suggestion = {
      ...suggestion,
      status: input.toStatus,
      outcome,
      revision: suggestion.revision + 1,
      updatedAtMs: this.now(),
    };
    if (!(await this.store.updateSuggestion(next, suggestion.revision))) {
      throw new SuggestionDomainError("stale-interaction", "The Suggestion has changed.");
    }
    await this.store.appendStatusEvent({
      id: this.createId(),
      suggestionId: suggestion.id,
      guildId: suggestion.guildId,
      fromStatus: suggestion.status,
      toStatus: next.status,
      actorUserId: input.actorUserId,
      reason: optionalText(input.reason, 500),
      outcome,
      createdAtMs: this.now(),
    });
    try {
      await this.projection.updateSuggestion?.(next);
      if (next.threadId && (isTerminalSuggestionStatus(next.status) || reopening)) {
        await this.projection.setThreadLocked?.(next, isTerminalSuggestionStatus(next.status));
      }
      await this.projection.postStatusUpdate?.(
        next,
        suggestion.status,
        optionalText(input.reason, 500),
      );
    } catch (error) {
      throw providerError("The status was saved but Discord delivery failed.", error);
    }
    try {
      await this.projection.notifyAuthorOfStatus?.(next, suggestion.status);
    } catch {
      // A blocked DM must not undo the public status decision.
    }
    await this.record("suggestion.status-changed", input.guildId, input.actorUserId, {
      suggestionId: suggestion.id,
      from: suggestion.status,
      to: next.status,
      reason: input.reason,
      outcome,
    });
    return next;
  }

  async reserveDigest(guildId: string, periodKey: string): Promise<boolean> {
    return this.store.reserveDigestRun(
      guildId,
      requiredText(periodKey, "Period key", 100),
      this.now(),
    );
  }

  async processDueDigests(): Promise<number> {
    if (!this.projection.publishDigest) return 0;
    let delivered = 0;
    for (const config of await this.store.listDigestConfigs()) {
      if (!config.enabled || !config.digestChannelId) continue;
      const periodMs = config.digestCadenceDays * DAY_MS;
      const periodKey = String(Math.floor(this.now() / periodMs));
      if (!(await this.store.reserveDigestRun(config.guildId, periodKey, this.now()))) continue;
      try {
        const all = await this.store.listSuggestions(config.guildId);
        const cutoff = this.now() - periodMs;
        const active = all.filter((item) => ACTIVE_STATUSES.has(item.status));
        const message = await this.projection.publishDigest({
          config,
          periodKey,
          newSuggestions: active.filter((item) => item.createdAtMs >= cutoff).slice(0, 5),
          needingFeedback: [...active]
            .sort(
              (left, right) =>
                left.supportCount + left.opposeCount - (right.supportCount + right.opposeCount),
            )
            .slice(0, 5),
          recentlyDecided: all
            .filter((item) => isTerminalSuggestionStatus(item.status) && item.updatedAtMs >= cutoff)
            .slice(0, 5),
        });
        await this.store.completeDigestRun(
          config.guildId,
          periodKey,
          message.messageId,
          this.now(),
        );
        console.info("suggestion_digest_delivered", {
          guildId: config.guildId,
          periodKey,
          newCount: active.filter((item) => item.createdAtMs >= cutoff).length,
          activeCount: active.length,
        });
        delivered++;
      } catch (error) {
        console.error("suggestion_digest_failed", {
          guildId: config.guildId,
          periodKey,
          error: errorMessage(error),
        });
      }
    }
    return delivered;
  }

  private async createSuggestion(input: {
    guildId: string;
    authorId: string;
    title: string;
    answers: SuggestionAnswer[];
    category: string | null;
    normalizedSearchText: string;
  }): Promise<Suggestion> {
    const nowMs = this.now();
    let suggestion: Suggestion = {
      id: this.createId(),
      ...input,
      status: "gathering_feedback",
      revision: 1,
      threadId: null,
      starterMessageId: null,
      projectionError: null,
      supportCount: 0,
      opposeCount: 0,
      outcome: null,
      createdAtMs: nowMs,
      editedAtMs: null,
      updatedAtMs: nowMs,
    };
    await this.store.createSuggestion(suggestion);
    if (this.projection.createSuggestion) {
      try {
        const projection = await this.projection.createSuggestion(suggestion);
        const next = { ...suggestion, ...projection, updatedAtMs: this.now() };
        if (await this.store.updateSuggestion(next, suggestion.revision)) suggestion = next;
      } catch (error) {
        const degraded = {
          ...suggestion,
          projectionError: errorMessage(error),
          updatedAtMs: this.now(),
        };
        await this.store.updateSuggestion(degraded, suggestion.revision);
        throw providerError("The Suggestion was saved but Discord delivery failed.", error);
      }
    }
    await this.record("suggestion.created", input.guildId, input.authorId, {
      suggestionId: suggestion.id,
    });
    return suggestion;
  }

  private assertEligible(config: SuggestionsConfig, member: SuggestionMemberContext): void {
    if (member.isBot || !member.isGuildMember) {
      throw new SuggestionDomainError("eligibility", "Only current Guild members may participate.");
    }
    if (config.voterRoleId && !member.roleIds.includes(config.voterRoleId)) {
      throw new SuggestionDomainError("eligibility", "You do not have the required voter role.");
    }
    const joinedAtMs = member.joinedAtMs;
    if (
      config.minimumTenureDays > 0 &&
      (joinedAtMs === null || joinedAtMs + config.minimumTenureDays * DAY_MS > this.now())
    ) {
      throw new SuggestionDomainError(
        "eligibility",
        "You have not met the Guild tenure requirement.",
      );
    }
  }

  private async requireSuggestion(guildId: string, id: string): Promise<Suggestion> {
    const suggestion = await this.store.readSuggestion(guildId, id);
    if (!suggestion) throw new SuggestionDomainError("not-found", "Suggestion not found.");
    return suggestion;
  }

  private async requireReply(guildId: string, id: string): Promise<ConsideredReply> {
    const reply = await this.store.readConsideredReply(guildId, id);
    if (!reply) throw new SuggestionDomainError("not-found", "Considered Reply not found.");
    return reply;
  }

  private async assertActionRateLimit(
    guildId: string,
    actorUserId: string,
    action: string,
    limit: number,
    windowMs: number,
  ): Promise<void> {
    if (!this.store.consumeActionRateLimit) return;
    const nowMs = this.now();
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    if (
      !(await this.store.consumeActionRateLimit(
        guildId,
        actorUserId,
        action,
        windowStartMs,
        limit,
        nowMs,
      ))
    ) {
      throw new SuggestionDomainError(
        "rate-limit",
        "Too many Suggestion actions. Please wait and try again.",
        true,
      );
    }
  }

  private async bestEffortProjection(suggestion: Suggestion): Promise<void> {
    try {
      await this.projection.updateSuggestion?.(suggestion);
      if (suggestion.projectionError) {
        await this.store.updateSuggestion(
          { ...suggestion, projectionError: null, updatedAtMs: this.now() },
          suggestion.revision,
        );
      }
    } catch (error) {
      console.error("suggestion_projection_failed", {
        guildId: suggestion.guildId,
        suggestionId: suggestion.id,
        error: errorMessage(error),
      });
      await this.store.updateSuggestion(
        { ...suggestion, projectionError: errorMessage(error), updatedAtMs: this.now() },
        suggestion.revision,
      );
    }
  }

  private async record(
    event: string,
    guildId: string,
    actorUserId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    console.info("suggestion_domain_event", {
      event,
      guildId,
      actorUserId,
      suggestionId: typeof detail.suggestionId === "string" ? detail.suggestionId : undefined,
      consideredReplyId:
        typeof detail.consideredReplyId === "string" ? detail.consideredReplyId : undefined,
    });
    await this.audit?.({
      event,
      guildId,
      actorUserId,
      suggestionId: typeof detail.suggestionId === "string" ? detail.suggestionId : undefined,
      consideredReplyId:
        typeof detail.consideredReplyId === "string" ? detail.consideredReplyId : undefined,
      detail,
      createdAtMs: this.now(),
    });
  }
}

function assertConfig(config: SuggestionsConfig): void {
  if (config.prompts.length < 1 || config.prompts.length > 4) {
    throw new SuggestionDomainError("invalid-transition", "Configure one to four prompts.");
  }
  if (new Set(config.prompts.map((prompt) => prompt.id)).size !== config.prompts.length) {
    throw new SuggestionDomainError("invalid-transition", "Prompt identifiers must be unique.");
  }
  if (config.collapseThreshold < 2 || config.collapseThreshold > 100) {
    throw new SuggestionDomainError("invalid-transition", "Collapse threshold must be 2–100.");
  }
  if (config.minimumTenureDays < 0 || config.minimumTenureDays > 3650) {
    throw new SuggestionDomainError("invalid-transition", "Tenure must be 0–3650 days.");
  }
  if (config.activeSuggestionLimit < 1 || config.activeSuggestionLimit > 100) {
    throw new SuggestionDomainError("invalid-transition", "Active Suggestion limit must be 1–100.");
  }
  const categories = config.categories.map((category) => normalizeSuggestionText(category));
  if (new Set(categories).size !== categories.length) {
    throw new SuggestionDomainError("invalid-transition", "Suggestion Categories must be unique.");
  }
  if (
    config.enabled &&
    (!config.forumChannelId ||
      !config.panelChannelId ||
      !config.panelMessageId ||
      !config.modQueueChannelId ||
      !config.replyWebhookId ||
      !config.replyWebhookCredentialId ||
      !SUGGESTION_STATUSES_WITHOUT_IMPORT.every((status) => config.statusTagIds[status]))
  ) {
    throw new SuggestionDomainError(
      "degraded-projection",
      "Finish resource setup and publish the Suggestion Panel before enabling Suggestions.",
    );
  }
}

const SUGGESTION_STATUSES_WITHOUT_IMPORT: SuggestionStatus[] = [
  "gathering_feedback",
  "needs_work",
  "under_review",
  "planned",
  "implemented",
  "rejected",
];

function validateAnswers(
  config: SuggestionsConfig,
  answers: SuggestionAnswer[],
): SuggestionAnswer[] {
  const byId = new Map(answers.map((answer) => [answer.promptId, answer]));
  return config.prompts.map((prompt) => {
    const answer = byId.get(prompt.id);
    if (prompt.required && !answer?.answer.trim()) {
      throw new SuggestionDomainError("invalid-transition", `${prompt.label} is required.`);
    }
    return {
      promptId: prompt.id,
      promptLabel: prompt.label,
      answer: answer?.answer.trim().slice(0, 1000) ?? "",
    };
  });
}

function validateCategory(config: SuggestionsConfig, category: string | null): string | null {
  if (!category) return null;
  const configured = config.categories.find(
    (candidate) => normalizeSuggestionText(candidate) === normalizeSuggestionText(category),
  );
  if (!configured)
    throw new SuggestionDomainError("invalid-transition", "Unknown Suggestion Category.");
  return configured;
}

function likelyDuplicate(left: string, right: string): boolean {
  if (left === right) return true;
  const a = new Set(left.split(" ").filter((word) => word.length > 2));
  const b = new Set(right.split(" ").filter((word) => word.length > 2));
  if (a.size === 0 || b.size === 0) return false;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap++;
  return overlap / Math.min(a.size, b.size) >= 0.7;
}

function assertMod(config: SuggestionsConfig, roleIds: string[], isGuildAdmin: boolean): void {
  if (!isGuildAdmin && !config.modRoleIds.some((roleId) => roleIds.includes(roleId))) {
    throw new SuggestionDomainError("authority", "A Suggestion Mod is required.");
  }
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new SuggestionDomainError("invalid-transition", `${label} is required.`);
  if (normalized.length > max) {
    throw new SuggestionDomainError("invalid-transition", `${label} is too long.`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > max) {
    throw new SuggestionDomainError("invalid-transition", "Text is too long.");
  }
  return normalized;
}

function providerError(message: string, cause: unknown): SuggestionDomainError {
  const error = new SuggestionDomainError("provider-failure", message, true);
  error.cause = cause;
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Discord provider failure";
}
