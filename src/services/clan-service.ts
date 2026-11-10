import { nextClanProvisioningStep, nextClanCleanupStep } from "./clan-resource-workflow";
import {
  defaultClanManagementConfig,
  normalizeClanIdentity,
  type Clan,
  type ClanActivityType,
  type ClanApplication,
  type ClanHistoryEvent,
  type ClanInvitation,
  type ClanManagementConfig,
  type ClanMembership,
  type ClanRank,
  type ClanRecruitmentState,
  type ClanRequest,
  type ClanReviewDecision,
} from "../clans";
import { getGuildEntitlementLimits, type GuildEntitlementTier } from "../types";
import type { ClanStore } from "../runtime/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 365 * DAY_MS;

export interface ClanDiscordApi {
  createCategory(input: { guildId: string; name: string }): Promise<{ id: string }>;
  createRole(input: { guildId: string; name: string }): Promise<{ id: string }>;
  createTextChannel(input: ClanChannelInput): Promise<{ id: string }>;
  createVoiceChannel(input: ClanChannelInput): Promise<{ id: string }>;
  addMemberRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeMemberRole(guildId: string, userId: string, roleId: string): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
  deleteRole(guildId: string, roleId: string): Promise<void>;
  setClanArchivedPermissions(input: {
    guildId: string;
    clan: Clan;
    archived: boolean;
    botUserId: string;
    staffRoleIds: string[];
  }): Promise<void>;
  inspectClanResources?(input: {
    guildId: string;
    clan: Clan;
    categoryId: string | null;
  }): Promise<string[]>;
  upsertBoardProjection?(input: {
    clan: Clan;
    memberships: ClanMembership[];
    config: ClanManagementConfig;
  }): Promise<{ id: string; channelId: string }>;
  deleteBoardProjection?(channelId: string, projectionId: string): Promise<void>;
  sendDm?(userId: string, message: string): Promise<void>;
  upsertRequestPanel?(input: { config: ClanManagementConfig }): Promise<{ messageId: string }>;
  createRequestReviewTicket?(input: {
    request: ClanRequest;
    config: ClanManagementConfig;
    botUserId: string;
  }): Promise<{ channelId: string; messageId: string }>;
  updateRequestReviewTicket?(input: {
    request: ClanRequest;
    config: ClanManagementConfig;
    botUserId: string;
  }): Promise<void>;
}

export interface ClanChannelInput {
  guildId: string;
  parentId: string;
  name: string;
  clanRoleId: string;
  botUserId: string;
  staffRoleIds: string[];
}

export interface ClanEntitlementResolver {
  getTier(guildId: string): Promise<GuildEntitlementTier>;
}

export type ClanAuditWriter = (event: ClanHistoryEvent) => Promise<void>;

export interface ClanJoinRecovery {
  kind: "membership-join";
  source: "application" | "invitation";
  guildId: string;
  clanId: string;
  sourceId: string;
  userId: string;
  rank: Exclude<ClanRank, "owner">;
}

export interface ClanRequestEligibility {
  isBot: boolean;
  roleIds: string[];
  accountCreatedAtMs: number;
  guildJoinedAtMs: number;
}

export class ClanDomainError extends Error {
  constructor(
    public readonly code:
      | "eligibility"
      | "authority"
      | "duplicate-identity"
      | "existing-membership"
      | "limit"
      | "stale-request"
      | "invalid-transition"
      | "blocked"
      | "discord-permission"
      | "provider-failure"
      | "degraded-resource"
      | "partial-cleanup"
      | "not-found",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ClanDomainError";
  }
}

export class ClanJoinRecoveryError extends ClanDomainError {
  constructor(
    message: string,
    public readonly recovery: ClanJoinRecovery,
  ) {
    super("provider-failure", message, true);
    this.name = "ClanJoinRecoveryError";
  }
}

export class ClanService {
  constructor(
    private readonly store: ClanStore,
    private readonly discord: ClanDiscordApi,
    private readonly entitlements: ClanEntitlementResolver,
    private readonly botUserId: string,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly audit?: ClanAuditWriter,
  ) {}

  async getConfig(guildId: string): Promise<ClanManagementConfig> {
    return (
      (await this.store.readConfig(guildId)) ?? defaultClanManagementConfig(guildId, this.now())
    );
  }

  async updateConfig(config: ClanManagementConfig): Promise<ClanManagementConfig> {
    const limits = getGuildEntitlementLimits(await this.entitlements.getTier(config.guildId));
    assertLocalLimit("clans", config.localClansMax, limits.clansMax ?? null);
    assertLocalLimit("members", config.localMembersMax, limits.clanMembersMax ?? null);
    assertLocalLimit("officers", config.localOfficersMax, limits.clanOfficersMax ?? null);
    if (config.inactivityArchiveDays <= config.inactivityWarningDays) {
      throw new ClanDomainError(
        "invalid-transition",
        "The archive threshold must be later than the warning threshold.",
      );
    }
    const next = { ...config, updatedAtMs: this.now() };
    await this.store.upsertConfig(next);
    return next;
  }

  async publishRequestPanel(guildId: string, actorUserId: string): Promise<ClanManagementConfig> {
    const config = await this.getConfig(guildId);
    if (!config.requestPanelChannelId)
      throw new ClanDomainError("invalid-transition", "Choose a Clan request panel channel first.");
    if (!config.requestReviewCategoryId)
      throw new ClanDomainError(
        "invalid-transition",
        "Choose a Clan review-ticket category first.",
      );
    if (config.reviewerRoleIds.length === 0)
      throw new ClanDomainError(
        "invalid-transition",
        "Choose at least one Clan review role first.",
      );
    if (!this.discord.upsertRequestPanel)
      throw new ClanDomainError(
        "provider-failure",
        "Clan request panel publishing is unavailable.",
      );
    const before = config;
    const { messageId } = await this.discord.upsertRequestPanel({ config });
    const next = { ...config, requestPanelMessageId: messageId, updatedAtMs: this.now() };
    await this.store.upsertConfig(next);
    await this.record("request.panel-published", actorUserId, {
      guildId,
      before,
      after: next,
    });
    return next;
  }

