import {
  eventLifecycleTarget,
  dueEventLifecycleAction,
  eventCanBeEdited,
} from "./event-lifecycle-workflow";
import { buildEventMessage } from "../events";
import { EventRecurrenceService } from "./event-recurrence-service";
import { DiscordApiError } from "../discord/client";
import { GuildResourceValidationError } from "../discord/guild-resource-validator";
import { isRecord } from "../unknown-parse";
import type { EventRecurrenceFrequency } from "../event-recurrence";
import type {
  CreateChannelMessageInput,
  DiscordAllowedMentions,
  DiscordMessageResource,
} from "../discord/messages";
import { allowUserMentions, buildAuditEmbed, suppressMentions } from "../discord/messages";
import type {
  AuditEventId,
  EventLifecycleHistoryRecord,
  EventRecord,
  EventReminder,
  EventSignup,
  EventSignupGroup,
  EventTeam,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamMembership,
  EventTeamProposal,
  EventTeamRosterSnapshot,
  EventTemplate,
} from "../types";
import { AUDIT_EVENT_LABELS, getGuildEntitlementLimits } from "../types";
import type { EventStore, GuildAuditLogStore, GuildEntitlementStore } from "../runtime/contracts";
import type {
  EventTeamMutation,
  EventTeamRateLimitAction,
  EventTeamRateLimitScope,
} from "../runtime/contracts/event-store";
import { resolveAuditChannelId } from "./guild-audit-log-service";
import type {
  GuildResourceScope,
  GuildResourceValidator,
} from "../discord/guild-resource-validator";

