import type {
  DiscordMessageCreate,
  DiscordMessageUpdate,
  GuildEntitlement,
  MentionProtectionActionKey,
  MentionProtectionActionClaim,
  MentionProtectionActionOutcome,
  MentionProtectionActionStatus,
  MentionProtectionBreach,
  MentionProtectionClaimInput,
  MentionProtectionCondition,
  MentionProtectionConfig,
  MentionProtectionDetection,
  MentionProtectionResponsePolicy,
  TimedRoleAssignment,
} from "../../types";
import { getGuildEntitlementLimits } from "../../types";
import type { DiscordGuildMember } from "../../discord/members";
import { isRecord } from "../../unknown-parse";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SPAM_TIMEOUT_MS = 60 * 60 * 1_000;

export interface MentionProtectionMessageDependencies {
  now(): number;
  readConfig(guildId: string): Promise<MentionProtectionConfig | null>;
  readGuildEntitlement(guildId: string): Promise<GuildEntitlement>;
  resolveChannelParent(
    channelId: string,
  ): Promise<{ parentId: string | null; type: number | null }>;
  fetchGuildMember(guildId: string, userId: string): Promise<DiscordGuildMember | null>;
  fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageCreate | null>;
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
  ): Promise<MentionProtectionActionClaim>;
  recordActionOutcome(outcome: MentionProtectionActionOutcome): Promise<void>;
  createWarningReply(
    channelId: string,
    messageId: string,
    userId: string,
    content: string,
  ): Promise<void>;
  createWarningFallback(
    channelId: string,
    messageId: string,
    userId: string,
    content: string,
  ): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  readMemberTimeoutUntil(guildId: string, userId: string): Promise<number | null>;
  applyMemberTimeout(guildId: string, userId: string, untilMs: number): Promise<void>;
  readTimedRole(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<TimedRoleAssignment | null>;
  memberHasRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  assignTimedRole(assignment: TimedRoleAssignment): Promise<void>;
  extendTimedRole(assignment: TimedRoleAssignment): Promise<void>;
  postDeletionAuditEvent(
    breaches: MentionProtectionBreach[],
    outcomes: Array<{ action: MentionProtectionActionKey; status: MentionProtectionActionStatus }>,
  ): Promise<void>;
}

export interface MentionProtectionMessageResult {
  status: "ignored" | "responded";
  reason?: string;
  breaches?: Array<{
    protection: MentionProtectionBreach["protection"];
    condition: MentionProtectionBreach["condition"];
    stage: MentionProtectionBreach["stage"];
  }>;
  actions?: Array<{
    action: MentionProtectionActionKey;
    status: MentionProtectionActionStatus;
  }>;
}