  async submitRequest(input: {
    guildId: string;
    requesterId: string;
    name: string;
    tag: string;
    description: string;
    focus: string;
    recruitmentState: ClanRecruitmentState;
    proposedOfficerIds?: string[];
    eligibility: ClanRequestEligibility;
  }): Promise<ClanRequest> {
    const nowMs = this.now();
    const config = await this.getConfig(input.guildId);
    this.assertEligible(config, input.eligibility, nowMs);
    if (await this.store.readActiveMembership(input.guildId, input.requesterId)) {
      throw new ClanDomainError(
        "existing-membership",
        "A member can belong to only one clan in this Guild.",
      );
    }
    if (await this.store.readPendingRequestByRequester(input.guildId, input.requesterId)) {
      throw new ClanDomainError("invalid-transition", "You already have a pending Clan Request.");
    }
    const latest = await this.store.readLatestTerminalRequest(input.guildId, input.requesterId);
    if (latest?.terminalAtMs && latest.terminalAtMs + config.requestCooldownDays * DAY_MS > nowMs) {
      throw new ClanDomainError("eligibility", "The Clan Request cooldown has not elapsed.");
    }
    await this.assertClanCapacity(input.guildId, config);
    const name = requiredText(input.name, "Clan name", 100);
    const tag = requiredText(input.tag, "Clan tag", 12);
    const request: ClanRequest = {
      id: this.createId(),
      guildId: input.guildId,
      requesterId: input.requesterId,
      name,
      normalizedName: normalizeClanIdentity(name),
      tag,
      normalizedTag: normalizeClanIdentity(tag),
      description: requiredText(input.description, "Description", 1000),
      focus: requiredText(input.focus, "Game or platform focus", 200),
      recruitmentState: input.recruitmentState,
      proposedOfficerIds: uniqueIds(input.proposedOfficerIds ?? []).filter(
        (id) => id !== input.requesterId,
      ),
      status: "pending",
      revision: 1,
      reviewerId: null,
      reviewReason: null,
      clanId: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      terminalAtMs: null,
      retentionExpiresAtMs: null,
      reviewChannelId: null,
      reviewMessageId: null,
      reviewTicketState: "pending",
      reviewTicketError: null,
    };
    try {
      await this.store.createRequest(request);
    } catch (error) {
      throw mapConstraintError(
        error,
        "A Clan with that name or tag, or a pending request, already exists.",
      );
    }
    await this.record("request.submitted", input.requesterId, {
      requestId: request.id,
      guildId: request.guildId,
      after: request,
    });
    if (config.requestReviewCategoryId && config.reviewerRoleIds.length > 0) {
      await this.ensureRequestReviewTicket(request.guildId, request.id);
    }
    return request;
  }

  async ensureRequestReviewTicket(guildId: string, requestId: string): Promise<ClanRequest> {
    let request = await this.requireRequest(guildId, requestId);
    if (request.reviewTicketState === "open" && request.reviewChannelId && request.reviewMessageId)
      return request;
    const config = await this.getConfig(guildId);
    if (!config.requestReviewCategoryId || config.reviewerRoleIds.length === 0)
      throw new ClanDomainError(
        "invalid-transition",
        "Clan request review tickets are not configured.",
      );
    if (!this.discord.createRequestReviewTicket)
      throw new ClanDomainError("provider-failure", "Clan review-ticket creation is unavailable.");
    const claimed = await this.store.claimRequestReviewTicket(
      guildId,
      request.id,
      request.revision,
      this.now(),
    );
    if (!claimed) {
      request = await this.requireRequest(guildId, requestId);
      if (request.reviewTicketState === "open") return request;
      throw new ClanDomainError(
        "provider-failure",
        "The Clan review ticket is already being created. Retry shortly.",
        true,
      );
    }
    request = { ...request, reviewTicketState: "creating", reviewTicketError: null };
    try {
      const ticket = await this.discord.createRequestReviewTicket({
        request,
        config,
        botUserId: this.botUserId,
      });
      const next: ClanRequest = {
        ...request,
        reviewChannelId: ticket.channelId,
        reviewMessageId: ticket.messageId,
        reviewTicketState: "open",
        reviewTicketError: null,
        updatedAtMs: this.now(),
      };
      if (!(await this.store.updateRequest(next, request.revision)))
        throw new ClanDomainError(
          "stale-request",
          "The Clan Request changed during ticket creation.",
        );
      await this.record("request.review-ticket-opened", request.requesterId, {
        guildId,
        requestId: request.id,
        after: next,
      });
      return next;
    } catch (error) {
      const failed: ClanRequest = {
        ...request,
        reviewTicketState: "pending",
        reviewTicketError: errorMessage(error),
        updatedAtMs: this.now(),
      };
      await this.store.updateRequest(failed, request.revision);
      throw new ClanDomainError(
        "provider-failure",
        `The request was saved, but its review ticket is pending recovery: ${errorMessage(error)}`,
        true,
      );
    }
  }

  async resumeRequestReviewTicket(guildId: string, requestId: string): Promise<ClanRequest> {
    const request = await this.requireRequest(guildId, requestId);
    if (request.reviewTicketState === "decision-pending") {
      await this.syncRequestReviewTicket(request);
      return (await this.store.readRequest(guildId, requestId)) ?? request;
    }
    return this.ensureRequestReviewTicket(guildId, requestId);
  }

  async reviseRequest(input: {
    guildId: string;
    requestId: string;
    requesterId: string;
    expectedRevision: number;
    name: string;
    tag: string;
    description: string;
    focus: string;
    recruitmentState: ClanRecruitmentState;
    proposedOfficerIds?: string[];
  }): Promise<ClanRequest> {
    const request = await this.requireRequest(input.guildId, input.requestId);
    if (request.requesterId !== input.requesterId)
      throw new ClanDomainError("authority", "Only the requester can revise this request.");
    if (request.status !== "changes-requested")
      throw new ClanDomainError("invalid-transition", "This request is not awaiting changes.");
    if (request.revision !== input.expectedRevision)
      throw new ClanDomainError(
        "stale-request",
        "This request has changed. Refresh and try again.",
      );
    const next: ClanRequest = {
      ...request,
      name: requiredText(input.name, "Clan name", 100),
      tag: requiredText(input.tag, "Clan tag", 12),
      description: requiredText(input.description, "Description", 1000),
      focus: requiredText(input.focus, "Focus", 200),
      recruitmentState: input.recruitmentState,
      proposedOfficerIds: uniqueIds(input.proposedOfficerIds ?? []).filter(
        (id) => id !== input.requesterId,
      ),
      status: "pending",
      revision: request.revision + 1,
      reviewerId: null,
      reviewReason: null,
      updatedAtMs: this.now(),
    };
    next.normalizedName = normalizeClanIdentity(next.name);
    next.normalizedTag = normalizeClanIdentity(next.tag);
    if (!(await this.store.updateRequest(next, request.revision)))
      throw new ClanDomainError(
        "stale-request",
        "This request has changed. Refresh and try again.",
      );
    await this.record("request.resubmitted", input.requesterId, {
      requestId: request.id,
      guildId: request.guildId,
      before: request,
      after: next,
    });
    await this.syncRequestReviewTicket(next);
    return next;
  }