export interface EventsDiscordApi {
  createChannelMessage(
    channelId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  editChannelMessage(
    channelId: string,
    messageId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  createThread(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<{ id: string }>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  removeThreadMember(threadId: string, userId: string): Promise<void>;
  addGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<void>;
}

export interface CreateEventInput {
  guildId: string;
  templateId: string | null;
  title: string;
  description: string;
  channelId: string;
  startsAtMs: number;
  endsAtMs: number | null;
  signupCutoffAtMs: number | null;
  signupMode: EventRecord["signupMode"];
  participationMode?: EventRecord["participationMode"];
  requiredTeamSize?: number | null;
  threadEnabled: boolean;
  waitlistedMembersJoinThread: boolean;
  groups: EventSignupGroup[];
  reminders: EventReminder[];
}

export class EventConfigError extends Error {}

export class EventTeamRateLimitError extends EventConfigError {
  readonly code = "event_team_rate_limited" as const;

  constructor(
    readonly action: EventTeamRateLimitAction,
    readonly retryAfterMs: number,
    scope: EventTeamRateLimitScope,
  ) {
    super(
      `Event Team ${action.replaceAll("_", " ")} rate limit reached (${scope} scope). Try again later.`,
    );
    this.name = "EventTeamRateLimitError";
  }
}

export interface EventTeamRateLimitPolicy {
  maxAttempts: number;
  windowMs: number;
}

/** Deliberately modest defaults; callers may override these without changing the workflow. */
export const EVENT_TEAM_RATE_LIMIT_DEFAULTS: Record<
  EventTeamRateLimitAction,
  EventTeamRateLimitPolicy
> = {
  team_create: { maxAttempts: 3, windowMs: 60 * 60 * 1000 },
  team_rename: { maxAttempts: 5, windowMs: 60 * 60 * 1000 },
  team_invite: { maxAttempts: 10, windowMs: 10 * 60 * 1000 },
  team_request: { maxAttempts: 5, windowMs: 10 * 60 * 1000 },
  membership_change: { maxAttempts: 20, windowMs: 10 * 60 * 1000 },
};

export interface EventsServiceOptions {
  eventTeamRateLimits?: Partial<Record<EventTeamRateLimitAction, EventTeamRateLimitPolicy>>;
}

export interface EventTeamReadiness {
  teamId: string;
  rosterCount: number;
  confirmedCount: number;
  openPlaces: number;
  ready: boolean;
  reasons: Array<"roster_incomplete" | "member_waitlisted">;
}

export class EventsService {
  private readonly eventTeamRateLimits: Record<EventTeamRateLimitAction, EventTeamRateLimitPolicy>;
  private readonly localEventTeamRateLimits = new Map<
    string,
    { windowStartedAtMs: number; attemptCount: number }
  >();

  constructor(
    private readonly store: EventStore,
    private readonly discord: EventsDiscordApi,
    private readonly auditLogStore?: GuildAuditLogStore,
    private readonly guildEntitlements?: GuildEntitlementStore,
    options: EventsServiceOptions = {},
    private readonly guildResources?: GuildResourceValidator,
  ) {
    this.eventTeamRateLimits = { ...EVENT_TEAM_RATE_LIMIT_DEFAULTS };
    for (const [action, policy] of Object.entries(options.eventTeamRateLimits ?? {})) {
      if (policy) this.eventTeamRateLimits[action as EventTeamRateLimitAction] = policy;
    }
  }

  async createTemplate(
    input: Omit<EventTemplate, "createdAtMs" | "updatedAtMs">,
  ): Promise<EventTemplate> {
    const now = Date.now();
    const template: EventTemplate = {
      ...input,
      groups: normalizeGroups(input.groups),
      reminders: normalizeReminders(input.reminders),
      createdAtMs: now,
      updatedAtMs: now,
    };
    if (
      template.participationMode === "team" &&
      (!Number.isInteger(template.requiredTeamSize) ||
        template.requiredTeamSize === null ||
        template.requiredTeamSize < 2 ||
        template.requiredTeamSize > 50)
    ) {
      throw new EventConfigError("Event Team size must be between 2 and 50.");
    }
    if (template.participationMode === "team" && template.signupMode !== "single_choice") {
      throw new EventConfigError("Team Events require single-choice Signup Groups.");
    }
    this.requireGroupResources(template.groups, await this.readGuildResources(template.guildId));
    await this.store.createTemplate(template);
    return template;
  }

  async createEvent(input: CreateEventInput, occurrenceId?: string): Promise<EventRecord> {
    const now = Date.now();
    const event: EventRecord = {
      guildId: input.guildId,
      id: occurrenceId ?? createEventId(now),
      templateId: input.templateId,
      title: input.title.trim(),
      description: input.description.trim(),
      status: "draft",
      channelId: input.channelId,
      messageId: null,
      threadId: null,
      startsAtMs: input.startsAtMs,
      endsAtMs: input.endsAtMs,
      signupCutoffAtMs: input.signupCutoffAtMs ?? input.startsAtMs,
      signupMode: input.signupMode,
      participationMode: input.participationMode ?? "individual",
      requiredTeamSize: input.requiredTeamSize ?? null,
      threadEnabled: input.threadEnabled,
      waitlistedMembersJoinThread: input.waitlistedMembersJoinThread,
      groups: normalizeGroups(input.groups),
      reminders: normalizeReminders(input.reminders),
      createdAtMs: now,
      updatedAtMs: now,
      publishedAtMs: null,
      cancelledAtMs: null,
      endedAtMs: null,
      archivedAtMs: null,
    };
    validateEvent(event);
    const resources = await this.readGuildResources(event.guildId);
    resources?.requireTextChannel(event.channelId);
    this.requireGroupResources(event.groups, resources);
    await this.store.createEvent(event);
    await this.postAudit("event.create", event);
    return event;
  }

  async publishEvent(input: {
    guildId: string;
    eventId: string;
    actorUserId: string;
  }): Promise<EventRecord> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (eventLifecycleTarget(event.status, "publish") === null) {
      throw new EventConfigError("Only draft or scheduled Events can be published.");
    }
    const resources = await this.readGuildResources(event.guildId);
    resources?.requireTextChannel(event.channelId);
    this.requireGroupResources(event.groups, resources);
    if (event.threadId) await resources?.requireThread(event.threadId, event.channelId);

    const signups = await this.store.listSignups(event.guildId, event.id);
    const message = event.messageId
      ? await this.discord.editChannelMessage(
          event.channelId,
          event.messageId,
          buildEventMessage(event, signups),
        )
      : await this.discord.createChannelMessage(event.channelId, buildEventMessage(event, signups));

    let nextEvent: EventRecord = {
      ...event,
      status: "scheduled",
      messageId: message.id,
      publishedAtMs: event.publishedAtMs ?? Date.now(),
      updatedAtMs: Date.now(),
    };

    if (nextEvent.threadEnabled && !nextEvent.threadId) {
      const thread = await this.discord.createThread({
        channelId: nextEvent.channelId,
        messageId: message.id,
        name: nextEvent.title,
      });
      nextEvent = { ...nextEvent, threadId: thread.id, updatedAtMs: Date.now() };
    }

    await this.store.upsertEvent(nextEvent);
    await this.postAudit("event.publish", nextEvent);
    return nextEvent;
  }

  async updateEvent(input: CreateEventInput & { eventId: string }): Promise<EventRecord> {
    const existing = await this.requireEvent(input.guildId, input.eventId);
    if (!eventCanBeEdited(existing.status)) {
      throw new EventConfigError("This Event can no longer be edited.");
    }
    const participationMode = input.participationMode ?? existing.participationMode;
    const requiredTeamSize =
      input.requiredTeamSize === undefined ? existing.requiredTeamSize : input.requiredTeamSize;
    if (
      participationMode !== existing.participationMode ||
      requiredTeamSize !== existing.requiredTeamSize
    ) {
      const [signups, teams] = await Promise.all([
        this.store.listSignups(input.guildId, input.eventId),
        this.store.listEventTeams(input.guildId, input.eventId),
      ]);
      if (signups.length > 0 || teams.length > 0) {
        throw new EventConfigError(
          "Participation mode and Event Team size cannot change after roster activity.",
        );
      }
    }
    const nextEvent: EventRecord = {
      ...existing,
      templateId: input.templateId,
      title: input.title.trim(),
      description: input.description.trim(),
      channelId: input.channelId,
      startsAtMs: input.startsAtMs,
      endsAtMs: input.endsAtMs,
      signupCutoffAtMs: input.signupCutoffAtMs ?? input.startsAtMs,
      signupMode: input.signupMode,
      participationMode,
      requiredTeamSize,
      threadEnabled: input.threadEnabled,
      waitlistedMembersJoinThread: input.waitlistedMembersJoinThread,
      groups: normalizeGroups(input.groups),
      reminders: normalizeReminders(input.reminders),
      updatedAtMs: Date.now(),
    };
    validateEvent(nextEvent);
    const resources = await this.readGuildResources(nextEvent.guildId);
    resources?.requireTextChannel(nextEvent.channelId);
    this.requireGroupResources(nextEvent.groups, resources);
    if (nextEvent.threadId) await resources?.requireThread(nextEvent.threadId, nextEvent.channelId);
    await this.store.upsertEvent(nextEvent);
    await this.refreshEventMessage(nextEvent);
    await this.postAudit("event.update", nextEvent);
    return nextEvent;
  }

  private async buildEventTeamRosterSnapshots(
    event: EventRecord,
    capturedAtMs: number,
  ): Promise<EventTeamRosterSnapshot[]> {
    if (event.participationMode !== "team" || event.requiredTeamSize === null) {
      return [];
    }
    const requiredTeamSize = event.requiredTeamSize;
    const [teams, memberships, signups] = await Promise.all([
      this.store.listEventTeams(event.guildId, event.id),
      this.store.listActiveEventTeamMemberships(event.guildId, event.id),
      this.store.listSignups(event.guildId, event.id),
    ]);
    const statusByUserGroup = new Map(
      signups.map((signup) => [`${signup.userId}:${signup.groupId}`, signup.status] as const),
    );
    return teams
      .filter((candidate) => candidate.status === "active")
      .map((team): EventTeamRosterSnapshot => ({
        guildId: event.guildId,
        eventId: event.id,
        teamId: team.id,
        requiredTeamSize,
        members: memberships
          .filter((membership) => membership.teamId === team.id)
          .map((membership) => ({
            membershipId: membership.id,
            userId: membership.userId,
            groupId: membership.groupId,
            signupStatus:
              statusByUserGroup.get(`${membership.userId}:${membership.groupId}`) ?? null,
          })),
        capturedAtMs,
      }));
  }

  private buildEventTeamMutationArtifacts(input: {
    event: EventRecord;
    actorUserId: string;
    action: string;
    targetType: EventTeamAuditRecord["targetType"];
    targetId: string;
    prior: unknown;
    result: unknown;
    notifications?: Array<{ dedupeKey: string; payload: unknown }>;
  }): { audit: EventTeamAuditRecord; deliveries: EventTeamDeliveryOutboxRecord[] } {
    const now = Date.now();
    const audit: EventTeamAuditRecord = {
      guildId: input.event.guildId,
      eventId: input.event.id,
      id: `event-team-audit-${now}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      prior: input.prior,
      result: input.result,
      occurredAtMs: now,
    };
    const deliveries = [
      this.buildEventTeamDelivery(
        input.event,
        "canonical_refresh",
        `canonical:${input.event.id}`,
        { action: input.action, targetType: input.targetType, targetId: input.targetId },
        now,
      ),
      ...(input.notifications ?? []).map((notification) =>
        this.buildEventTeamDelivery(
          input.event,
          "notification",
          notification.dedupeKey,
          notification.payload,
          now,
        ),
      ),
    ];
    return { audit, deliveries };
  }

  private buildEventTeamDelivery(
    event: EventRecord,
    kind: EventTeamDeliveryOutboxRecord["kind"],
    dedupeKey: string,
    payload: unknown,
    now = Date.now(),
  ): EventTeamDeliveryOutboxRecord {
    return {
      guildId: event.guildId,
      eventId: event.id,
      id: `event-team-delivery-${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      dedupeKey,
      payload,
      status: "pending",
      attemptCount: 0,
      maxAttempts: 5,
      lastError: null,
      terminalFailureReason: null,
      nextAttemptAtMs: now,
      createdAtMs: now,
      updatedAtMs: now,
      deliveredAtMs: null,
    };
  }

  private async commitEventTeamMutation(input: {
    mutation: EventTeamMutation;
    event: EventRecord;
    actorUserId: string;
    action: string;
    targetType: EventTeamAuditRecord["targetType"];
    targetId: string;
    prior: unknown;
    result: unknown;
    notifications?: Array<{ dedupeKey: string; payload: unknown }>;
    deleteSignup?: Pick<EventSignup, "guildId" | "eventId" | "userId" | "groupId">;
  }): Promise<void> {
    const artifacts = this.buildEventTeamMutationArtifacts(input);
    if (this.store.commitEventTeamMutation) {
      await this.store.commitEventTeamMutation({
        mutation: input.mutation,
        deleteSignup: input.deleteSignup,
        ...artifacts,
      });
      return;
    }
    switch (input.mutation.kind) {
      case "create_team":
        await this.store.createEventTeamWithCaptain(input.mutation);
        break;
      case "add_membership":
        await this.store.addEventTeamMembership(input.mutation.membership);
        break;
      case "leave_membership":
        await this.store.leaveEventTeamMembership(input.mutation);
        break;
      case "update_team":
        await this.updateEventTeam(input.mutation.team);
        break;
      case "create_proposal":
        if (!this.store.createEventTeamProposal)
          throw new EventConfigError("Event Team proposals are unavailable.");
        await this.store.createEventTeamProposal(input.mutation.proposal);
        break;
      case "update_proposal":
        await this.updateProposal(input.mutation.proposal);
        break;
    }
    if (input.deleteSignup) await this.store.deleteSignup(input.deleteSignup);
    if (this.store.appendEventTeamAudit) await this.store.appendEventTeamAudit(artifacts.audit);
    for (const delivery of artifacts.deliveries) {
      if (this.store.enqueueEventTeamDelivery) await this.store.enqueueEventTeamDelivery(delivery);
    }
  }

  private async commitEventTeamDisband(input: {
    event: EventRecord;
    team: EventTeam;
    memberships: EventTeamMembership[];
    actorUserId: string;
    action: string;
    targetType: EventTeamAuditRecord["targetType"];
    targetId: string;
    prior: unknown;
    result: unknown;
    notifications?: Array<{ dedupeKey: string; payload: unknown }>;
    deleteSignup?: Pick<EventSignup, "guildId" | "eventId" | "userId" | "groupId">;
  }): Promise<void> {
    const artifacts = this.buildEventTeamMutationArtifacts(input);
    const leftAtMs = input.team.disbandedAtMs ?? input.team.updatedAtMs;
    if (this.store.commitEventTeamDisband) {
      await this.store.commitEventTeamDisband({
        team: input.team,
        membershipIds: input.memberships.map((membership) => membership.id),
        leftAtMs,
        cancelPendingProposals: true,
        deleteSignup: input.deleteSignup,
        ...artifacts,
      });
      return;
    }
    for (const membership of input.memberships) {
      await this.store.leaveEventTeamMembership({
        team: input.team,
        membershipId: membership.id,
        leftAtMs,
      });
    }
    await this.updateEventTeam(input.team);
    if (this.store.cancelEventTeamProposals) {
      await this.store.cancelEventTeamProposals({
        guildId: input.team.guildId,
        eventId: input.team.eventId,
        teamId: input.team.id,
        status: "pending",
        nowMs: leftAtMs,
      });
    }
    if (input.deleteSignup) await this.store.deleteSignup(input.deleteSignup);
    if (this.store.appendEventTeamAudit) await this.store.appendEventTeamAudit(artifacts.audit);
    for (const delivery of artifacts.deliveries) {
      if (this.store.enqueueEventTeamDelivery) await this.store.enqueueEventTeamDelivery(delivery);
    }
  }

  async cancelEvent(input: {
    guildId: string;
    eventId: string;
    actorUserId: string;
  }): Promise<EventRecord> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (eventLifecycleTarget(event.status, "cancel") === null) {
      throw new EventConfigError("This Event can no longer be cancelled.");
    }
    await this.cleanupConfirmedSideEffects(event);
    return this.updateEventStatus(event, "cancelled", Date.now(), "event.cancel");
  }

  async archiveEvent(input: {
    guildId: string;
    eventId: string;
    actorUserId: string;
  }): Promise<EventRecord> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (eventLifecycleTarget(event.status, "archive") === null) {
      throw new EventConfigError("Only ended or cancelled Events can be archived.");
    }
    return this.updateEventStatus(event, "archived", Date.now(), "event.archive");
  }

  async signup(input: {
    guildId: string;
    eventId: string;
    userId: string;
    memberRoleIds: string[];
    groupId: string;
  }): Promise<EventSignup> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const group = requireGroup(event, input.groupId);
    ensureEligible(group, input.memberRoleIds);

    const existing = await this.store.listUserSignups(event.guildId, event.id, input.userId);
    if (event.signupMode === "single_choice") {
      if (
        event.participationMode === "team" &&
        existing.some((signup) => signup.groupId !== input.groupId)
      ) {
        const memberships = await this.store.listActiveEventTeamMemberships(
          event.guildId,
          event.id,
        );
        if (memberships.some((membership) => membership.userId === input.userId)) {
          throw new EventConfigError("Leave your Event Team before changing Signup Groups.");
        }
      }
      for (const signup of existing) {
        if (signup.groupId !== input.groupId) {
          await this.removeSignup(event, signup);
        }
      }
    } else {
      const existingForGroup = existing.find((signup) => signup.groupId === input.groupId);
      if (existingForGroup) {
        return existingForGroup;
      }
    }

    const signups = (await this.store.listSignups(event.guildId, event.id)).filter(
      (signup) => !(signup.userId === input.userId && signup.groupId === input.groupId),
    );
    const status = resolveSignupStatus(group, signups);
    const signup = createSignup(event, input.userId, input.groupId, status);
    await this.store.upsertSignup(signup);
    if (status === "confirmed") {
      await this.applyConfirmedSideEffects(event, group, input.userId);
    }
    await this.refreshEventMessage(event);
    await this.postAudit("event.signup", event, {
      userId: input.userId,
      groupId: group.id,
      status,
    });
    return signup;
  }