export function createDefaultMentionProtectionConfig(
  guildId: string,
  nowMs = Date.now(),
): MentionProtectionConfig {
  return {
    guildId,
    adminEnabled: false,
    spamEnabled: false,
    protectedAdminRoleIds: [],
    channelMode: "exclude",
    channelIds: [],
    excludedRoleIds: [],
    massMentionThreshold: 5,
    burstMessageThreshold: 5,
    burstWindowSeconds: 10,
    adminRepeatPeriodMs: DAY_MS,
    spamRepeatPeriodMs: DAY_MS,
    adminInitialResponse: responsePolicy(true, true),
    adminRepeatResponse: responsePolicy(true, true),
    spamInitialResponse: responsePolicy(true, true),
    spamRepeatResponse: responsePolicy(true, true, {
      type: "timeout",
      durationMs: DEFAULT_SPAM_TIMEOUT_MS,
    }),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export async function moderateMentionProtectionMessage(
  input: DiscordMessageCreate | DiscordMessageUpdate | null,
  dependencies: MentionProtectionMessageDependencies,
): Promise<MentionProtectionMessageResult> {
  const message = await normalizeMessage(input, dependencies);
  if (!message?.guild_id || !message.id || !message.channel_id || !message.author?.id) {
    return ignored("incomplete-message");
  }
  if (message.author.bot || message.webhook_id || !isEligibleMessageType(message.type)) {
    return ignored("ineligible-author-or-type");
  }

  const [config, entitlement] = await Promise.all([
    dependencies.readConfig(message.guild_id),
    dependencies.readGuildEntitlement(message.guild_id),
  ]);
  if (!config || (!config.adminEnabled && !config.spamEnabled)) return ignored("disabled");
  const paidFeatures = getGuildEntitlementLimits(entitlement.tier).paidFeatures;
  const spamEnabled = config.spamEnabled && paidFeatures;
  if (!config.adminEnabled && !spamEnabled) return ignored("feature-dormant");
  const spamMessageEligible = !(
    message.edited_timestamp &&
    parseMessageTimestamp(message.timestamp, 0) < entitlement.updatedAtMs
  );

  const authorRoles = await resolveAuthorRoles(message, dependencies);
  if (!authorRoles) return ignored("author-membership-unavailable");
  if (config.excludedRoleIds.some((roleId) => authorRoles.includes(roleId))) {
    return ignored("excluded-role");
  }

  let channel: { parentId: string | null; type: number | null };
  try {
    channel = await dependencies.resolveChannelParent(message.channel_id);
  } catch {
    return ignored("channel-metadata-unavailable");
  }
  const scopedChannelId = isThreadType(channel.type)
    ? (channel.parentId ?? message.channel_id)
    : message.channel_id;
  if (!isChannelInScope(config, scopedChannelId)) return ignored("outside-channel-scope");

  const directUserIds = explicitParsedUserMentionIds(message);
  const detections: MentionProtectionDetection[] = [];
  if (config.adminEnabled) {
    const adminDetection = await detectAdminMention(message, directUserIds, config, dependencies);
    if (adminDetection) {
      detections.push(paidFeatures ? adminDetection : withoutPaidRestrictions(adminDetection));
    }
  }
  if (spamEnabled && spamMessageEligible) {
    const spamDetection = await detectMentionSpam(message, directUserIds, config, dependencies);
    if (spamDetection) detections.push(spamDetection);
  }
  if (spamEnabled && !spamMessageEligible && detections.length === 0) {
    return ignored("pre-reactivation-edit");
  }
  if (detections.length === 0) return ignored("no-breach");

  const nowMs = dependencies.now();
  const breaches = await dependencies.claimMessageBreaches({
    guildId: message.guild_id,
    messageId: message.id,
    userId: message.author.id,
    channelId: message.channel_id,
    messageCreatedAtMs: parseMessageTimestamp(message.timestamp, nowMs),
    contentSnapshot: message.content.slice(0, 500),
    nowMs,
    detections,
  });
  const actionableBreaches = paidFeatures
    ? breaches
    : breaches.filter((breach) => breach.protection === "admin");
  if (actionableBreaches.length === 0) return ignored("already-processed");

  const actions = await executeResponse(actionableBreaches, dependencies, nowMs, paidFeatures);
  if (actions.some((outcome) => outcome.status === "deferred")) {
    throw new Error("Mention Protection actions are deferred for retry.");
  }
  return {
    status: "responded",
    breaches: actionableBreaches.map(({ protection, condition, stage }) => ({
      protection,
      condition,
      stage,
    })),
    actions,
  };
}

async function normalizeMessage(
  input: DiscordMessageCreate | DiscordMessageUpdate | null,
  dependencies: MentionProtectionMessageDependencies,
): Promise<DiscordMessageCreate | null> {
  if (!input?.id || !input.channel_id) return null;
  if (hasCompleteMessage(input)) return input;
  let fetched: DiscordMessageCreate | null;
  try {
    fetched = await dependencies.fetchMessage(input.channel_id, input.id);
  } catch {
    return null;
  }
  if (!fetched) return null;
  return {
    ...fetched,
    guild_id: fetched.guild_id ?? input.guild_id,
    member: fetched.member ?? input.member,
    edited_timestamp: fetched.edited_timestamp ?? input.edited_timestamp,
  };
}

function hasCompleteMessage(
  input: DiscordMessageCreate | DiscordMessageUpdate,
): input is DiscordMessageCreate {
  return (
    typeof input.id === "string" &&
    typeof input.channel_id === "string" &&
    typeof input.guild_id === "string" &&
    typeof input.content === "string" &&
    typeof input.author?.id === "string" &&
    typeof input.timestamp === "string" &&
    Array.isArray(input.mentions) &&
    Array.isArray(input.mention_roles) &&
    typeof input.mention_everyone === "boolean" &&
    Array.isArray(input.member?.roles)
  );
}

async function resolveAuthorRoles(
  message: DiscordMessageCreate,
  dependencies: MentionProtectionMessageDependencies,
): Promise<string[] | null> {
  if (Array.isArray(message.member?.roles)) return message.member.roles;
  let member: DiscordGuildMember | null;
  try {
    member = await dependencies.fetchGuildMember(message.guild_id!, message.author!.id!);
  } catch {
    return null;
  }
  return Array.isArray(member?.roles) ? member.roles : null;
}

function explicitParsedUserMentionIds(message: DiscordMessageCreate): string[] {
  const parsedIds = new Set((message.mentions ?? []).map((mention) => mention.id));
  const explicitIds = new Set<string>();
  const pattern = /<@!?([^>]+)>/g;
  for (const match of message.content.matchAll(pattern)) {
    const id = match[1];
    if (id && parsedIds.has(id)) explicitIds.add(id);
  }
  return [...explicitIds];
}

async function detectAdminMention(
  message: DiscordMessageCreate,
  directUserIds: string[],
  config: MentionProtectionConfig,
  dependencies: MentionProtectionMessageDependencies,
): Promise<MentionProtectionDetection | null> {
  const protectedRoles = new Set(config.protectedAdminRoleIds);
  const protectedRoleMentions = (message.mention_roles ?? []).filter((roleId) =>
    protectedRoles.has(roleId),
  );
  const protectedUserIds: string[] = [];
  for (const userId of directUserIds) {
    const mention = message.mentions?.find((candidate) => candidate.id === userId);
    let roles = mention?.member?.roles;
    if (!Array.isArray(roles)) {
      try {
        const member = await dependencies.fetchGuildMember(message.guild_id!, userId);
        roles = member?.roles;
      } catch {
        roles = undefined;
      }
    }
    if (Array.isArray(roles) && roles.some((roleId) => protectedRoles.has(roleId))) {
      protectedUserIds.push(userId);
    }
  }
  if (protectedRoleMentions.length === 0 && protectedUserIds.length === 0) return null;
  return {
    protection: "admin",
    condition: "admin-mention",
    repeatPeriodMs: config.adminRepeatPeriodMs,
    initialResponse: config.adminInitialResponse,
    repeatResponse: config.adminRepeatResponse,
    evidence: { protectedRoleIds: protectedRoleMentions, protectedUserIds },
  };
}

async function detectMentionSpam(
  message: DiscordMessageCreate,
  directUserIds: string[],
  config: MentionProtectionConfig,
  dependencies: MentionProtectionMessageDependencies,
): Promise<MentionProtectionDetection | null> {
  const massMention = directUserIds.length >= config.massMentionThreshold;
  let mentionBurst = false;
  let burstCount = 0;
  if (directUserIds.length > 0) {
    burstCount = await dependencies.recordBurstMessage({
      guildId: message.guild_id!,
      userId: message.author!.id!,
      messageId: message.id,
      messageTimestampMs: parseMessageTimestamp(message.edited_timestamp ?? message.timestamp),
      windowMs: config.burstWindowSeconds * 1_000,
    });
    mentionBurst = burstCount >= config.burstMessageThreshold;
  }
  if (!massMention && !mentionBurst) return null;
  const condition: MentionProtectionCondition = massMention
    ? mentionBurst
      ? "mass-and-burst"
      : "mass-mention"
    : "mention-burst";
  return {
    protection: "spam",
    condition,
    repeatPeriodMs: config.spamRepeatPeriodMs,
    initialResponse: config.spamInitialResponse,
    repeatResponse: config.spamRepeatResponse,
    evidence: { directUserIds, distinctUserCount: directUserIds.length, burstCount },
  };
}

async function executeResponse(
  breaches: MentionProtectionBreach[],
  dependencies: MentionProtectionMessageDependencies,
  nowMs: number,
  paidRestrictionsAvailable = true,
): Promise<Array<{ action: MentionProtectionActionKey; status: MentionProtectionActionStatus }>> {
  const first = breaches[0]!;
  const policies = breaches.map((breach) => breach.responsePolicy);
  const outcomes: Array<{
    action: MentionProtectionActionKey;
    status: MentionProtectionActionStatus;
  }> = [];
  if (policies.some((policy) => policy.reply)) {
    outcomes.push(await executeWarning(first, breaches, dependencies, nowMs));
  }
  let deletionSucceeded = false;
  if (policies.some((policy) => policy.delete)) {
    const deletion = await executeAction("delete", first, dependencies, nowMs, () =>
      dependencies.deleteMessage(first.channelId, first.messageId),
    );
    outcomes.push(deletion);
    deletionSucceeded = deletion.status === "succeeded" || deletion.status === "already-satisfied";
  }
  const timeoutDurationMs = Math.max(
    0,
    ...policies
      .map((policy) => policy.restriction)
      .filter((restriction) => restriction.type === "timeout")
      .map((restriction) => restriction.durationMs),
  );
  if (paidRestrictionsAvailable && timeoutDurationMs > 0) {
    outcomes.push(await executeTimeout(first, timeoutDurationMs, dependencies, nowMs));
  }
  const timedRoleDurations = new Map<string, number>();
  for (const policy of paidRestrictionsAvailable ? policies : []) {
    if (policy.restriction.type !== "timed-role") continue;
    timedRoleDurations.set(
      policy.restriction.roleId,
      Math.max(
        timedRoleDurations.get(policy.restriction.roleId) ?? 0,
        policy.restriction.durationMs,
      ),
    );
  }
  for (const [roleId, durationMs] of timedRoleDurations) {
    outcomes.push(await executeTimedRole(first, roleId, durationMs, dependencies, nowMs));
  }
  if (deletionSucceeded) {
    outcomes.push(
      await executeAction("audit", first, dependencies, nowMs, () =>
        dependencies.postDeletionAuditEvent(breaches, outcomes),
      ),
    );
  }
  return outcomes;
}

function withoutPaidRestrictions(
  detection: MentionProtectionDetection,
): MentionProtectionDetection {
  return {
    ...detection,
    initialResponse: { ...detection.initialResponse, restriction: { type: "none" } },
    repeatResponse: { ...detection.repeatResponse, restriction: { type: "none" } },
  };
}

async function executeTimedRole(
  breach: MentionProtectionBreach,
  roleId: string,
  durationMs: number,
  dependencies: MentionProtectionMessageDependencies,
  nowMs: number,
): Promise<{ action: `timed-role:${string}`; status: MentionProtectionActionStatus }> {
  const action = `timed-role:${roleId}` as const;
  const ledgerAction = `timed-role:${roleId}:${durationMs}` as const;
  const claim = await dependencies.claimAction(breach.guildId, breach.messageId, ledgerAction);
  if (claim !== "claimed") {
    return { action, status: claim === "deferred" ? "deferred" : "already-satisfied" };
  }
  let status: MentionProtectionActionStatus = "succeeded";
  let detail: string | undefined;
  let retryable: boolean | undefined;
  try {
    const requestedUntilMs = nowMs + durationMs;
    const existing = await dependencies.readTimedRole(breach.guildId, breach.userId, roleId);
    if (existing && existing.expiresAtMs >= requestedUntilMs) {
      status = "already-satisfied";
    } else if (
      !existing &&
      (await dependencies.memberHasRole(breach.guildId, breach.userId, roleId))
    ) {
      status = "already-satisfied";
    } else if (existing) {
      await dependencies.extendTimedRole({
        ...existing,
        durationInput: formatDuration(durationMs),
        expiresAtMs: requestedUntilMs,
      });
    } else {
      await dependencies.assignTimedRole({
        guildId: breach.guildId,
        userId: breach.userId,
        roleId,
        durationInput: formatDuration(durationMs),
        expiresAtMs: requestedUntilMs,
      });
    }
  } catch (error) {
    status = "failed";
    detail = error instanceof Error ? error.message : String(error);
    retryable = isRetryableActionError(error);
  }
  await dependencies.recordActionOutcome({
    guildId: breach.guildId,
    messageId: breach.messageId,
    action: ledgerAction,
    status,
    detail,
    retryable,
    updatedAtMs: nowMs,
  });
  return { action, status };
}

async function executeTimeout(
  breach: MentionProtectionBreach,
  durationMs: number,
  dependencies: MentionProtectionMessageDependencies,
  nowMs: number,
): Promise<{ action: "timeout"; status: MentionProtectionActionStatus }> {
  const action = "timeout" as const;
  const ledgerAction = `timeout:${durationMs}` as const;
  const claim = await dependencies.claimAction(breach.guildId, breach.messageId, ledgerAction);
  if (claim !== "claimed") {
    return { action, status: claim === "deferred" ? "deferred" : "already-satisfied" };
  }
  let status: MentionProtectionActionStatus = "succeeded";
  let detail: string | undefined;
  let retryable: boolean | undefined;
  try {
    const requestedUntilMs = nowMs + durationMs;
    const currentUntilMs = await dependencies.readMemberTimeoutUntil(breach.guildId, breach.userId);
    if (currentUntilMs !== null && currentUntilMs >= requestedUntilMs) {
      status = "already-satisfied";
    } else {
      await dependencies.applyMemberTimeout(breach.guildId, breach.userId, requestedUntilMs);
    }
  } catch (error) {
    status = "failed";
    detail = error instanceof Error ? error.message : String(error);
    retryable = isRetryableActionError(error);
  }
  await dependencies.recordActionOutcome({
    guildId: breach.guildId,
    messageId: breach.messageId,
    action: ledgerAction,
    status,
    detail,
    retryable,
    updatedAtMs: nowMs,
  });
  return { action, status };
}

async function executeWarning(
  breach: MentionProtectionBreach,
  breaches: MentionProtectionBreach[],
  dependencies: MentionProtectionMessageDependencies,
  nowMs: number,
) {
  const content = buildWarningContent(breaches);
  return executeAction("reply", breach, dependencies, nowMs, async () => {
    try {
      await dependencies.createWarningReply(
        breach.channelId,
        breach.messageId,
        breach.userId,
        content,
      );
    } catch {
      await dependencies.createWarningFallback(
        breach.channelId,
        breach.messageId,
        breach.userId,
        content,
      );
    }
  });
}

async function executeAction(
  action: MentionProtectionActionKey,
  breach: MentionProtectionBreach,
  dependencies: MentionProtectionMessageDependencies,
  nowMs: number,
  run: () => Promise<void>,
): Promise<{ action: MentionProtectionActionKey; status: MentionProtectionActionStatus }> {
  const claim = await dependencies.claimAction(breach.guildId, breach.messageId, action);
  if (claim !== "claimed") {
    return { action, status: claim === "deferred" ? "deferred" : "already-satisfied" };
  }
  let status: MentionProtectionActionStatus = "succeeded";
  let detail: string | undefined;
  let retryable: boolean | undefined;
  try {
    await run();
  } catch (error) {
    status = "failed";
    detail = error instanceof Error ? error.message : String(error);
    retryable = isRetryableActionError(error);
  }
  await dependencies.recordActionOutcome({
    guildId: breach.guildId,
    messageId: breach.messageId,
    action,
    status,
    detail,
    retryable,
    updatedAtMs: nowMs,
  });
  return { action, status };
}

function buildWarningContent(breaches: MentionProtectionBreach[]): string {
  const labels = breaches.map((breach) =>
    breach.protection === "admin" ? "Admin Mention Protection" : "Mention Spam Protection",
  );
  return `Your message breached ${labels.join(" and ")}.`;
}

function isRetryableActionError(error: unknown): boolean {
  const status = isRecord(error) ? error.status : undefined;
  return typeof status !== "number" || status === 429 || status >= 500;
}

function isChannelInScope(config: MentionProtectionConfig, channelId: string): boolean {
  if (config.channelIds.length === 0) return true;
  const selected = config.channelIds.includes(channelId);
  return config.channelMode === "include" ? selected : !selected;
}

function isEligibleMessageType(type: number | undefined): boolean {
  return type === undefined || type === 0 || type === 19;
}

function isThreadType(type: number | null): boolean {
  return type === 10 || type === 11 || type === 12;
}

function parseMessageTimestamp(
  timestamp: string | null | undefined,
  fallback = Date.now(),
): number {
  if (!timestamp) return fallback;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDuration(durationMs: number): string {
  if (durationMs % (60 * 60 * 1_000) === 0) return `${durationMs / (60 * 60 * 1_000)}h`;
  return `${Math.ceil(durationMs / (60 * 1_000))}m`;
}

function ignored(reason: string): MentionProtectionMessageResult {
  return { status: "ignored", reason };
}

function responsePolicy(
  reply: boolean,
  deleteMessage: boolean,
  restriction: MentionProtectionResponsePolicy["restriction"] = { type: "none" },
): MentionProtectionResponsePolicy {
  return { reply, delete: deleteMessage, restriction };
}