  async reviewRequest(input: {
    guildId: string;
    requestId: string;
    reviewerId: string;
    reviewerRoleIds: string[];
    isGuildAdmin: boolean;
    expectedRevision: number;
    decision: ClanReviewDecision;
    reason?: string;
  }): Promise<ClanRequest | Clan> {
    const request = await this.requireRequest(input.guildId, input.requestId);
    const config = await this.getConfig(input.guildId);
    assertReviewer(config, input.reviewerRoleIds, input.isGuildAdmin);
    if (request.status !== "pending" || request.revision !== input.expectedRevision)
      throw new ClanDomainError(
        "stale-request",
        "This request is no longer pending at that revision.",
      );
    const nowMs = this.now();
    if (input.decision !== "approve") {
      const reason = requiredText(input.reason, "Review reason", 1000);
      const next: ClanRequest = {
        ...request,
        status: input.decision === "reject" ? "rejected" : "changes-requested",
        reviewerId: input.reviewerId,
        reviewReason: reason,
        revision: request.revision + 1,
        updatedAtMs: nowMs,
        terminalAtMs: input.decision === "reject" ? nowMs : null,
        retentionExpiresAtMs: input.decision === "reject" ? nowMs + HISTORY_RETENTION_MS : null,
      };
      if (!(await this.store.updateRequest(next, request.revision)))
        throw new ClanDomainError("stale-request", "This request was reviewed elsewhere.");
      await this.record(`request.${input.decision}`, input.reviewerId, {
        requestId: request.id,
        guildId: request.guildId,
        reason,
        before: request,
        after: next,
      });
      await this.tryDm(
        request.requesterId,
        `Your Clan Request for ${request.name} was ${input.decision === "reject" ? "rejected" : "returned for changes"}: ${reason}`,
      );
      await this.syncRequestReviewTicket(next);
      return next;
    }
    await this.assertClanCapacity(input.guildId, config);
    let clan = await this.store.readClanByRequest(request.id);
    if (!clan) {
      clan = {
        id: this.createId(),
        guildId: request.guildId,
        requestId: request.id,
        name: request.name,
        normalizedName: request.normalizedName,
        tag: request.tag,
        normalizedTag: request.normalizedTag,
        description: request.description,
        focus: request.focus,
        icon: null,
        recruitmentState: request.recruitmentState,
        lifecycleState: "provisioning",
        roleId: null,
        textChannelId: null,
        voiceChannelId: null,
        boardProjectionId: null,
        boardProjectionChannelId: null,
        operation: "provision",
        degradedReason: null,
        sensitiveManagementFrozen: false,
        clanLfgLeadershipOnly: false,
        latestActivityAtMs: nowMs,
        latestActivityType: "management",
        inactivityWarnedAtMs: null,
        deletionDueAtMs: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        permanentlyDeletedAtMs: null,
      };
      try {
        await this.store.createClan(clan);
      } catch (error) {
        throw mapConstraintError(error, "A Clan with that name or tag already exists.");
      }
    }
    return this.resumeProvisioning({
      clan,
      request,
      config,
      reviewerId: input.reviewerId,
      expectedRequestRevision: request.revision,
    });
  }

  async resumeProvisioning(input: {
    clan: Clan;
    request: ClanRequest;
    config?: ClanManagementConfig;
    reviewerId: string;
    expectedRequestRevision: number;
  }): Promise<Clan> {
    let { clan } = input;
    const config = input.config ?? (await this.getConfig(clan.guildId));
    try {
      let step = nextClanProvisioningStep(clan, config.categoryId);
      while (step !== "resources-ready") {
        switch (step) {
          case "create-category": {
            const category = await this.discord.createCategory({
              guildId: clan.guildId,
              name: "HAF Clans",
            });
            await this.store.upsertConfig({
              ...config,
              categoryId: category.id,
              updatedAtMs: this.now(),
            });
            config.categoryId = category.id;
            break;
          }
          case "create-role": {
            const role = await this.discord.createRole({
              guildId: clan.guildId,
              name: renderTemplate(config.roleNameTemplate, clan),
            });
            clan = await this.persistClanResource(clan, { roleId: role.id });
            break;
          }
          case "create-text-channel": {
            const channel = await this.discord.createTextChannel(
              this.channelInput(clan, config, renderTemplate(config.textChannelNameTemplate, clan)),
            );
            clan = await this.persistClanResource(clan, { textChannelId: channel.id });
            break;
          }
          case "create-voice-channel": {
            const channel = await this.discord.createVoiceChannel(
              this.channelInput(
                clan,
                config,
                renderTemplate(config.voiceChannelNameTemplate, clan),
              ),
            );
            clan = await this.persistClanResource(clan, { voiceChannelId: channel.id });
            break;
          }
        }
        const nextStep = nextClanProvisioningStep(clan, config.categoryId);
        if (nextStep === step)
          throw new ClanDomainError(
            "provider-failure",
            "Clan resource provisioning did not advance.",
            true,
          );
        step = nextStep;
      }
      if (!clan.roleId)
        throw new ClanDomainError(
          "provider-failure",
          "Clan Role provisioning did not complete.",
          true,
        );
      let owner = await this.store.readActiveMembership(clan.guildId, input.request.requesterId);
      if (owner && (owner.clanId !== clan.id || owner.rank !== "owner")) {
        throw new ClanDomainError(
          "existing-membership",
          "The requester joined another Clan before provisioning completed.",
        );
      }
      if (!owner) {
        await this.discord.addMemberRole(clan.guildId, input.request.requesterId, clan.roleId);
        owner = {
          clanId: clan.id,
          guildId: clan.guildId,
          userId: input.request.requesterId,
          rank: "owner",
          joinedAtMs: this.now(),
          leftAtMs: null,
        };
        await this.store.createMembership(owner);
      }
      clan = {
        ...clan,
        lifecycleState: "active",
        operation: null,
        degradedReason: null,
        updatedAtMs: this.now(),
      };
      await this.store.updateClan(clan);
      const approved: ClanRequest = {
        ...input.request,
        status: "approved",
        reviewerId: input.reviewerId,
        reviewReason: null,
        clanId: clan.id,
        revision: input.request.revision + 1,
        updatedAtMs: this.now(),
        terminalAtMs: this.now(),
        retentionExpiresAtMs: this.now() + HISTORY_RETENTION_MS,
      };
      const changed = await this.store.updateRequest(approved, input.expectedRequestRevision);
      if (!changed && input.request.status !== "approved")
        throw new ClanDomainError(
          "stale-request",
          "The request changed while provisioning completed.",
        );
      for (const officerId of input.request.proposedOfficerIds)
        await this.createInvitation({
          guildId: clan.guildId,
          clanId: clan.id,
          actorUserId: owner.userId,
          inviteeId: officerId,
          intendedRank: "officer",
        });
      await this.syncBoard(clan);
      await this.record("provisioning.completed", input.reviewerId, {
        guildId: clan.guildId,
        clanId: clan.id,
        requestId: input.request.id,
        after: clan,
      });
      await this.tryDm(owner.userId, `Your Clan ${clan.name} has been approved and provisioned.`);
      await this.syncRequestReviewTicket(approved);
      return clan;
    } catch (error) {
      if (
        error instanceof ClanDomainError &&
        ["stale-request", "existing-membership", "authority", "limit"].includes(error.code)
      )
        throw error;
      clan = { ...clan, degradedReason: errorMessage(error), updatedAtMs: this.now() };
      await this.store.updateClan(clan);
      throw new ClanDomainError(
        "provider-failure",
        `Clan provisioning is incomplete: ${errorMessage(error)}`,
        true,
      );
    }
  }