  async leaveEvent(input: { guildId: string; eventId: string; userId: string }): Promise<void> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const memberships = await this.store.listActiveEventTeamMemberships(event.guildId, event.id);
    if (memberships.some((membership) => membership.userId === input.userId)) {
      await this.leaveEventTeam(input);
    }
    const signups = await this.store.listUserSignups(event.guildId, event.id, input.userId);
    for (const signup of signups) {
      await this.removeSignup(event, signup);
      await this.promoteNextWaitlisted(event, signup.groupId);
    }
    await this.refreshEventMessage(event);
  }

  async organizerSignup(input: {
    guildId: string;
    eventId: string;
    userId: string;
    groupId: string;
    status?: EventSignup["status"];
  }): Promise<EventSignup> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (event.status === "ended" || event.status === "cancelled" || event.status === "archived") {
      throw new EventConfigError("This Event is closed.");
    }
    const group = requireGroup(event, input.groupId);
    const existing = await this.store.listUserSignups(event.guildId, event.id, input.userId);
    if (event.signupMode === "single_choice") {
      for (const signup of existing) {
        if (signup.groupId !== input.groupId) {
          await this.removeSignup(event, signup);
          await this.promoteNextWaitlisted(event, signup.groupId);
        }
      }
    }
    const existingForGroup = existing.find((signup) => signup.groupId === input.groupId);
    const signups = (await this.store.listSignups(event.guildId, event.id)).filter(
      (signup) => !(signup.userId === input.userId && signup.groupId === input.groupId),
    );
    const status = input.status ?? resolveSignupStatus(group, signups);
    const signup: EventSignup = {
      ...(existingForGroup ?? createSignup(event, input.userId, input.groupId, status)),
      status,
      updatedAtMs: Date.now(),
    };
    if (existingForGroup?.status === "confirmed" && status !== "confirmed") {
      await this.removeConfirmedSideEffects(event, existingForGroup);
    }
    await this.store.upsertSignup(signup);
    if (status === "confirmed") {
      await this.applyConfirmedSideEffects(event, group, input.userId);
    }
    await this.refreshEventMessage(event);
    await this.postAudit("event.signup", event, {
      userId: input.userId,
      groupId: input.groupId,
      status,
      source: "admin",
    });
    return signup;
  }

  async listUnassignedParticipants(input: {
    guildId: string;
    eventId: string;
    groupId: string;
  }): Promise<EventSignup[]> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (event.participationMode !== "team") {
      throw new EventConfigError("Unassigned participants are available only for team Events.");
    }
    requireGroup(event, input.groupId);
    const [signups, memberships] = await Promise.all([
      this.store.listSignups(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
    ]);
    const assignedUserIds = new Set(memberships.map((membership) => membership.userId));
    return signups.filter(
      (signup) => signup.groupId === input.groupId && !assignedUserIds.has(signup.userId),
    );
  }

  async createEventTeam(input: {
    guildId: string;
    eventId: string;
    userId: string;
    groupId: string;
    name: string;
    actorUserId?: string;
  }): Promise<EventTeam> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    if (event.participationMode !== "team") {
      throw new EventConfigError("Event Teams are available only for team Events.");
    }
    requireGroup(event, input.groupId);
    const signup = (
      await this.store.listUserSignups(input.guildId, input.eventId, input.userId)
    ).find((candidate) => candidate.groupId === input.groupId);
    if (!signup) {
      throw new EventConfigError("Join this Signup Group before creating an Event Team.");
    }
    const existingMemberships = await this.store.listActiveEventTeamMemberships(
      input.guildId,
      input.eventId,
    );
    if (existingMemberships.some((membership) => membership.userId === input.userId)) {
      throw new EventConfigError("You already belong to an Event Team.");
    }
    const { name, normalizedName } = normalizeEventTeamName(input.name);
    const existingTeams = await this.store.listEventTeams(input.guildId, input.eventId);
    if (existingTeams.some((team) => team.normalizedName === normalizedName)) {
      throw new EventConfigError("An Event Team with that name already exists.");
    }
    const actorUserId = input.actorUserId ?? input.userId;
    await this.enforceEventTeamRateLimit(event, actorUserId, "team_create");
    const now = Date.now();
    const team: EventTeam = {
      guildId: input.guildId,
      eventId: input.eventId,
      id: createEventTeamId(now),
      groupId: input.groupId,
      name,
      normalizedName,
      captainUserId: input.userId,
      openToRequests: false,
      status: "active",
      createdByUserId: actorUserId,
      createdAtMs: now,
      updatedAtMs: now,
      disbandedAtMs: null,
    };
    const membership: EventTeamMembership = {
      guildId: input.guildId,
      eventId: input.eventId,
      id: createEventTeamMembershipId(now),
      teamId: team.id,
      groupId: input.groupId,
      userId: input.userId,
      joinedAtMs: now,
      leftAtMs: null,
    };
    await this.commitEventTeamMutation({
      mutation: { kind: "create_team", team, membership },
      event,
      actorUserId,
      action: "team.created",
      targetType: "team",
      targetId: team.id,
      prior: null,
      result: team,
    });
    return team;
  }

  async getEventTeamReadiness(input: {
    guildId: string;
    eventId: string;
    teamId: string;
  }): Promise<EventTeamReadiness> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (event.participationMode !== "team" || event.requiredTeamSize === null) {
      throw new EventConfigError("Event Team readiness is available only for team Events.");
    }
    const [teams, memberships, signups] = await Promise.all([
      this.store.listEventTeams(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
      this.store.listSignups(input.guildId, input.eventId),
    ]);
    const team = teams.find((candidate) => candidate.id === input.teamId);
    if (!team) throw new EventConfigError("Event Team not found.");
    const roster = memberships.filter((membership) => membership.teamId === team.id);
    const confirmedUserIds = new Set(
      signups
        .filter((signup) => signup.groupId === team.groupId && signup.status === "confirmed")
        .map((signup) => signup.userId),
    );
    const confirmedCount = roster.filter((membership) =>
      confirmedUserIds.has(membership.userId),
    ).length;
    const reasons: EventTeamReadiness["reasons"] = [];
    if (roster.length !== event.requiredTeamSize) reasons.push("roster_incomplete");
    if (confirmedCount !== roster.length) reasons.push("member_waitlisted");
    return {
      teamId: team.id,
      rosterCount: roster.length,
      confirmedCount,
      openPlaces: Math.max(0, event.requiredTeamSize - roster.length),
      ready: team.status === "active" && reasons.length === 0,
      reasons,
    };
  }

  /** Returns Team metadata for private management views; member identities are not included. */
  async listEventTeams(input: { guildId: string; eventId: string }): Promise<EventTeam[]> {
    await this.requireEvent(input.guildId, input.eventId);
    return this.store.listEventTeams(input.guildId, input.eventId);
  }

  async getEventTeamManagementView(input: { guildId: string; eventId: string; userId: string }) {
    const event = await this.requireEvent(input.guildId, input.eventId);
    const [teams, memberships, allSignups, proposals] = await Promise.all([
      this.store.listEventTeams(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
      this.store.listSignups(input.guildId, input.eventId),
      this.store.listEventTeamProposals
        ? this.store.listEventTeamProposals({ guildId: input.guildId, eventId: input.eventId })
        : Promise.resolve([]),
    ]);
    const publicTeams = await Promise.all(
      teams
        .filter((team) => team.status === "active")
        .map(async (team) => {
          const roster = memberships.filter((membership) => membership.teamId === team.id);
          const readiness =
            event.participationMode === "team" && event.requiredTeamSize !== null
              ? await this.getEventTeamReadiness({
                  guildId: input.guildId,
                  eventId: input.eventId,
                  teamId: team.id,
                })
              : null;
          return {
            id: team.id,
            name: team.name,
            groupId: team.groupId,
            captainUserId: team.captainUserId,
            status: team.status,
            openToRequests: team.openToRequests,
            rosterCount: roster.length,
            readiness,
            openPlaces: readiness?.openPlaces ?? null,
          };
        }),
    );
    const ownMembership =
      memberships.find((membership) => membership.userId === input.userId) ?? null;
    const captainGroups = new Set(
      teams
        .filter((team) => team.status === "active" && team.captainUserId === input.userId)
        .map((team) => team.groupId),
    );
    const assignedUserIds = new Set(memberships.map((membership) => membership.userId));
    return {
      eventId: event.id,
      userId: input.userId,
      signups: allSignups.filter((signup) => signup.userId === input.userId),
      membership: ownMembership,
      eligibleUnassignedParticipants: allSignups
        .filter(
          (signup) => captainGroups.has(signup.groupId) && !assignedUserIds.has(signup.userId),
        )
        .map((signup) => ({
          userId: signup.userId,
          groupId: signup.groupId,
          status: signup.status,
        })),
      actionableProposals: proposals.filter(
        (proposal) =>
          proposal.status === "pending" &&
          (proposal.targetUserId === input.userId || proposal.requesterUserId === input.userId),
      ),
      teams: publicTeams,
    };
  }

  async getEventTeamRoster(input: {
    guildId: string;
    eventId: string;
    teamId: string;
  }): Promise<string[]> {
    await this.requireEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    const memberships = await this.store.listActiveEventTeamMemberships(
      input.guildId,
      input.eventId,
    );
    return memberships
      .filter((membership) => membership.teamId === team.id)
      .map((membership) => membership.userId);
  }

  /** Canonical-message aggregate with counts only, never an unassigned user list. */
  async getEventTeamMessageAggregate(input: { guildId: string; eventId: string }): Promise<{
    teamCount: number;
    readyTeamCount: number;
    incompleteTeamCount: number;
    unassignedCount: number;
    assignedCount: number;
    capacity: number;
  }> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    const [teams, memberships, signups] = await Promise.all([
      this.store.listEventTeams(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
      this.store.listSignups(input.guildId, input.eventId),
    ]);
    if (event.participationMode !== "team" || event.requiredTeamSize === null) {
      return {
        teamCount: 0,
        readyTeamCount: 0,
        incompleteTeamCount: 0,
        unassignedCount: 0,
        assignedCount: 0,
        capacity: 0,
      };
    }
    const assignedIds = new Set(memberships.map((membership) => membership.userId));
    const eligibleSignups = signups.filter((signup) => signup.status === "confirmed");
    const readyTeamIds = new Set<string>();
    for (const team of teams) {
      const roster = memberships.filter((membership) => membership.teamId === team.id);
      const confirmedCount = roster.filter((membership) =>
        eligibleSignups.some(
          (signup) => signup.userId === membership.userId && signup.groupId === team.groupId,
        ),
      ).length;
      if (
        team.status === "active" &&
        roster.length === event.requiredTeamSize &&
        confirmedCount === roster.length
      ) {
        readyTeamIds.add(team.id);
      }
    }
    return {
      teamCount: teams.filter((team) => team.status === "active").length,
      readyTeamCount: readyTeamIds.size,
      incompleteTeamCount: teams.filter(
        (team) => team.status === "active" && !readyTeamIds.has(team.id),
      ).length,
      unassignedCount: eligibleSignups.filter((signup) => !assignedIds.has(signup.userId)).length,
      assignedCount: assignedIds.size,
      capacity: teams.filter((team) => team.status === "active").length * event.requiredTeamSize,
    };
  }

  async organizerAddEventTeamMember(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    userId: string;
    actorUserId?: string;
  }): Promise<EventTeamMembership> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (
      event.participationMode !== "team" ||
      event.requiredTeamSize === null ||
      event.status === "ended" ||
      event.status === "cancelled" ||
      event.status === "archived"
    ) {
      throw new EventConfigError("This Event Team roster can no longer be changed.");
    }
    const [teams, memberships, signups] = await Promise.all([
      this.store.listEventTeams(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
      this.store.listUserSignups(input.guildId, input.eventId, input.userId),
    ]);
    const team = teams.find(
      (candidate) => candidate.id === input.teamId && candidate.status === "active",
    );
    if (!team) throw new EventConfigError("Event Team not found.");
    if (!signups.some((signup) => signup.groupId === team.groupId)) {
      throw new EventConfigError("The participant must join the Event Team's Signup Group first.");
    }
    if (memberships.some((membership) => membership.userId === input.userId)) {
      throw new EventConfigError("The participant already belongs to an Event Team.");
    }
    if (
      memberships.filter((membership) => membership.teamId === input.teamId).length >=
      event.requiredTeamSize
    ) {
      throw new EventConfigError("This Event Team roster is full.");
    }
    const actorUserId = input.actorUserId ?? "admin";
    await this.enforceEventTeamRateLimit(event, actorUserId, "membership_change");
    const now = Date.now();
    const membership: EventTeamMembership = {
      guildId: input.guildId,
      eventId: input.eventId,
      id: createEventTeamMembershipId(now),
      teamId: team.id,
      groupId: team.groupId,
      userId: input.userId,
      joinedAtMs: now,
      leftAtMs: null,
    };
    await this.commitEventTeamMutation({
      mutation: { kind: "add_membership", membership },
      event,
      actorUserId,
      action: "member.assigned",
      targetType: "member",
      targetId: input.userId,
      prior: null,
      result: membership,
    });
    return membership;
  }

  async renameEventTeam(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    captainUserId: string;
    name: string;
  }): Promise<EventTeam> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    if (team.captainUserId !== input.captainUserId) {
      throw new EventConfigError("Only the Event Team captain can rename the team.");
    }
    const { name, normalizedName } = normalizeEventTeamName(input.name);
    if (
      (await this.store.listEventTeams(input.guildId, input.eventId)).some(
        (candidate) =>
          candidate.id !== team.id &&
          candidate.status === "active" &&
          candidate.normalizedName === normalizedName,
      )
    ) {
      throw new EventConfigError("An Event Team with that name already exists.");
    }
    await this.enforceEventTeamRateLimit(event, input.captainUserId, "team_rename");
    const updated = { ...team, name, normalizedName, updatedAtMs: Date.now() };
    await this.commitEventTeamMutation({
      mutation: { kind: "update_team", team: updated },
      event,
      actorUserId: input.captainUserId,
      action: "team.renamed",
      targetType: "team",
      targetId: team.id,
      prior: team,
      result: updated,
    });
    return updated;
  }

  async setEventTeamRequestsOpen(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    captainUserId: string;
    open: boolean;
  }): Promise<EventTeam> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    if (team.captainUserId !== input.captainUserId) {
      throw new EventConfigError("Only the Event Team captain can change recruitment.");
    }
    const updated = { ...team, openToRequests: input.open, updatedAtMs: Date.now() };
    await this.commitEventTeamMutation({
      mutation: { kind: "update_team", team: updated },
      event,
      actorUserId: input.captainUserId,
      action: input.open ? "team.requests_opened" : "team.requests_closed",
      targetType: "team",
      targetId: team.id,
      prior: team,
      result: updated,
    });
    return updated;
  }

  async createEventTeamJoinRequest(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    userId: string;
  }): Promise<EventTeamProposal> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    if (!team.openToRequests)
      throw new EventConfigError("This Event Team is not accepting requests.");
    if (await this.hasInvitationBlock(input.guildId, input.eventId, team.id, input.userId))
      throw new EventConfigError("You cannot request to join this Event Team.");
    await this.requireSignedUpForGroup(event, input.userId, team.groupId);
    const memberships = await this.store.listActiveEventTeamMemberships(
      input.guildId,
      input.eventId,
    );
    if (memberships.some((item) => item.userId === input.userId)) {
      throw new EventConfigError("You already belong to an Event Team.");
    }
    const proposals = await this.listProposals({
      guildId: input.guildId,
      eventId: input.eventId,
      status: "pending",
    });
    if (
      proposals.some(
        (item) => item.kind === "join_request" && item.requesterUserId === input.userId,
      )
    ) {
      throw new EventConfigError("You already have a pending Event Team request.");
    }
    await this.enforceEventTeamRateLimit(event, input.userId, "team_request");
    const proposal = this.buildProposal({
      event,
      team,
      kind: "join_request",
      requesterUserId: input.userId,
      targetUserId: team.captainUserId,
    });
    await this.persistProposal(proposal);
    return proposal;
  }

  async withdrawEventTeamJoinRequest(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
    userId: string;
  }): Promise<EventTeamProposal> {
    const proposal = await this.requireProposal(input);
    if (proposal.kind !== "join_request" || proposal.requesterUserId !== input.userId) {
      throw new EventConfigError("You cannot withdraw this Event Team request.");
    }
    return this.transitionProposal(proposal, "withdrawn");
  }

  async inviteEventTeamMember(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    captainUserId: string;
    userId: string;
    targetIsBot?: boolean;
  }): Promise<EventTeamProposal> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    if (input.targetIsBot) throw new EventConfigError("Bots cannot join Event Teams.");
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    if (team.captainUserId !== input.captainUserId)
      throw new EventConfigError("Only the Event Team captain can invite members.");
    const memberships = await this.store.listActiveEventTeamMemberships(
      input.guildId,
      input.eventId,
    );
    if (memberships.some((item) => item.userId === input.userId))
      throw new EventConfigError("This participant already belongs to an Event Team.");
    if (await this.hasInvitationBlock(input.guildId, input.eventId, team.id, input.userId))
      throw new EventConfigError("This participant declined an invitation from this Event Team.");
    const pending = await this.listProposals({
      guildId: input.guildId,
      eventId: input.eventId,
      teamId: team.id,
      status: "pending",
    });
    if (pending.some((item) => item.kind === "invitation" && item.targetUserId === input.userId))
      return pending.find(
        (item) => item.kind === "invitation" && item.targetUserId === input.userId,
      )!;
    const cap = Math.min((event.requiredTeamSize ?? 2) * 2, 50);
    if (pending.filter((item) => item.kind === "invitation").length >= cap)
      throw new EventConfigError("This Event Team has reached its outstanding invitation limit.");
    await this.enforceEventTeamRateLimit(event, input.captainUserId, "team_invite");
    const proposal = this.buildProposal({
      event,
      team,
      kind: "invitation",
      requesterUserId: input.captainUserId,
      targetUserId: input.userId,
    });
    await this.persistProposal(proposal);
    return proposal;
  }

  async acceptEventTeamProposal(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
    userId: string;
  }): Promise<EventTeamMembership> {
    await this.requirePaidPlan(input.guildId);
    const proposal = await this.requireProposal(input);
    if (proposal.status !== "pending" || proposal.targetUserId !== input.userId)
      throw new EventConfigError("This Event Team proposal is no longer available.");
    const memberUserId = proposal.kind === "join_request" ? proposal.requesterUserId : input.userId;
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, proposal.teamId);
    const [memberships, signups] = await Promise.all([
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
      this.store.listUserSignups(input.guildId, input.eventId, memberUserId),
    ]);
    if (memberships.some((item) => item.userId === memberUserId))
      throw new EventConfigError("You already belong to an Event Team.");
    if (
      (event.requiredTeamSize ?? 0) <= memberships.filter((item) => item.teamId === team.id).length
    )
      throw new EventConfigError("This Event Team roster is full.");
    await this.enforceEventTeamRateLimit(event, input.userId, "membership_change");
    const existingSignup = signups.find((item) => item.groupId === team.groupId);
    let signup = existingSignup;
    if (!signup) {
      const group = requireGroup(event, team.groupId);
      const allSignups = await this.store.listSignups(event.guildId, event.id);
      const status = resolveSignupStatus(group, allSignups);
      signup = createSignup(event, memberUserId, team.groupId, status);
    }
    const now = Date.now();
    const membership: EventTeamMembership = {
      guildId: event.guildId,
      eventId: event.id,
      id: createEventTeamMembershipId(now),
      teamId: team.id,
      groupId: team.groupId,
      userId: memberUserId,
      joinedAtMs: now,
      leftAtMs: null,
    };
    const accepted = {
      ...proposal,
      status: "accepted" as const,
      updatedAtMs: now,
      resolvedAtMs: now,
    };
    const competing = (
      await this.listProposals({ guildId: event.guildId, eventId: event.id, status: "pending" })
    )
      .filter(
        (item) =>
          item.id !== proposal.id &&
          (item.targetUserId === memberUserId || item.requesterUserId === memberUserId),
      )
      .map((item) => item.id);
    const artifacts = this.buildEventTeamMutationArtifacts({
      event,
      actorUserId: input.userId,
      action: "proposal.accepted",
      targetType: "proposal",
      targetId: proposal.id,
      prior: proposal,
      result: accepted,
      notifications: [
        {
          dedupeKey: `proposal.accepted:${proposal.id}`,
          payload: { proposalId: proposal.id, userId: memberUserId },
        },
      ],
    });
    if (this.store.acceptEventTeamProposalAtomic) {
      await this.store.acceptEventTeamProposalAtomic({
        proposal: accepted,
        membership,
        signup,
        cancelProposalIds: competing,
        ...artifacts,
      });
    } else {
      await this.updateProposal(accepted);
      if (signup && !existingSignup) await this.store.upsertSignup(signup);
      await this.store.addEventTeamMembership(membership);
      for (const id of competing) {
        const other = await this.requireProposal({ ...input, proposalId: id });
        await this.updateProposal({
          ...other,
          status: "cancelled",
          updatedAtMs: now,
          resolvedAtMs: now,
        });
      }
      if (this.store.appendEventTeamAudit) await this.store.appendEventTeamAudit(artifacts.audit);
      for (const delivery of artifacts.deliveries) {
        if (this.store.enqueueEventTeamDelivery)
          await this.store.enqueueEventTeamDelivery(delivery);
      }
    }
    if (signup?.status === "confirmed" && !existingSignup)
      await this.applyConfirmedSideEffects(event, requireGroup(event, team.groupId), memberUserId);
    return membership;
  }

  async acceptEventTeamJoinRequest(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
    captainUserId: string;
  }): Promise<EventTeamMembership> {
    return this.acceptEventTeamProposal({ ...input, userId: input.captainUserId });
  }

  async acceptEventTeamInvitation(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
    userId: string;
  }): Promise<EventTeamMembership> {
    return this.acceptEventTeamProposal(input);
  }

  async declineEventTeamInvitation(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
    userId: string;
  }): Promise<EventTeamProposal> {
    const proposal = await this.requireProposal(input);
    if (
      proposal.kind !== "invitation" ||
      proposal.targetUserId !== input.userId ||
      proposal.status !== "pending"
    )
      throw new EventConfigError("This invitation is no longer available.");
    const now = Date.now();
    const result = await this.transitionProposal(proposal, "declined");
    if (this.store.createEventTeamInvitationBlock)
      await this.store.createEventTeamInvitationBlock({
        guildId: proposal.guildId,
        eventId: proposal.eventId,
        teamId: proposal.teamId,
        userId: proposal.targetUserId,
        createdAtMs: now,
      });
    return result;
  }

  async captainOpenEventTeamRequests(
    input: Omit<Parameters<EventsService["setEventTeamRequestsOpen"]>[0], "open">,
  ): Promise<EventTeam> {
    return this.setEventTeamRequestsOpen({ ...input, open: true });
  }

  async captainCloseEventTeamRequests(
    input: Omit<Parameters<EventsService["setEventTeamRequestsOpen"]>[0], "open">,
  ): Promise<EventTeam> {
    return this.setEventTeamRequestsOpen({ ...input, open: false });
  }

  async rejectEventTeamJoinRequest(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
    captainUserId: string;
  }): Promise<EventTeamProposal> {
    const proposal = await this.requireProposal(input);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, proposal.teamId);
    if (
      proposal.kind !== "join_request" ||
      proposal.status !== "pending" ||
      team.captainUserId !== input.captainUserId
    )
      throw new EventConfigError("Only the Event Team captain can reject this request.");
    return this.transitionProposal(proposal, "rejected");
  }

  async captainRemoveEventTeamMember(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    captainUserId: string;
    userId: string;
  }): Promise<void> {
    await this.requirePaidPlan(input.guildId);
    await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    if (team.captainUserId !== input.captainUserId)
      throw new EventConfigError("Only the Event Team captain can remove members.");
    const membership = (
      await this.store.listActiveEventTeamMemberships(input.guildId, input.eventId)
    ).find((item) => item.teamId === team.id && item.userId === input.userId);
    if (!membership || membership.userId === team.captainUserId)
      throw new EventConfigError("That member cannot be removed.");
    await this.enforceEventTeamRateLimit(
      await this.requireEvent(input.guildId, input.eventId),
      input.captainUserId,
      "membership_change",
    );
    const leftAtMs = Date.now();
    await this.commitEventTeamMutation({
      mutation: { kind: "leave_membership", team, membershipId: membership.id, leftAtMs },
      event: await this.requireEvent(input.guildId, input.eventId),
      actorUserId: input.captainUserId,
      action: "member.removed",
      targetType: "member",
      targetId: input.userId,
      prior: membership,
      result: { leftAtMs },
    });
    if (this.store.createEventTeamInvitationBlock)
      await this.store.createEventTeamInvitationBlock({
        guildId: team.guildId,
        eventId: team.eventId,
        teamId: team.id,
        userId: input.userId,
        createdAtMs: Date.now(),
      });
  }

  async transferEventTeamCaptain(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    captainUserId: string;
    newCaptainUserId: string;
  }): Promise<EventTeam> {
    await this.requirePaidPlan(input.guildId);
    await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    const members = await this.store.listActiveEventTeamMemberships(input.guildId, input.eventId);
    if (
      team.captainUserId !== input.captainUserId ||
      !members.some((item) => item.teamId === team.id && item.userId === input.newCaptainUserId)
    )
      throw new EventConfigError(
        "Captain transfer requires the current captain and an active teammate.",
      );
    const updated = { ...team, captainUserId: input.newCaptainUserId, updatedAtMs: Date.now() };
    await this.commitEventTeamMutation({
      mutation: { kind: "update_team", team: updated },
      event: await this.requireEvent(input.guildId, input.eventId),
      actorUserId: input.captainUserId,
      action: "captain.transferred",
      targetType: "captain",
      targetId: team.id,
      prior: { captainUserId: team.captainUserId },
      result: { captainUserId: updated.captainUserId },
    });
    return updated;
  }

  async disbandEventTeam(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    captainUserId: string;
  }): Promise<EventTeam> {
    await this.requirePaidPlan(input.guildId);
    await this.requireMutableEvent(input.guildId, input.eventId);
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    if (team.captainUserId !== input.captainUserId)
      throw new EventConfigError("Only the Event Team captain can disband the team.");
    const now = Date.now();
    const updated = {
      ...team,
      status: "disbanded" as const,
      openToRequests: false,
      updatedAtMs: now,
      disbandedAtMs: now,
    };
    const members = (
      await this.store.listActiveEventTeamMemberships(input.guildId, input.eventId)
    ).filter((item) => item.teamId === team.id);
    await this.commitEventTeamDisband({
      event: await this.requireEvent(input.guildId, input.eventId),
      team: updated,
      memberships: members,
      actorUserId: input.captainUserId,
      action: "team.disbanded",
      targetType: "team",
      targetId: team.id,
      prior: team,
      result: updated,
    });
    return updated;
  }

  async organizerOverrideEventTeam(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    actorUserId: string;
    confirmed: boolean;
    action: "rename" | "disband" | "transfer_captain" | "remove_member";
    name?: string;
    userId?: string;
    newCaptainUserId?: string;
  }): Promise<{ team: EventTeam; membership?: EventTeamMembership }> {
    await this.requirePaidPlan(input.guildId);
    if (!input.confirmed) {
      throw new EventConfigError("Confirm this Event Team administrator override.");
    }
    const event = await this.requireEvent(input.guildId, input.eventId);
    if (
      event.participationMode !== "team" ||
      event.status === "ended" ||
      event.status === "cancelled" ||
      event.status === "archived"
    ) {
      throw new EventConfigError("This Event Team roster can no longer be changed.");
    }
    const team = await this.requireActiveTeam(input.guildId, input.eventId, input.teamId);
    const memberships = (
      await this.store.listActiveEventTeamMemberships(input.guildId, input.eventId)
    ).filter((membership) => membership.teamId === team.id);
    const now = Date.now();

    if (input.action === "rename") {
      if (!input.name) throw new EventConfigError("Enter a new Event Team name.");
      await this.enforceEventTeamRateLimit(event, input.actorUserId, "team_rename");
      const { name, normalizedName } = normalizeEventTeamName(input.name);
      const duplicate = (await this.store.listEventTeams(input.guildId, input.eventId)).some(
        (candidate) =>
          candidate.id !== team.id &&
          candidate.status === "active" &&
          candidate.normalizedName === normalizedName,
      );
      if (duplicate) throw new EventConfigError("An Event Team with that name already exists.");
      const updated = { ...team, name, normalizedName, updatedAtMs: now };
      await this.commitEventTeamMutation({
        mutation: { kind: "update_team", team: updated },
        event,
        actorUserId: input.actorUserId,
        action: "team.renamed",
        targetType: "team",
        targetId: team.id,
        prior: team,
        result: updated,
      });
      return { team: updated };
    }

    await this.enforceEventTeamRateLimit(event, input.actorUserId, "membership_change");
    if (input.action === "transfer_captain") {
      if (
        !input.newCaptainUserId ||
        !memberships.some((membership) => membership.userId === input.newCaptainUserId)
      ) {
        throw new EventConfigError("Choose an active Event Team member as captain.");
      }
      const updated = { ...team, captainUserId: input.newCaptainUserId, updatedAtMs: now };
      await this.commitEventTeamMutation({
        mutation: { kind: "update_team", team: updated },
        event,
        actorUserId: input.actorUserId,
        action: "captain.transferred_by_admin",
        targetType: "captain",
        targetId: team.id,
        prior: { captainUserId: team.captainUserId },
        result: { captainUserId: updated.captainUserId },
        notifications: [
          {
            dedupeKey: `captain.admin_transfer:${team.id}:${now}`,
            payload: { recipientUserId: updated.captainUserId, teamId: team.id },
          },
        ],
      });
      return { team: updated };
    }

    if (input.action === "remove_member") {
      if (!input.userId) throw new EventConfigError("Choose an Event Team member to remove.");
      const membership = memberships.find((candidate) => candidate.userId === input.userId);
      if (!membership) throw new EventConfigError("That participant is not on this Event Team.");
      const remaining = memberships
        .filter((candidate) => candidate.id !== membership.id)
        .sort(
          (left, right) =>
            left.joinedAtMs - right.joinedAtMs || left.userId.localeCompare(right.userId),
        );
      const updated: EventTeam = {
        ...team,
        captainUserId:
          team.captainUserId === input.userId && remaining[0]
            ? remaining[0].userId
            : team.captainUserId,
        status: remaining.length === 0 ? "disbanded" : "active",
        openToRequests: remaining.length === 0 ? false : team.openToRequests,
        updatedAtMs: now,
        disbandedAtMs: remaining.length === 0 ? now : null,
      };
      const removed = { ...membership, leftAtMs: now };
      const mutationInput = {
        event,
        actorUserId: input.actorUserId,
        action: "member.removed_by_admin",
        targetType: "member" as const,
        targetId: input.userId,
        prior: membership,
        result: removed,
        notifications: [
          {
            dedupeKey: `member.admin_removed:${membership.id}`,
            payload: { recipientUserId: input.userId, teamId: team.id },
          },
        ],
      };
      if (remaining.length === 0) {
        await this.commitEventTeamDisband({
          ...mutationInput,
          team: updated,
          memberships: [membership],
        });
      } else {
        await this.commitEventTeamMutation({
          ...mutationInput,
          mutation: {
            kind: "leave_membership",
            team: updated,
            membershipId: membership.id,
            leftAtMs: now,
          },
        });
      }
      return { team: updated, membership: removed };
    }

    const updated: EventTeam = {
      ...team,
      status: "disbanded",
      openToRequests: false,
      updatedAtMs: now,
      disbandedAtMs: now,
    };
    await this.commitEventTeamDisband({
      event,
      team: updated,
      memberships,
      actorUserId: input.actorUserId,
      action: "team.disbanded_by_admin",
      targetType: "team",
      targetId: team.id,
      prior: team,
      result: updated,
      notifications: memberships.map((membership) => ({
        dedupeKey: `team.admin_disbanded:${team.id}:${membership.userId}`,
        payload: { recipientUserId: membership.userId, teamId: team.id },
      })),
    });
    return { team: updated };
  }

  async listEventTeamProposals(input: {
    guildId: string;
    eventId: string;
    teamId?: string;
    status?: EventTeamProposal["status"];
    targetUserId?: string;
  }): Promise<EventTeamProposal[]> {
    return this.listProposals(input);
  }

  async leaveEventTeam(input: {
    guildId: string;
    eventId: string;
    userId: string;
  }): Promise<EventTeam> {
    await this.requirePaidPlan(input.guildId);
    const event = await this.requireMutableEvent(input.guildId, input.eventId);
    const [teams, memberships] = await Promise.all([
      this.store.listEventTeams(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
    ]);
    const membership = memberships.find((candidate) => candidate.userId === input.userId);
    if (!membership) throw new EventConfigError("You do not belong to an Event Team.");
    const team = teams.find(
      (candidate) => candidate.id === membership.teamId && candidate.status === "active",
    );
    if (!team) throw new EventConfigError("Event Team not found.");
    await this.enforceEventTeamRateLimit(event, input.userId, "membership_change");
    const remaining = memberships
      .filter((candidate) => candidate.teamId === team.id && candidate.id !== membership.id)
      .sort((left, right) => left.joinedAtMs - right.joinedAtMs);
    const now = Date.now();
    const updated: EventTeam = {
      ...team,
      captainUserId:
        remaining.length > 0 && team.captainUserId === input.userId
          ? remaining[0]!.userId
          : team.captainUserId,
      status: remaining.length === 0 ? "disbanded" : team.status,
      openToRequests: remaining.length === 0 ? false : team.openToRequests,
      updatedAtMs: now,
      disbandedAtMs: remaining.length === 0 ? now : team.disbandedAtMs,
    };
    const mutationInput = {
      event,
      actorUserId: input.userId,
      action: "member.left",
      targetType: "member" as const,
      targetId: input.userId,
      prior: membership,
      result: updated,
    };
    if (remaining.length === 0) {
      await this.commitEventTeamDisband({
        ...mutationInput,
        team: updated,
        memberships: [membership],
      });
    } else {
      await this.commitEventTeamMutation({
        ...mutationInput,
        mutation: {
          kind: "leave_membership",
          team: updated,
          membershipId: membership.id,
          leftAtMs: now,
        },
      });
    }
    return updated;
  }

  async organizerRemoveSignup(input: {
    guildId: string;
    eventId: string;
    userId: string;
    groupId: string;
  }): Promise<void> {
    const event = await this.requireEvent(input.guildId, input.eventId);
    const signup = (await this.store.listUserSignups(event.guildId, event.id, input.userId)).find(
      (item) => item.groupId === input.groupId,
    );
    if (!signup) return;
    const memberships = await this.store.listActiveEventTeamMemberships(event.guildId, event.id);
    const membership = memberships.find(
      (item) => item.userId === input.userId && item.groupId === input.groupId,
    );
    if (membership) {
      const team = (await this.store.listEventTeams(event.guildId, event.id)).find(
        (item) => item.id === membership.teamId && item.status === "active",
      );
      if (!team) throw new EventConfigError("Event Team not found.");
      if (["ended", "cancelled", "archived"].includes(event.status)) {
        throw new EventConfigError("This Event Team roster can no longer be changed.");
      }
      const now = Date.now();
      const remaining = memberships
        .filter((item) => item.teamId === team.id && item.id !== membership.id)
        .sort(
          (left, right) =>
            left.joinedAtMs - right.joinedAtMs || left.userId.localeCompare(right.userId),
        );
      const updated: EventTeam = {
        ...team,
        captainUserId:
          team.captainUserId === input.userId && remaining[0]
            ? remaining[0].userId
            : team.captainUserId,
        status: remaining.length === 0 ? "disbanded" : "active",
        openToRequests: remaining.length === 0 ? false : team.openToRequests,
        updatedAtMs: now,
        disbandedAtMs: remaining.length === 0 ? now : null,
      };
      const mutationInput = {
        event,
        actorUserId: "admin",
        action: "member.signup_removed_by_admin",
        targetType: "member" as const,
        targetId: input.userId,
        prior: { membership, signup },
        result: { ...membership, leftAtMs: now },
        deleteSignup: {
          guildId: signup.guildId,
          eventId: signup.eventId,
          userId: signup.userId,
          groupId: signup.groupId,
        },
      };
      if (remaining.length === 0) {
        await this.commitEventTeamDisband({
          ...mutationInput,
          team: updated,
          memberships: [membership],
        });
      } else {
        await this.commitEventTeamMutation({
          ...mutationInput,
          mutation: {
            kind: "leave_membership",
            team: updated,
            membershipId: membership.id,
            leftAtMs: now,
          },
        });
      }
      if (signup.status === "confirmed") await this.removeConfirmedSideEffects(event, signup);
    } else {
      await this.removeSignup(event, signup);
    }
    await this.promoteNextWaitlisted(event, input.groupId);
    await this.refreshEventMessage(event);
    await this.postAudit("event.leave", event, {
      userId: input.userId,
      groupId: input.groupId,
      source: "admin",
    });
  }

  async leaveGroup(event: EventRecord, userId: string, groupId: string): Promise<void> {
    const signups = await this.store.listUserSignups(event.guildId, event.id, userId);
    const signup = signups.find((item) => item.groupId === groupId);
    if (!signup) return;
    await this.removeSignup(event, signup);
    await this.promoteNextWaitlisted(event, groupId);
    await this.refreshEventMessage(event);
  }

  async processDueReminders(nowMs = Date.now()): Promise<number> {
    const dueReminders = await this.store.listDueReminders(nowMs, 50);
    let sent = 0;
    for (const { event, reminder } of dueReminders) {
      const entitlement = await this.readEntitlement(event.guildId);
      if (entitlement && !getGuildEntitlementLimits(entitlement.tier).paidFeatures) continue;
      if (entitlement && reminderDueAtMs(event, reminder) < entitlement.updatedAtMs) {
        await this.store.updateReminderSentAt({
          guildId: event.guildId,
          eventId: event.id,
          reminderId: reminder.id,
          sentAtMs: nowMs,
        });
        continue;
      }
      const signups = await this.store.listSignups(event.guildId, event.id);
      const audience = resolveReminderAudience(reminder, signups);
      const destinationChannelId = event.threadId ?? event.channelId;
      const resources = await this.readGuildResources(event.guildId);
      if (event.threadId) await resources?.requireThread(event.threadId, event.channelId);
      else resources?.requireTextChannel(event.channelId);
      await this.discord.createChannelMessage(destinationChannelId, {
        content: buildReminderContent(event, reminder, audience.userIds),
        allowed_mentions: audience.allowedMentions,
      });
      await this.store.updateReminderSentAt({
        guildId: event.guildId,
        eventId: event.id,
        reminderId: reminder.id,
        sentAtMs: nowMs,
      });
      await this.postAudit("event.reminder", event, {
        reminderId: reminder.id,
        audience: reminder.audience,
      });
      sent += 1;
    }
    return sent;
  }

  async processDueLifecycle(nowMs = Date.now()): Promise<number> {
    const dueEvents = await this.store.listDueLifecycleEvents(nowMs, 50);
    let changed = 0;
    for (const event of dueEvents) {
      if (!(await this.isPaidPlan(event.guildId))) continue;
      const action = dueEventLifecycleAction(event, nowMs);
      if (action === "end") {
        await this.endEvent(event, nowMs);
        changed += 1;
      } else if (action === "start") {
        await this.updateEventStatus(event, "live", nowMs, "event.lifecycle");
        changed += 1;
      }
    }
    return changed;
  }

  async listRecurrences(guildId: string) {
    return this.store.recurrence ? this.recurrenceService().list(guildId) : [];
  }

  async startRecurrence(input: {
    guildId: string;
    eventId: string;
    frequency: EventRecurrenceFrequency;
    untilAtMs: number | null;
    actorUserId: string;
  }) {
    return this.recurrenceService().start(input);
  }

  async stopRecurrence(guildId: string, seriesId: string) {
    return this.recurrenceService().stop(guildId, seriesId);
  }

  async processDueRecurrences(nowMs = Date.now()): Promise<number> {
    return this.store.recurrence ? this.recurrenceService().processDue(nowMs) : 0;
  }

  private recurrenceService() {
    if (!this.store.recurrence) throw new EventConfigError("Recurring Events are unavailable.");
    return new EventRecurrenceService(this.store.recurrence, {
      readEvent: (guildId, eventId) => this.store.readEvent(guildId, eventId),
      cleanupPreviousAccess: async (event) => {
        for (const signup of await this.store.listSignups(event.guildId, event.id)) {
          if (signup.status === "confirmed") await this.removeConfirmedSideEffects(event, signup);
          else if (event.threadId && event.waitlistedMembersJoinThread) {
            await this.removeEventThreadAccess(
              event,
              signup.userId,
              await this.readGuildResources(event.guildId),
            );
          }
        }
      },
      createEvent: (input, id) => this.createEvent(input, id),
      publishEvent: (input) => this.publishEvent(input),
      cancelEvent: (input) => this.cancelEvent(input),
      isPaidPlan: (guildId) => this.isPaidPlan(guildId),
    });
  }

  private async enforceEventTeamRateLimit(
    event: EventRecord,
    actorUserId: string,
    action: EventTeamRateLimitAction,
  ): Promise<void> {
    const policy = this.eventTeamRateLimits[action];
    const nowMs = Date.now();
    // Check the Event bucket first so a busy member cannot consume a token when the
    // Event-wide budget is already exhausted.
    for (const scope of [
      { scopeType: "event" as const, scopeId: event.id },
      { scopeType: "user" as const, scopeId: actorUserId },
    ]) {
      const result = this.store.consumeEventTeamRateLimit
        ? await this.store.consumeEventTeamRateLimit({
            guildId: event.guildId,
            eventId: event.id,
            action,
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            limit: policy.maxAttempts,
            windowMs: policy.windowMs,
            nowMs,
          })
        : this.consumeLocalEventTeamRateLimit(
            event.guildId,
            event.id,
            action,
            scope.scopeType,
            scope.scopeId,
            policy,
            nowMs,
          );
      if (!result.allowed)
        throw new EventTeamRateLimitError(action, result.retryAfterMs, scope.scopeType);
    }
  }

  private consumeLocalEventTeamRateLimit(
    guildId: string,
    eventId: string,
    action: EventTeamRateLimitAction,
    scopeType: EventTeamRateLimitScope,
    scopeId: string,
    policy: EventTeamRateLimitPolicy,
    nowMs: number,
  ) {
    const key = `${guildId}:${eventId}:${action}:${scopeType}:${scopeId}`;
    const previous = this.localEventTeamRateLimits.get(key);
    const current =
      !previous || nowMs - previous.windowStartedAtMs >= policy.windowMs
        ? { windowStartedAtMs: nowMs, attemptCount: 1 }
        : {
            ...previous,
            attemptCount: Math.min(policy.maxAttempts + 1, previous.attemptCount + 1),
          };
    this.localEventTeamRateLimits.set(key, current);
    const allowed = current.attemptCount <= policy.maxAttempts;
    return {
      allowed,
      remaining: Math.max(0, policy.maxAttempts - current.attemptCount),
      retryAfterMs: Math.max(0, current.windowStartedAtMs + policy.windowMs - nowMs),
    };
  }

  private async readEntitlement(guildId: string) {
    return this.guildEntitlements?.readGuildEntitlement(guildId);
  }

  private async requireActiveTeam(
    guildId: string,
    eventId: string,
    teamId: string,
  ): Promise<EventTeam> {
    const team = (await this.store.listEventTeams(guildId, eventId)).find(
      (item) => item.id === teamId && item.status === "active",
    );
    if (!team) throw new EventConfigError("Event Team not found.");
    return team;
  }

  private async requireSignedUpForGroup(
    event: EventRecord,
    userId: string,
    groupId: string,
  ): Promise<EventSignup> {
    const signup = (await this.store.listUserSignups(event.guildId, event.id, userId)).find(
      (item) => item.groupId === groupId,
    );
    if (!signup)
      throw new EventConfigError("Join this Signup Group before requesting an Event Team.");
    return signup;
  }

  private buildProposal(input: {
    event: EventRecord;
    team: EventTeam;
    kind: EventTeamProposal["kind"];
    requesterUserId: string;
    targetUserId: string;
  }): EventTeamProposal {
    const now = Date.now();
    return {
      guildId: input.event.guildId,
      eventId: input.event.id,
      id: `event-team-proposal-${now}-${Math.random().toString(36).slice(2, 8)}`,
      teamId: input.team.id,
      kind: input.kind,
      requesterUserId: input.requesterUserId,
      targetUserId: input.targetUserId,
      status: "pending",
      createdAtMs: now,
      updatedAtMs: now,
      resolvedAtMs: null,
    };
  }

  private async persistProposal(proposal: EventTeamProposal): Promise<void> {
    if (!this.store.createEventTeamProposal)
      throw new EventConfigError("Event Team proposals are unavailable.");
    const event = await this.requireEvent(proposal.guildId, proposal.eventId);
    await this.commitEventTeamMutation({
      mutation: { kind: "create_proposal", proposal },
      event,
      actorUserId:
        proposal.kind === "join_request" ? proposal.requesterUserId : proposal.requesterUserId,
      action: proposal.kind === "join_request" ? "proposal.join_requested" : "proposal.invited",
      targetType: "proposal",
      targetId: proposal.id,
      prior: null,
      result: proposal,
      notifications: [
        {
          dedupeKey: `proposal.created:${proposal.id}`,
          payload: {
            proposalId: proposal.id,
            kind: proposal.kind,
            targetUserId: proposal.targetUserId,
          },
        },
      ],
    });
  }

  private async updateProposal(proposal: EventTeamProposal): Promise<void> {
    if (!this.store.updateEventTeamProposal)
      throw new EventConfigError("Event Team proposals are unavailable.");
    await this.store.updateEventTeamProposal(proposal);
  }

  private async listProposals(input: {
    guildId: string;
    eventId: string;
    teamId?: string;
    status?: EventTeamProposal["status"];
    targetUserId?: string;
  }): Promise<EventTeamProposal[]> {
    if (!this.store.listEventTeamProposals)
      throw new EventConfigError("Event Team proposals are unavailable.");
    const [event, stored] = await Promise.all([
      this.requireEvent(input.guildId, input.eventId),
      this.store.listEventTeamProposals({
        guildId: input.guildId,
        eventId: input.eventId,
      }),
    ]);
    const proposals: EventTeamProposal[] = [];
    for (const proposal of stored) {
      proposals.push(
        proposal.status === "pending" && Date.now() >= event.signupCutoffAtMs
          ? await this.transitionProposal(proposal, "expired")
          : proposal,
      );
    }
    return proposals.filter(
      (proposal) =>
        (!input.teamId || proposal.teamId === input.teamId) &&
        (!input.status || proposal.status === input.status) &&
        (!input.targetUserId || proposal.targetUserId === input.targetUserId),
    );
  }

  private async requireProposal(input: {
    guildId: string;
    eventId: string;
    proposalId: string;
  }): Promise<EventTeamProposal> {
    if (!this.store.readEventTeamProposal)
      throw new EventConfigError("Event Team proposals are unavailable.");
    const proposal = await this.store.readEventTeamProposal(
      input.guildId,
      input.eventId,
      input.proposalId,
    );
    if (!proposal) throw new EventConfigError("Event Team proposal not found.");
    const event = await this.requireEvent(input.guildId, input.eventId);
    return proposal.status === "pending" && Date.now() >= event.signupCutoffAtMs
      ? this.transitionProposal(proposal, "expired")
      : proposal;
  }

  private async transitionProposal(
    proposal: EventTeamProposal,
    status: EventTeamProposal["status"],
  ): Promise<EventTeamProposal> {
    const now = Date.now();
    const next = { ...proposal, status, updatedAtMs: now, resolvedAtMs: now };
    const event = await this.requireEvent(proposal.guildId, proposal.eventId);
    await this.commitEventTeamMutation({
      mutation: { kind: "update_proposal", proposal: next },
      event,
      actorUserId: proposal.kind === "join_request" ? proposal.targetUserId : proposal.targetUserId,
      action: `proposal.${status}`,
      targetType: "proposal",
      targetId: proposal.id,
      prior: proposal,
      result: next,
      notifications: [...new Set([proposal.requesterUserId, proposal.targetUserId])].map(
        (recipientUserId) => ({
          dedupeKey: `proposal.${status}:${proposal.id}:${recipientUserId}`,
          payload: { proposalId: proposal.id, recipientUserId },
        }),
      ),
    });
    return next;
  }

  private async hasInvitationBlock(
    guildId: string,
    eventId: string,
    teamId: string,
    userId: string,
  ): Promise<boolean> {
    return this.store.hasEventTeamInvitationBlock
      ? this.store.hasEventTeamInvitationBlock(guildId, eventId, teamId, userId)
      : false;
  }

  private async updateEventTeam(team: EventTeam): Promise<void> {
    if (this.store.updateEventTeam) {
      await this.store.updateEventTeam(team);
      return;
    }
    throw new EventConfigError("Event Team updates are unavailable.");
  }

  private async isPaidPlan(guildId: string): Promise<boolean> {
    const entitlement = await this.readEntitlement(guildId);
    return !entitlement || getGuildEntitlementLimits(entitlement.tier).paidFeatures;
  }

  private async requirePaidPlan(guildId: string): Promise<void> {
    if (!(await this.isPaidPlan(guildId))) {
      throw new EventConfigError("Events requires a paid plan.");
    }
  }

  private async endEvent(event: EventRecord, nowMs: number): Promise<void> {
    await this.cleanupConfirmedSideEffects(event);
    await this.updateEventStatus(event, "ended", nowMs, "event.lifecycle");
  }

  private async cleanupConfirmedSideEffects(event: EventRecord): Promise<void> {
    const signups = await this.store.listSignups(event.guildId, event.id);
    for (const signup of signups) {
      if (signup.status !== "confirmed") continue;
      await this.removeConfirmedSideEffects(event, signup).catch(() => undefined);
    }
  }

  private async updateEventStatus(
    event: EventRecord,
    status: EventRecord["status"],
    nowMs: number,
    auditEventId?: AuditEventId,
  ): Promise<EventRecord> {
    const nextEvent: EventRecord = {
      ...event,
      status,
      updatedAtMs: nowMs,
      endedAtMs: status === "ended" ? nowMs : event.endedAtMs,
      cancelledAtMs: status === "cancelled" ? nowMs : event.cancelledAtMs,
      archivedAtMs: status === "archived" ? nowMs : event.archivedAtMs,
    };
    const history: EventLifecycleHistoryRecord = {
      guildId: event.guildId,
      eventId: event.id,
      id: `event-history-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
      fromStatus: event.status,
      toStatus: status,
      occurredAtMs: nowMs,
      retentionExpiresAtMs: nowMs + 365 * 24 * 60 * 60 * 1000,
    };
    const expectedStateVersion = this.store.readEventTeamStateVersion
      ? await this.store.readEventTeamStateVersion(event.guildId, event.id)
      : 0;
    const snapshots =
      event.status === "scheduled" && status === "live"
        ? await this.buildEventTeamRosterSnapshots(nextEvent, nowMs)
        : [];
    if (this.store.commitEventLifecycleTransition) {
      await this.store.commitEventLifecycleTransition({
        event: nextEvent,
        history,
        snapshots,
        expectedStatus: event.status,
        expectedStateVersion,
      });
    } else {
      await this.store.upsertEvent(nextEvent);
      if (this.store.appendEventLifecycleHistory) {
        await this.store.appendEventLifecycleHistory(history);
      }
      if (this.store.captureEventTeamRosterSnapshot) {
        for (const snapshot of snapshots) {
          await this.store.captureEventTeamRosterSnapshot(snapshot);
        }
      }
    }
    await this.refreshEventMessage(nextEvent);
    if (auditEventId) {
      await this.postAudit(auditEventId, nextEvent, { status });
    }
    return nextEvent;
  }

  private async removeSignup(event: EventRecord, signup: EventSignup): Promise<void> {
    if (signup.status === "confirmed") {
      await this.removeConfirmedSideEffects(event, signup);
    }
    await this.store.deleteSignup({
      guildId: signup.guildId,
      eventId: signup.eventId,
      userId: signup.userId,
      groupId: signup.groupId,
    });
    await this.postAudit("event.leave", event, {
      userId: signup.userId,
      groupId: signup.groupId,
      status: signup.status,
    });
  }

  private async promoteNextWaitlisted(event: EventRecord, groupId: string): Promise<void> {
    const group = requireGroup(event, groupId);
    const signups = await this.store.listSignups(event.guildId, event.id);
    if (resolveSignupStatus(group, signups) !== "confirmed") return;
    const next = signups.find(
      (signup) => signup.groupId === groupId && signup.status === "waitlisted",
    );
    if (!next) return;
    const promoted: EventSignup = { ...next, status: "confirmed", updatedAtMs: Date.now() };
    await this.store.upsertSignup(promoted);
    await this.applyConfirmedSideEffects(event, group, promoted.userId);
    await this.postAudit("event.signup", event, {
      userId: promoted.userId,
      groupId,
      status: "confirmed",
      source: "waitlist-promotion",
    });
  }

  private async removeConfirmedSideEffects(event: EventRecord, signup: EventSignup): Promise<void> {
    const group = event.groups.find((item) => item.id === signup.groupId);
    const resources = await this.readGuildResources(event.guildId);
    if (group?.grantRoleId) {
      try {
        resources?.requireRole(group.grantRoleId);
        await this.discord.removeGuildMemberRole(event.guildId, signup.userId, group.grantRoleId);
      } catch (error) {
        // Departed/deleted accounts already have no access to this Guild.
        if (isAbsentDiscordResource(error, [10007, 10013])) return;
        const missingRole =
          error instanceof GuildResourceValidationError && error.resourceKind === "role";
        if (!missingRole && !isAbsentDiscordResource(error, [10011])) throw error;
      }
    }
    await this.removeEventThreadAccess(event, signup.userId, resources);
  }

  private async removeEventThreadAccess(
    event: EventRecord,
    userId: string,
    resources: GuildResourceScope | null,
  ): Promise<void> {
    if (!event.threadId) return;
    try {
      await resources?.requireThread(event.threadId, event.channelId);
    } catch (error) {
      if (isAbsentDiscordResource(error, [10003])) return;
      throw error;
    }
    try {
      await this.discord.removeThreadMember(event.threadId, userId);
    } catch (error) {
      // Only explicit absence is reconciled; permission, ownership, and network
      // failures still stop a recurring series before its next publication.
      if (!isAbsentDiscordResource(error, [10003, 10007, 10013])) throw error;
    }
  }

  private async applyConfirmedSideEffects(
    event: EventRecord,
    group: EventSignupGroup,
    userId: string,
  ): Promise<void> {
    const resources = await this.readGuildResources(event.guildId);
    if (group.grantRoleId) resources?.requireRole(group.grantRoleId);
    if (event.threadId) await resources?.requireThread(event.threadId, event.channelId);
    if (group.grantRoleId) {
      await this.discord.addGuildMemberRole(event.guildId, userId, group.grantRoleId);
    }
    if (event.threadId) {
      await this.discord.addThreadMember(event.threadId, userId).catch(() => undefined);
    }
  }

  private async refreshEventMessage(event: EventRecord): Promise<void> {
    if (!event.messageId) return;
    const latest = (await this.store.readEvent(event.guildId, event.id)) ?? event;
    const signups = await this.store.listSignups(event.guildId, event.id);
    (await this.readGuildResources(latest.guildId))?.requireTextChannel(latest.channelId);
    await this.discord.editChannelMessage(
      latest.channelId,
      latest.messageId ?? event.messageId,
      buildEventMessage(latest, signups),
    );
  }

  private async readGuildResources(guildId: string): Promise<GuildResourceScope | null> {
    return this.guildResources ? await this.guildResources.forGuild(guildId) : null;
  }

  private requireGroupResources(
    groups: EventSignupGroup[],
    resources: GuildResourceScope | null,
  ): void {
    if (!resources) return;
    for (const group of groups) {
      resources.requireRoles(group.allowedRoleIds);
      resources.requireRoles(group.blockedRoleIds);
      if (group.grantRoleId) resources.requireRole(group.grantRoleId);
    }
  }

  private async requireEvent(guildId: string, eventId: string): Promise<EventRecord> {
    const event = await this.store.readEvent(guildId, eventId);
    if (!event) throw new EventConfigError("Event not found.");
    return event;
  }

  private async requireMutableEvent(guildId: string, eventId: string): Promise<EventRecord> {
    const event = await this.requireEvent(guildId, eventId);
    if (event.status !== "scheduled" && event.status !== "live") {
      throw new EventConfigError("This Event is not open for signup.");
    }
    if (Date.now() >= event.signupCutoffAtMs) {
      throw new EventConfigError("Signups are closed for this Event.");
    }
    return event;
  }

  private async postAudit(
    eventId: AuditEventId,
    event: EventRecord,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.auditLogStore) return;
    const channelId = await resolveAuditChannelId(event.guildId, null, this.auditLogStore, eventId);
    if (!channelId) return;
    try {
      (await this.readGuildResources(event.guildId))?.requireTextChannel(channelId);
      await this.discord.createChannelMessage(channelId, {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId] ?? eventId,
            color:
              eventId === "event.cancel"
                ? 0xed4245
                : eventId === "event.signup"
                  ? 0x57f287
                  : 0x5865f2,
            fields: [
              { name: "Event", value: event.title || event.id },
              { name: "Event ID", value: event.id },
              { name: "Status", value: event.status },
              { name: "Channel", value: `<#${event.channelId}>` },
              ...Object.entries(context).map(([key, value]) => ({
                name: key,
                value: String(value),
              })),
            ],
          }),
        ],
        allowed_mentions: suppressMentions(),
      });
    } catch (error) {
      console.error("Failed to post Event audit message", error);
    }
  }
}

