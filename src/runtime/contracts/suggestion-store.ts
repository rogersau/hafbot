import type {
  ConsideredReply,
  PendingSuggestionSubmission,
  Suggestion,
  SuggestionRevision,
  SuggestionsConfig,
  SuggestionStatusEvent,
  SuggestionVote,
  SuggestionVoteValue,
} from "../../suggestions";

export interface SuggestionStore {
  readConfig(guildId: string): Promise<SuggestionsConfig | null>;
  listDigestConfigs(): Promise<SuggestionsConfig[]>;
  upsertConfig(config: SuggestionsConfig): Promise<void>;
  readSuggestion(guildId: string, suggestionId: string): Promise<Suggestion | null>;
  readSuggestionByThread(guildId: string, threadId: string): Promise<Suggestion | null>;
  listActiveSuggestions(guildId: string): Promise<Suggestion[]>;
  listSuggestions(guildId: string): Promise<Suggestion[]>;
  listRevisions(guildId: string, suggestionId: string): Promise<SuggestionRevision[]>;
  listStatusEvents(guildId: string, suggestionId: string): Promise<SuggestionStatusEvent[]>;
  listConsideredReplies(guildId: string, suggestionId: string): Promise<ConsideredReply[]>;
  listVotes(guildId: string, suggestionId: string): Promise<SuggestionVote[]>;
  countActiveSuggestionsByAuthor(guildId: string, authorId: string): Promise<number>;
  readLatestSuggestionByAuthor(guildId: string, authorId: string): Promise<Suggestion | null>;
  createSuggestion(suggestion: Suggestion): Promise<void>;
  updateSuggestion(suggestion: Suggestion, expectedRevision: number): Promise<boolean>;
  createRevision(revision: SuggestionRevision): Promise<void>;
  appendStatusEvent(event: SuggestionStatusEvent): Promise<void>;
  upsertVote(
    guildId: string,
    suggestionId: string,
    memberId: string,
    value: SuggestionVoteValue | null,
    nowMs: number,
  ): Promise<SuggestionVote | null>;
  deactivateVotesForMember(guildId: string, memberId: string, nowMs: number): Promise<number>;
  recountVotes(guildId: string, suggestionId: string): Promise<{ support: number; oppose: number }>;
  createConsideredReply(reply: ConsideredReply): Promise<void>;
  readConsideredReplyById(replyId: string): Promise<ConsideredReply | null>;
  readConsideredReply(guildId: string, replyId: string): Promise<ConsideredReply | null>;
  readConsideredReplyByMessage(guildId: string, messageId: string): Promise<ConsideredReply | null>;
  updateConsideredReply(
    reply: ConsideredReply,
    expectedState: ConsideredReply["state"],
  ): Promise<boolean>;
  setReplyFlag(
    guildId: string,
    replyId: string,
    memberId: string,
    active: boolean,
    nowMs: number,
  ): Promise<void>;
  countReplyFlags(guildId: string, replyId: string): Promise<number>;
  listReplyFlagMemberIds(guildId: string, replyId: string): Promise<string[]>;
  savePendingSubmission(pending: PendingSuggestionSubmission): Promise<void>;
  readPendingSubmission(id: string): Promise<PendingSuggestionSubmission | null>;
  deletePendingSubmission(id: string): Promise<void>;
  reserveDigestRun(guildId: string, periodKey: string, nowMs: number): Promise<boolean>;
  completeDigestRun(
    guildId: string,
    periodKey: string,
    deliveredMessageId: string,
    nowMs: number,
  ): Promise<void>;
  consumeActionRateLimit(
    guildId: string,
    actorUserId: string,
    action: string,
    windowStartMs: number,
    limit: number,
    nowMs: number,
  ): Promise<boolean>;
}
