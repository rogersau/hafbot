export const SUGGESTION_STATUSES = [
  "gathering_feedback",
  "needs_work",
  "under_review",
  "planned",
  "implemented",
  "rejected",
] as const;

export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export type SuggestionVoteValue = "support" | "oppose";
export type ConsideredReplyPerspective = "support" | "oppose" | "mixed" | "question";
export type ConsideredReplyState =
  | "visible"
  | "collapsed"
  | "kept_collapsed"
  | "restored"
  | "deleted";

export interface SuggestionPrompt {
  id: string;
  label: string;
  required: boolean;
}

export interface SuggestionsConfig {
  guildId: string;
  enabled: boolean;
  forumChannelId: string | null;
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelTitle: string;
  panelBody: string;
  panelButtonText: string;
  prompts: SuggestionPrompt[];
  categories: string[];
  statusTagIds: Partial<Record<SuggestionStatus, string>>;
  categoryTagIds: Record<string, string>;
  replyWebhookId: string | null;
  replyWebhookCredentialId: string | null;
  modRoleIds: string[];
  modQueueChannelId: string | null;
  voterRoleId: string | null;
  minimumTenureDays: number;
  collapseThreshold: number;
  submissionCooldownSeconds: number;
  activeSuggestionLimit: number;
  digestEnabled: boolean;
  digestChannelId: string | null;
  digestCadenceDays: number;
  updatedAtMs: number;
}

export interface SuggestionAnswer {
  promptId: string;
  promptLabel: string;
  answer: string;
}

export interface Suggestion {
  id: string;
  guildId: string;
  authorId: string;
  title: string;
  normalizedSearchText: string;
  answers: SuggestionAnswer[];
  category: string | null;
  status: SuggestionStatus;
  revision: number;
  threadId: string | null;
  starterMessageId: string | null;
  projectionError: string | null;
  supportCount: number;
  opposeCount: number;
  outcome: SuggestionOutcome | null;
  createdAtMs: number;
  editedAtMs: number | null;
  updatedAtMs: number;
}

export interface SuggestionRevision {
  id: string;
  suggestionId: string;
  guildId: string;
  revision: number;
  title: string;
  answers: SuggestionAnswer[];
  category: string | null;
  editedByUserId: string;
  createdAtMs: number;
}

export interface SuggestionVote {
  suggestionId: string;
  guildId: string;
  memberId: string;
  value: SuggestionVoteValue;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SuggestionOutcome {
  summary: string;
  nextStepOrLink: string | null;
  recordedByUserId: string;
  recordedAtMs: number;
}

export interface SuggestionStatusEvent {
  id: string;
  suggestionId: string;
  guildId: string;
  fromStatus: SuggestionStatus;
  toStatus: SuggestionStatus;
  actorUserId: string;
  reason: string | null;
  outcome: SuggestionOutcome | null;
  createdAtMs: number;
}

export interface ConsideredReply {
  id: string;
  suggestionId: string;
  threadId: string | null;
  guildId: string;
  authorId: string;
  perspective: ConsideredReplyPerspective;
  reasoning: string;
  improvement: string | null;
  state: ConsideredReplyState;
  flagCount: number;
  webhookMessageId: string | null;
  queueMessageId: string | null;
  collapsedAtMs: number | null;
  resolvedAtMs: number | null;
  resolvedByUserId: string | null;
  resolutionReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PendingSuggestionSubmission {
  id: string;
  guildId: string;
  authorId: string;
  title: string;
  answers: SuggestionAnswer[];
  category: string | null;
  likelyDuplicateIds: string[];
  expiresAtMs: number;
}

export interface SuggestionMemberContext {
  isBot: boolean;
  isGuildMember: boolean;
  roleIds: string[];
  joinedAtMs: number | null;
}

export function defaultSuggestionsConfig(guildId: string, nowMs = Date.now()): SuggestionsConfig {
  return {
    guildId,
    enabled: false,
    forumChannelId: null,
    panelChannelId: null,
    panelMessageId: null,
    panelTitle: "Community Suggestions",
    panelBody: "Share a considered proposal to improve this community.",
    panelButtonText: "Create Suggestion",
    prompts: [
      { id: "change", label: "What should change?", required: true },
      { id: "benefit", label: "How would this help the community?", required: true },
      {
        id: "tradeoffs",
        label: "What trade-offs should be considered?",
        required: false,
      },
    ],
    categories: [],
    statusTagIds: {},
    categoryTagIds: {},
    replyWebhookId: null,
    replyWebhookCredentialId: null,
    modRoleIds: [],
    modQueueChannelId: null,
    voterRoleId: null,
    minimumTenureDays: 0,
    collapseThreshold: 3,
    submissionCooldownSeconds: 300,
    activeSuggestionLimit: 3,
    digestEnabled: false,
    digestChannelId: null,
    digestCadenceDays: 7,
    updatedAtMs: nowMs,
  };
}

export function normalizeSuggestionText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function isTerminalSuggestionStatus(status: SuggestionStatus): boolean {
  return status === "planned" || status === "implemented" || status === "rejected";
}