function isAbsentDiscordResource(error: unknown, codes: readonly number[]): boolean {
  const cause = error instanceof GuildResourceValidationError ? error.cause : error;
  if (!(cause instanceof DiscordApiError) || cause.status !== 404) return false;
  try {
    const details: unknown = JSON.parse(cause.details);
    return isRecord(details) && typeof details.code === "number" && codes.includes(details.code);
  } catch {
    return false;
  }
}

function reminderDueAtMs(event: EventRecord, reminder: EventReminder): number {
  return event.startsAtMs - reminder.offsetMinutes * 60_000;
}

function createEventId(nowMs: number): string {
  return `event-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEventTeamId(nowMs: number): string {
  return `event-team-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEventTeamMembershipId(nowMs: number): string {
  return `event-team-member-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeEventTeamName(value: string): { name: string; normalizedName: string } {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) {
    throw new EventConfigError("Event Team names must be between 2 and 40 characters.");
  }
  if (/[@\r\n]/u.test(name)) {
    throw new EventConfigError("Event Team names cannot contain mentions or line breaks.");
  }
  const normalizedName = name.toLocaleLowerCase("en-US");
  return { name, normalizedName };
}

function createSignup(
  event: EventRecord,
  userId: string,
  groupId: string,
  status: EventSignup["status"],
): EventSignup {
  const now = Date.now();
  return {
    guildId: event.guildId,
    eventId: event.id,
    userId,
    groupId,
    status,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function resolveSignupStatus(
  group: EventSignupGroup,
  signups: EventSignup[],
): EventSignup["status"] {
  if (group.capacity === null) return "confirmed";
  const confirmed = signups.filter(
    (signup) => signup.groupId === group.id && signup.status === "confirmed",
  ).length;
  if (confirmed < group.capacity) return "confirmed";
  if (group.waitlistEnabled) return "waitlisted";
  throw new EventConfigError(`${group.label} is full.`);
}

function requireGroup(event: EventRecord, groupId: string): EventSignupGroup {
  const group = event.groups.find((item) => item.id === groupId);
  if (!group) throw new EventConfigError("Signup group not found.");
  return group;
}

function ensureEligible(group: EventSignupGroup, memberRoleIds: string[]): void {
  if (
    group.allowedRoleIds.length > 0 &&
    !group.allowedRoleIds.some((roleId) => memberRoleIds.includes(roleId))
  ) {
    throw new EventConfigError("You do not have the required role for this Signup Group.");
  }
  if (group.blockedRoleIds.some((roleId) => memberRoleIds.includes(roleId))) {
    throw new EventConfigError("You cannot join this Signup Group with your current roles.");
  }
}

function validateEvent(event: EventRecord): void {
  if (!event.title) throw new EventConfigError("Event title is required.");
  if (!event.channelId) throw new EventConfigError("Event channel is required.");
  if (!Number.isFinite(event.startsAtMs))
    throw new EventConfigError("Event start time is required.");
  if (event.groups.length === 0) throw new EventConfigError("Add at least one Signup Group.");
  if (
    event.participationMode === "team" &&
    (!Number.isInteger(event.requiredTeamSize) ||
      event.requiredTeamSize === null ||
      event.requiredTeamSize < 2 ||
      event.requiredTeamSize > 50)
  ) {
    throw new EventConfigError("Event Team size must be between 2 and 50.");
  }
  if (event.participationMode === "team" && event.signupMode !== "single_choice") {
    throw new EventConfigError("Team Events require single-choice Signup Groups.");
  }
}

function normalizeGroups(groups: EventSignupGroup[]): EventSignupGroup[] {
  return groups.map((group) => ({
    ...group,
    id: group.id.trim(),
    label: group.label.trim(),
    emoji: normalizeOptionalString(group.emoji),
    capacity: group.capacity === null ? null : Math.max(1, Math.floor(group.capacity)),
    allowedRoleIds: uniqueStrings(group.allowedRoleIds),
    blockedRoleIds: uniqueStrings(group.blockedRoleIds),
    grantRoleId: normalizeOptionalString(group.grantRoleId),
  }));
}

function normalizeReminders(reminders: EventReminder[]): EventReminder[] {
  return reminders.map((reminder) => ({
    ...reminder,
    id: reminder.id.trim(),
    signupGroupIds: uniqueStrings(reminder.signupGroupIds),
    message: reminder.message.trim(),
  }));
}

function normalizeOptionalString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function resolveReminderAudience(
  reminder: EventReminder,
  signups: EventSignup[],
): { userIds: string[]; allowedMentions: DiscordAllowedMentions } {
  if (reminder.audience === "channel_public" || reminder.audience === "not_signed_up") {
    return { userIds: [], allowedMentions: suppressMentions() };
  }
  const matching = signups.filter((signup) => {
    if (reminder.audience === "signed_up") return signup.status === "confirmed";
    if (reminder.audience === "waitlisted") return signup.status === "waitlisted";
    if (reminder.audience === "signup_group") {
      return signup.status === "confirmed" && reminder.signupGroupIds.includes(signup.groupId);
    }
    return false;
  });
  const userIds = [...new Set(matching.map((signup) => signup.userId))];
  return {
    userIds,
    allowedMentions: userIds.length > 0 ? allowUserMentions(userIds) : suppressMentions(),
  };
}

function buildReminderContent(
  event: EventRecord,
  reminder: EventReminder,
  userIds: string[],
): string {
  return [
    userIds.map((userId) => `<@${userId}>`).join(" "),
    `**${event.title}**`,
    reminder.message || `Event starts <t:${Math.floor(event.startsAtMs / 1000)}:R>.`,
  ]
    .filter(Boolean)
    .join("\n");
}