  private async syncRequestReviewTicket(request: ClanRequest): Promise<void> {
    if (!request.reviewChannelId || !request.reviewMessageId) return;
    if (!this.discord.updateRequestReviewTicket) return;
    const config = await this.getConfig(request.guildId);
    try {
      await this.discord.updateRequestReviewTicket({ request, config, botUserId: this.botUserId });
      const closed = request.status === "approved" || request.status === "rejected";
      const next: ClanRequest = {
        ...request,
        reviewTicketState: closed ? "closed" : "open",
        reviewTicketError: null,
        updatedAtMs: this.now(),
      };
      await this.store.updateRequest(next, request.revision);
    } catch (error) {
      const pending: ClanRequest = {
        ...request,
        reviewTicketState: "decision-pending",
        reviewTicketError: errorMessage(error),
        updatedAtMs: this.now(),
      };
      await this.store.updateRequest(pending, request.revision);
    }
  }

  async createInvitation(input: {
    guildId: string;
    clanId: string;
    actorUserId: string;
    inviteeId: string;
    intendedRank?: Exclude<ClanRank, "owner">;
  }): Promise<ClanInvitation> {
    const clan = await this.requireManageableClan(input.guildId, input.clanId);
    const actor = await this.assertLeader(clan, input.actorUserId);
    if (input.intendedRank === "officer" && actor.rank !== "owner")
      throw new ClanDomainError("authority", "Only the Clan Owner can appoint Officers.");
    if (await this.store.readActiveMembership(input.guildId, input.inviteeId))
      throw new ClanDomainError("existing-membership", "That member already belongs to a clan.");
    const config = await this.getConfig(input.guildId);
    const nowMs = this.now();
    const invitation: ClanInvitation = {
      id: this.createId(),
      clanId: clan.id,
      guildId: clan.guildId,
      inviteeId: input.inviteeId,
      invitedByUserId: input.actorUserId,
      intendedRank: input.intendedRank ?? "member",
      status: "pending",
      expiresAtMs: nowMs + config.invitationExpiryDays * DAY_MS,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.createInvitation(invitation);
    await this.record("invitation.created", input.actorUserId, {
      guildId: clan.guildId,
      clanId: clan.id,
      after: invitation,
    });
    await this.tryDm(
      input.inviteeId,
      `You have been invited to join ${clan.name}. Use /clan manage to respond.`,
    );
    return invitation;
  }

  async acceptInvitation(
    guildId: string,
    invitationId: string,
    userId: string,
  ): Promise<ClanMembership> {
    const invitation = await this.store.readInvitation(guildId, invitationId);
    if (!invitation) throw new ClanDomainError("not-found", "Invitation not found.");
    if (invitation.inviteeId !== userId)
      throw new ClanDomainError("authority", "Only the invited member can accept.");
    if (
      !["pending", "accepting"].includes(invitation.status) ||
      invitation.expiresAtMs <= this.now()
    )
      throw new ClanDomainError("invalid-transition", "This invitation is no longer active.");
    const clan = await this.requireManageableClan(guildId, invitation.clanId);
    return this.joinClan(
      clan,
      userId,
      invitation.intendedRank,
      { kind: "invitation", value: invitation },
      "invitation.accepted",
    );
  }

  async apply(input: {
    guildId: string;
    clanId: string;
    applicantId: string;
    message: string;
    experience?: string;
    availability?: string;
    playStyle?: string;
  }): Promise<ClanApplication> {
    const clan = await this.requireManageableClan(input.guildId, input.clanId);
    if (clan.recruitmentState !== "applications-open")
      throw new ClanDomainError("invalid-transition", "This Clan is not accepting applications.");
    if (await this.store.readActiveMembership(input.guildId, input.applicantId))
      throw new ClanDomainError("existing-membership", "You already belong to a Clan.");
    if (await this.store.readActiveMembershipBlock(clan.id, input.applicantId, this.now()))
      throw new ClanDomainError("blocked", "You are temporarily blocked from joining this Clan.");
    const config = await this.getConfig(input.guildId);
    const nowMs = this.now();
    const application: ClanApplication = {
      id: this.createId(),
      clanId: clan.id,
      guildId: clan.guildId,
      applicantId: input.applicantId,
      message: requiredText(input.message, "Application message", 1000),
      experience: optionalText(input.experience, 500),
      availability: optionalText(input.availability, 500),
      playStyle: optionalText(input.playStyle, 500),
      status: "pending",
      decidedByUserId: null,
      decisionReason: null,
      expiresAtMs: nowMs + config.applicationExpiryDays * DAY_MS,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.createApplication(application);
    await this.record("application.submitted", input.applicantId, {
      guildId: clan.guildId,
      clanId: clan.id,
      after: application,
    });
    return application;
  }

  async reviewApplication(input: {
    guildId: string;
    applicationId: string;
    actorUserId: string;
    accept: boolean;
    reason?: string;
  }): Promise<ClanApplication | ClanMembership> {
    const application = await this.store.readApplication(input.guildId, input.applicationId);
    if (!application) throw new ClanDomainError("not-found", "Application not found.");
    const clan = await this.requireManageableClan(input.guildId, application.clanId);
    await this.assertLeader(clan, input.actorUserId);
    if (
      !["pending", "accepting"].includes(application.status) ||
      application.expiresAtMs <= this.now()
    )
      throw new ClanDomainError("invalid-transition", "This application is no longer pending.");
    if (!input.accept) {
      application.status = "rejected";
      application.decidedByUserId = input.actorUserId;
      application.decisionReason = requiredText(input.reason, "Decision reason", 1000);
      application.updatedAtMs = this.now();
      await this.store.updateApplication(application);
      await this.record("application.rejected", input.actorUserId, {
        guildId: clan.guildId,
        clanId: clan.id,
        reason: application.decisionReason,
        after: application,
      });
      return application;
    }
    return this.joinClan(
      clan,
      application.applicantId,
      "member",
      { kind: "application", value: application, decidedByUserId: input.actorUserId },
      "application.accepted",
      input.actorUserId,
    );
  }

  async leaveClan(guildId: string, userId: string): Promise<void> {
    const membership = await this.store.readActiveMembership(guildId, userId);
    if (!membership) throw new ClanDomainError("not-found", "Active Clan membership not found.");
    if (membership.rank === "owner")
      throw new ClanDomainError(
        "invalid-transition",
        "The Clan Owner must transfer ownership before leaving.",
      );
    const clan = await this.requireClan(guildId, membership.clanId);
    membership.leftAtMs = this.now();
    await this.store.updateMembership(membership);
    if (clan.roleId) await this.discord.removeMemberRole(guildId, userId, clan.roleId);
    await this.touchActivity(clan, "membership");
    await this.syncBoard(clan);
    await this.record("membership.left", userId, { guildId, clanId: clan.id, before: membership });
  }

  async archiveClan(
    guildId: string,
    clanId: string,
    actorUserId: string,
    reason: string,
  ): Promise<Clan> {
    let clan = await this.requireClan(guildId, clanId);
    requiredText(reason, "Reason", 1000);
    const resuming = clan.lifecycleState === "archived" && clan.operation === "archive";
    if (!resuming && !["active", "degraded"].includes(clan.lifecycleState))
      throw new ClanDomainError("invalid-transition", "Only an active Clan can be archived.");
    if (!resuming) {
      clan = {
        ...clan,
        lifecycleState: "archived",
        recruitmentState: "closed",
        operation: "archive",
        updatedAtMs: this.now(),
      };
      await this.store.updateClan(clan);
    }
    const config = await this.getConfig(guildId);
    await this.discord.setClanArchivedPermissions({
      guildId,
      clan,
      archived: true,
      botUserId: this.botUserId,
      staffRoleIds: config.staffAccessRoleIds,
    });
    clan = { ...clan, operation: null, updatedAtMs: this.now() };
    await this.store.updateClan(clan);
    await this.removeBoardProjection(clan);
    await this.record("lifecycle.archived", actorUserId, { guildId, clanId, reason, after: clan });
    return clan;
  }

  async beginDeletionRecovery(
    guildId: string,
    clanId: string,
    actorUserId: string,
    reason: string,
  ): Promise<Clan> {
    const clan = await this.requireClan(guildId, clanId);
    requiredText(reason, "Reason", 1000);
    const resuming =
      clan.lifecycleState === "deletion-recovery" &&
      clan.operation === "deletion-recovery-permissions";
    let next = resuming
      ? clan
      : {
          ...clan,
          lifecycleState: "deletion-recovery" as const,
          recruitmentState: "closed" as const,
          deletionDueAtMs: this.now() + 7 * DAY_MS,
          operation: "deletion-recovery-permissions",
          updatedAtMs: this.now(),
        };
    if (!resuming) await this.store.updateClan(next);
    const config = await this.getConfig(guildId);
    await this.discord.setClanArchivedPermissions({
      guildId,
      clan: next,
      archived: true,
      botUserId: this.botUserId,
      staffRoleIds: config.staffAccessRoleIds,
    });
    next = { ...next, operation: null, updatedAtMs: this.now() };
    await this.store.updateClan(next);
    await this.removeBoardProjection(next);
    await this.record(
      resuming ? "deletion.recovery-resumed" : "deletion.recovery-started",
      actorUserId,
      {
        guildId,
        clanId,
        reason,
        before: clan,
        after: next,
      },
    );
    return next;
  }

  async permanentlyDelete(guildId: string, clanId: string, actorUserId: string): Promise<Clan> {
    let clan = await this.requireClan(guildId, clanId);
    if (
      clan.lifecycleState !== "deletion-recovery" ||
      !clan.deletionDueAtMs ||
      clan.deletionDueAtMs > this.now()
    )
      throw new ClanDomainError(
        "invalid-transition",
        "The deletion recovery period has not elapsed.",
      );
    clan = { ...clan, operation: "delete", updatedAtMs: this.now() };
    await this.store.updateClan(clan);
    try {
      const roleId = clan.roleId;
      for (const member of await this.store.listActiveMemberships(clan.id)) {
        if (roleId)
          await tolerateMissing(() =>
            this.discord.removeMemberRole(guildId, member.userId, roleId),
          );
        member.leftAtMs = this.now();
        await this.store.updateMembership(member);
      }
      let cleanup = nextClanCleanupStep(clan);
      while (cleanup.kind !== "resources-removed") {
        const resourceId = cleanup.resourceId;
        switch (cleanup.kind) {
          case "delete-text-channel":
            await tolerateMissing(() => this.discord.deleteChannel(resourceId));
            clan = await this.persistClanResource(clan, { textChannelId: null });
            break;
          case "delete-voice-channel":
            await tolerateMissing(() => this.discord.deleteChannel(resourceId));
            clan = await this.persistClanResource(clan, { voiceChannelId: null });
            break;
          case "delete-role":
            await tolerateMissing(() => this.discord.deleteRole(guildId, resourceId));
            clan = await this.persistClanResource(clan, { roleId: null });
            break;
        }
        cleanup = nextClanCleanupStep(clan);
      }
      clan = {
        ...clan,
        lifecycleState: "permanently-deleted",
        operation: null,
        permanentlyDeletedAtMs: this.now(),
        updatedAtMs: this.now(),
      };
      await this.store.updateClan(clan);
      await this.record("deletion.permanent", actorUserId, { guildId, clanId, after: clan });
      return clan;
    } catch (error) {
      throw new ClanDomainError(
        "partial-cleanup",
        `Clan deletion is incomplete: ${errorMessage(error)}`,
        true,
      );
    }
  }

  async touchActivity(clan: Clan, type: ClanActivityType): Promise<void> {
    await this.store.updateClan({
      ...clan,
      latestActivityAtMs: this.now(),
      latestActivityType: type,
      inactivityWarnedAtMs: null,
      updatedAtMs: this.now(),
    });
  }
  async purgeExpiredHistory(limit = 100): Promise<number> {
    const nowMs = this.now();
    return (
      (await this.store.purgeExpiredHistory(nowMs, limit)) +
      (await this.store.purgeExpiredWorkflowRecords(nowMs, limit))
    );
  }

  async setupManagedResources(guildId: string, actorUserId: string): Promise<ClanManagementConfig> {
    const config = await this.getConfig(guildId);
    if (config.categoryId) return config;
    const category = await this.discord.createCategory({ guildId, name: "HAF Clans" });
    const next = { ...config, categoryId: category.id, updatedAtMs: this.now() };
    await this.store.upsertConfig(next);
    await this.record("provisioning.category-created", actorUserId, {
      guildId,
      after: { categoryId: category.id },
    });
    return next;
  }

  async handleGuildMemberDeparture(guildId: string, userId: string): Promise<void> {
    const membership = await this.store.readActiveMembership(guildId, userId);
    if (!membership) return;
    const clan = await this.requireClan(guildId, membership.clanId);
    const before = { ...membership };
    membership.leftAtMs = this.now();
    await this.store.updateMembership(membership);
    const next: Clan = {
      ...clan,
      lifecycleState: membership.rank === "owner" ? "degraded" : clan.lifecycleState,
      sensitiveManagementFrozen:
        membership.rank === "owner" ? true : clan.sensitiveManagementFrozen,
      degradedReason:
        membership.rank === "owner"
          ? "Clan Owner left the Guild; reviewer recovery is required."
          : clan.degradedReason,
      latestActivityAtMs: this.now(),
      latestActivityType: "membership",
      updatedAtMs: this.now(),
    };
    await this.store.updateClan(next);
    await this.record("membership.guild-departure", userId, {
      guildId,
      clanId: clan.id,
      before,
      after: membership,
    });
  }

  async handleManagedResourceDeleted(guildId: string, resourceId: string): Promise<void> {
    const clan = await this.store.readClanByResource(guildId, resourceId);
    if (!clan) return;
    const next = {
      ...clan,
      lifecycleState:
        clan.lifecycleState === "active" ? ("degraded" as const) : clan.lifecycleState,
      degradedReason: `Managed Discord resource ${resourceId} was deleted.`,
      updatedAtMs: this.now(),
    };
    await this.store.updateClan(next);
    await this.record("resource.deleted", "system:gateway", {
      guildId,
      clanId: clan.id,
      before: clan,
      after: next,
    });
  }

  async processScheduledLifecycle(
    input: {
      limit?: number;
      isGuildSuspended?: (guildId: string) => Promise<boolean>;
    } = {},
  ): Promise<{ expired: number; deleted: number; transitioned: number; reconciled: number }> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const nowMs = this.now();
    let expired = 0;
    for (const application of await this.store.listDueApplications(nowMs, limit)) {
      if (!(await this.store.expireApplication(application.guildId, application.id, nowMs)))
        continue;
      application.status = "expired";
      application.updatedAtMs = nowMs;
      await this.record("application.expired", "system:scheduler", {
        guildId: application.guildId,
        clanId: application.clanId,
        after: application,
      });
      expired += 1;
    }
    for (const invitation of await this.store.listDueInvitations(nowMs, limit)) {
      if (!(await this.store.expireInvitation(invitation.guildId, invitation.id, nowMs))) continue;
      invitation.status = "expired";
      invitation.updatedAtMs = nowMs;
      await this.record("invitation.expired", "system:scheduler", {
        guildId: invitation.guildId,
        clanId: invitation.clanId,
        after: invitation,
      });
      expired += 1;
    }
    let reconciled = 0;
    for (const request of await this.store.listRequestReviewRecoveries(nowMs, limit)) {
      if (await input.isGuildSuspended?.(request.guildId)) continue;
      const requestConfig = await this.getConfig(request.guildId);
      if (!requestConfig.requestReviewCategoryId || requestConfig.reviewerRoleIds.length === 0)
        continue;
      try {
        await this.resumeRequestReviewTicket(request.guildId, request.id);
        reconciled += 1;
      } catch (error) {
        await this.record("request.review-ticket-recovery-failed", "system:scheduler", {
          guildId: request.guildId,
          requestId: request.id,
          reason: errorMessage(error),
          before: request,
        });
      }
    }
    let deleted = 0;
    for (const clan of await this.store.listDueDeletionClans(nowMs, limit)) {
      if (await input.isGuildSuspended?.(clan.guildId)) continue;
      try {
        await this.permanentlyDelete(clan.guildId, clan.id, "system:scheduler");
        deleted += 1;
      } catch (error) {
        await this.record("deletion.cleanup-failed", "system:scheduler", {
          guildId: clan.guildId,
          clanId: clan.id,
          reason: errorMessage(error),
          before: clan,
        });
      }
    }
    const scheduled = await this.store.listScheduledClans(limit);
    let transitioned = 0;
    const byGuild = groupClansByGuild(scheduled);
    for (const [guildId, guildClans] of byGuild) {
      if (await input.isGuildSuspended?.(guildId)) continue;
      const config = await this.getConfig(guildId);
      const limits = await this.effectiveLimits(guildId, config);
      const completeGuildClans = await this.store.listClans(guildId);
      const candidates = completeGuildClans
        .filter((clan) => ["active", "degraded", "plan-dormant"].includes(clan.lifecycleState))
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
      candidates.forEach((clan, index) => {
        const shouldDormant = limits.clans !== null && index >= limits.clans;
        if (shouldDormant && clan.lifecycleState !== "plan-dormant") {
          clan.lifecycleState = "plan-dormant";
          transitioned += 1;
        } else if (!shouldDormant && clan.lifecycleState === "plan-dormant") {
          clan.lifecycleState = "active";
          transitioned += 1;
        }
      });
      for (const clan of candidates) {
        if (clan.lifecycleState === "plan-dormant" || clan.lifecycleState === "active") {
          const persisted = await this.store.readClan(guildId, clan.id);
          if (
            persisted &&
            (persisted.lifecycleState !== clan.lifecycleState ||
              persisted.operation === "plan-permissions")
          ) {
            const pending = {
              ...clan,
              operation: "plan-permissions",
              updatedAtMs: nowMs,
            };
            await this.store.updateClan(pending);
            try {
              await this.discord.setClanArchivedPermissions({
                guildId,
                clan: pending,
                archived: pending.lifecycleState === "plan-dormant",
                botUserId: this.botUserId,
                staffRoleIds: config.staffAccessRoleIds,
              });
              const completed = { ...pending, operation: null, updatedAtMs: this.now() };
              await this.store.updateClan(completed);
              await this.record(`dormancy.${completed.lifecycleState}`, "system:scheduler", {
                guildId,
                clanId: completed.id,
                before: persisted,
                after: completed,
              });
            } catch (error) {
              await this.record("dormancy.permissions-failed", "system:scheduler", {
                guildId,
                clanId: pending.id,
                reason: errorMessage(error),
                before: persisted,
                after: pending,
              });
            }
          }
        }
      }
      for (const clan of guildClans) {
        if (
          clan.lifecycleState === "deletion-recovery" &&
          clan.operation === "deletion-recovery-permissions"
        ) {
          try {
            await this.beginDeletionRecovery(
              guildId,
              clan.id,
              "system:scheduler",
              "Resume incomplete deletion recovery permissions.",
            );
            transitioned += 1;
          } catch (error) {
            await this.record("deletion.permissions-failed", "system:scheduler", {
              guildId,
              clanId: clan.id,
              reason: errorMessage(error),
              before: clan,
            });
          }
          continue;
        }
        if (clan.lifecycleState === "archived" && clan.operation === "archive") {
          try {
            await this.archiveClan(
              guildId,
              clan.id,
              "system:scheduler",
              "Resume incomplete archival.",
            );
            transitioned += 1;
          } catch (error) {
            await this.record("lifecycle.archive-failed", "system:scheduler", {
              guildId,
              clanId: clan.id,
              reason: errorMessage(error),
              before: clan,
            });
          }
          continue;
        }
        if (
          config.inactivityEnabled &&
          clan.lifecycleState === "active" &&
          clan.latestActivityAtMs !== null
        ) {
          const inactiveDays = (nowMs - clan.latestActivityAtMs) / DAY_MS;
          if (inactiveDays >= config.inactivityArchiveDays) {
            try {
              await this.archiveClan(
                guildId,
                clan.id,
                "system:scheduler",
                "Inactivity threshold reached.",
              );
              transitioned += 1;
            } catch (error) {
              await this.record("lifecycle.archive-failed", "system:scheduler", {
                guildId,
                clanId: clan.id,
                reason: errorMessage(error),
                before: clan,
              });
            }
            continue;
          }
          if (inactiveDays >= config.inactivityWarningDays && clan.inactivityWarnedAtMs === null) {
            const warned = { ...clan, inactivityWarnedAtMs: nowMs, updatedAtMs: nowMs };
            await this.store.updateClan(warned);
            await this.record("inactivity.warned", "system:scheduler", {
              guildId,
              clanId: clan.id,
              before: clan,
              after: warned,
            });
            transitioned += 1;
          }
        }
        if (this.discord.inspectClanResources) {
          try {
            const missing = await this.discord.inspectClanResources({
              guildId,
              clan,
              categoryId: config.categoryId,
            });
            if (missing.length === 0) {
              await this.store.updateClan({ ...clan, updatedAtMs: nowMs });
              continue;
            }
            const degraded = {
              ...clan,
              lifecycleState:
                clan.lifecycleState === "active" ? ("degraded" as const) : clan.lifecycleState,
              degradedReason: `Missing managed resources: ${missing.join(", ")}.`,
              updatedAtMs: nowMs,
            };
            await this.store.updateClan(degraded);
            await this.record("reconciliation.degraded", "system:scheduler", {
              guildId,
              clanId: clan.id,
              before: clan,
              after: degraded,
            });
            reconciled += 1;
          } catch (error) {
            const degraded = {
              ...clan,
              lifecycleState:
                clan.lifecycleState === "active" ? ("degraded" as const) : clan.lifecycleState,
              degradedReason: `Reconciliation failed: ${errorMessage(error)}`,
              updatedAtMs: nowMs,
            };
            await this.store.updateClan(degraded);
            await this.record("reconciliation.failed", "system:scheduler", {
              guildId,
              clanId: clan.id,
              reason: errorMessage(error),
              before: clan,
              after: degraded,
            });
            reconciled += 1;
          }
        }
      }
    }
    return { expired, deleted, transitioned, reconciled };
  }

  private async joinClan(
    clan: Clan,
    userId: string,
    rank: Exclude<ClanRank, "owner">,
    source:
      | { kind: "invitation"; value: ClanInvitation }
      | { kind: "application"; value: ClanApplication; decidedByUserId: string },
    event: string,
    actorUserId = userId,
  ): Promise<ClanMembership> {
    const existing = await this.store.readActiveMembership(clan.guildId, userId);
    if (existing && existing.clanId !== clan.id)
      throw new ClanDomainError(
        "existing-membership",
        "A member can belong to only one Clan in this Guild.",
      );
    if (await this.store.readActiveMembershipBlock(clan.id, userId, this.now()))
      throw new ClanDomainError("blocked", "This member is temporarily blocked from the Clan.");
    const config = await this.getConfig(clan.guildId);
    const limits = await this.effectiveLimits(clan.guildId, config);
    const members = await this.store.listActiveMemberships(clan.id);
    if (limits.members !== null && members.length >= limits.members)
      throw new ClanDomainError("limit", "This Clan has reached its member limit.");
    if (
      rank === "officer" &&
      limits.officers !== null &&
      members.filter((item) => item.rank === "officer").length >= limits.officers
    )
      throw new ClanDomainError("limit", "This Clan has reached its officer limit.");
    if (!clan.roleId)
      throw new ClanDomainError("degraded-resource", "The Clan Role is unavailable.");
    const nowMs = this.now();
    const claimed =
      source.kind === "invitation"
        ? source.value.status === "accepting" ||
          (await this.store.claimInvitation(clan.guildId, source.value.id, nowMs))
        : source.value.status === "accepting" ||
          (await this.store.claimApplication(clan.guildId, source.value.id, nowMs));
    if (!claimed)
      throw new ClanDomainError("invalid-transition", "This join action is no longer pending.");
    await this.discord.addMemberRole(clan.guildId, userId, clan.roleId);
    const membership: ClanMembership = {
      clanId: clan.id,
      guildId: clan.guildId,
      userId,
      rank,
      joinedAtMs: this.now(),
      leftAtMs: null,
    };
    if (!existing) {
      try {
        await this.store.createMembership(membership);
      } catch (error) {
        const winner = await this.store.readActiveMembership(clan.guildId, userId);
        if (!winner || winner.clanId !== clan.id) {
          if (source.kind === "invitation") {
            source.value.status = "cancelled";
            source.value.updatedAtMs = this.now();
            await this.store.updateInvitation(source.value).catch(() => undefined);
          } else {
            source.value.status = "cancelled";
            source.value.updatedAtMs = this.now();
            await this.store.updateApplication(source.value).catch(() => undefined);
          }
          await this.discord
            .removeMemberRole(clan.guildId, userId, clan.roleId)
            .catch(() => undefined);
          throw mapConstraintError(error, "The member already belongs to a Clan.");
        }
      }
    }
    try {
      if (source.kind === "invitation") {
        source.value.status = "accepted";
        source.value.updatedAtMs = this.now();
        await this.store.updateInvitation(source.value);
      } else {
        source.value.status = "accepted";
        source.value.decidedByUserId = source.decidedByUserId;
        source.value.updatedAtMs = this.now();
        await this.store.updateApplication(source.value);
      }
    } catch (error) {
      throw new ClanJoinRecoveryError(`Clan join needs completion: ${errorMessage(error)}`, {
        kind: "membership-join",
        source: source.kind,
        guildId: clan.guildId,
        clanId: clan.id,
        sourceId: source.value.id,
        userId,
        rank,
      });
    }
    await this.touchActivity(clan, "membership");
    await this.syncBoard(clan);
    await this.record(event, actorUserId, {
      guildId: clan.guildId,
      clanId: clan.id,
      after: membership,
    });
    return existing ?? membership;
  }

  private async assertLeader(clan: Clan, userId: string): Promise<ClanMembership> {
    const membership = await this.store.readActiveMembership(clan.guildId, userId);
    if (
      !membership ||
      membership.clanId !== clan.id ||
      !["owner", "officer"].includes(membership.rank)
    )
      throw new ClanDomainError("authority", "Clan Owner or Officer authority is required.");
    return membership;
  }
  private async assertClanCapacity(guildId: string, config: ClanManagementConfig): Promise<void> {
    const limits = await this.effectiveLimits(guildId, config);
    if (
      limits.clans !== null &&
      (await this.store.countCapacityConsumingClans(guildId)) >= limits.clans
    )
      throw new ClanDomainError("limit", "This Guild has reached its active Clan limit.");
  }
  private async effectiveLimits(guildId: string, config: ClanManagementConfig) {
    const plan = getGuildEntitlementLimits(await this.entitlements.getTier(guildId));
    return {
      clans: lowerLimit(plan.clansMax ?? null, config.localClansMax),
      members: lowerLimit(plan.clanMembersMax ?? null, config.localMembersMax),
      officers: lowerLimit(plan.clanOfficersMax ?? null, config.localOfficersMax),
    };
  }
  private assertEligible(
    config: ClanManagementConfig,
    eligibility: ClanRequestEligibility,
    nowMs: number,
  ) {
    if (eligibility.isBot) throw new ClanDomainError("eligibility", "Bots cannot request Clans.");
    if (nowMs - eligibility.accountCreatedAtMs < config.minimumAccountAgeDays * DAY_MS)
      throw new ClanDomainError("eligibility", "The Discord account is too new.");
    if (nowMs - eligibility.guildJoinedAtMs < config.minimumGuildTenureDays * DAY_MS)
      throw new ClanDomainError(
        "eligibility",
        "The member has not been in this Guild long enough.",
      );
    if (
      config.eligibilityAllowedRoleIds.length > 0 &&
      !config.eligibilityAllowedRoleIds.some((id) => eligibility.roleIds.includes(id))
    )
      throw new ClanDomainError("eligibility", "The member does not hold an allowed role.");
    if (!config.eligibilityRequiredRoleIds.every((id) => eligibility.roleIds.includes(id)))
      throw new ClanDomainError("eligibility", "The member does not hold every required role.");
  }
  private async requireRequest(guildId: string, id: string) {
    const request = await this.store.readRequest(guildId, id);
    if (!request) throw new ClanDomainError("not-found", "Clan Request not found.");
    return request;
  }
  private async requireClan(guildId: string, id: string) {
    const clan = await this.store.readClan(guildId, id);
    if (!clan) throw new ClanDomainError("not-found", "Clan not found.");
    return clan;
  }
  private async requireManageableClan(guildId: string, id: string) {
    const clan = await this.requireClan(guildId, id);
    if (clan.lifecycleState !== "active" || clan.sensitiveManagementFrozen)
      throw new ClanDomainError("invalid-transition", "This Clan is not currently manageable.");
    return clan;
  }
  private async persistClanResource(
    clan: Clan,
    update: Partial<Pick<Clan, "roleId" | "textChannelId" | "voiceChannelId">>,
  ): Promise<Clan> {
    const next = { ...clan, ...update, updatedAtMs: this.now() };
    await this.store.updateClan(next);
    return next;
  }
  private channelInput(clan: Clan, config: ClanManagementConfig, name: string): ClanChannelInput {
    if (!config.categoryId || !clan.roleId)
      throw new ClanDomainError("provider-failure", "Clan category and role are required.", true);
    return {
      guildId: clan.guildId,
      parentId: config.categoryId,
      name,
      clanRoleId: clan.roleId,
      botUserId: this.botUserId,
      staffRoleIds: config.staffAccessRoleIds,
    };
  }
  private async syncBoard(clan: Clan): Promise<void> {
    const config = await this.getConfig(clan.guildId);
    if (
      !config.boardEnabled ||
      !config.boardChannelId ||
      !this.discord.upsertBoardProjection ||
      clan.lifecycleState !== "active"
    )
      return;
    try {
      const projection = await this.discord.upsertBoardProjection({
        clan,
        memberships: await this.store.listActiveMemberships(clan.id),
        config,
      });
      await this.store.updateClan({
        ...clan,
        boardProjectionId: projection.id,
        boardProjectionChannelId: projection.channelId,
        updatedAtMs: this.now(),
      });
    } catch (error) {
      await this.store.updateClan({
        ...clan,
        degradedReason: `Board projection: ${errorMessage(error)}`,
        updatedAtMs: this.now(),
      });
    }
  }
  private async removeBoardProjection(clan: Clan): Promise<void> {
    if (
      clan.boardProjectionId &&
      clan.boardProjectionChannelId &&
      this.discord.deleteBoardProjection
    )
      await tolerateMissing(() =>
        this.discord.deleteBoardProjection!(
          clan.boardProjectionChannelId!,
          clan.boardProjectionId!,
        ),
      );
    await this.store.updateClan({
      ...clan,
      boardProjectionId: null,
      boardProjectionChannelId: null,
      updatedAtMs: this.now(),
    });
  }
  private async tryDm(userId: string, message: string) {
    await this.discord.sendDm?.(userId, message).catch(() => undefined);
  }
  private async record(
    event: string,
    actorUserId: string,
    input: {
      guildId: string;
      clanId?: string;
      requestId?: string;
      reason?: string | null;
      before?: unknown;
      after?: unknown;
    },
  ) {
    const history: ClanHistoryEvent = {
      id: this.createId(),
      guildId: input.guildId,
      clanId: input.clanId ?? null,
      requestId: input.requestId ?? null,
      event,
      actorUserId,
      reason: input.reason ?? null,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
      createdAtMs: this.now(),
      retentionExpiresAtMs: this.now() + HISTORY_RETENTION_MS,
    };
    await this.store.appendHistory(history);
    await this.audit?.(history);
  }
}

function requiredText(value: string | undefined, label: string, max: number): string {
  const next = value?.trim() ?? "";
  if (!next) throw new ClanDomainError("invalid-transition", `${label} is required.`);
  if (next.length > max)
    throw new ClanDomainError("invalid-transition", `${label} must be at most ${max} characters.`);
  return next;
}
function optionalText(value: string | undefined, max: number): string | null {
  const next = value?.trim();
  if (!next) return null;
  if (next.length > max)
    throw new ClanDomainError("invalid-transition", `Value must be at most ${max} characters.`);
  return next;
}
function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}
function lowerLimit(plan: number | null, local: number | null): number | null {
  if (plan === null) return local;
  if (local === null) return plan;
  return Math.min(plan, local);
}
function assertLocalLimit(name: string, local: number | null, plan: number | null) {
  if (local !== null && (local < 0 || (plan !== null && local > plan)))
    throw new ClanDomainError("limit", `The local ${name} limit cannot exceed the plan limit.`);
}
function assertReviewer(config: ClanManagementConfig, roles: string[], isAdmin: boolean) {
  if (!isAdmin && !config.reviewerRoleIds.some((id) => roles.includes(id)))
    throw new ClanDomainError("authority", "Clan Reviewer authority is required.");
}
function renderTemplate(template: string, clan: Clan): string {
  return template.replaceAll("{name}", clan.name).replaceAll("{tag}", clan.tag).slice(0, 100);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function mapConstraintError(error: unknown, message: string): ClanDomainError {
  const text = errorMessage(error).toLowerCase();
  return new ClanDomainError(
    text.includes("unique") || text.includes("constraint")
      ? "duplicate-identity"
      : "provider-failure",
    text.includes("unique") || text.includes("constraint") ? message : errorMessage(error),
  );
}
async function tolerateMissing(operation: () => Promise<void>) {
  try {
    await operation();
  } catch (error) {
    const text = errorMessage(error);
    if (!/404|unknown (channel|role|member)|not found/i.test(text)) throw error;
  }
}

function groupClansByGuild(clans: Clan[]): Map<string, Clan[]> {
  const grouped = new Map<string, Clan[]>();
  for (const clan of clans) {
    const entries = grouped.get(clan.guildId) ?? [];
    entries.push(clan);
    grouped.set(clan.guildId, entries);
  }
  return grouped;
}
