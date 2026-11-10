import type {
  EventRecord,
  EventReminder,
  EventSignup,
  EventTeam,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamInvitationBlock,
  EventTeamMembership,
  EventTeamProposal,
  EventTeamRosterSnapshot,
  EventLifecycleHistoryRecord,
  EventTemplate,
} from "../../types";
import type { EventTeamBulkCommitInput } from "../../services/event-team-bulk-service";
import type { EventRecurrenceStore } from "./event-recurrence-store";

export interface EventReminderDue {
  event: EventRecord;
  reminder: EventReminder;
}

export type EventTeamRateLimitScope = "user" | "event";
export type EventTeamRateLimitAction =
  | "team_create"
  | "team_rename"
  | "team_invite"
  | "team_request"
  | "membership_change";

export interface EventTeamRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export type EventTeamMutation =
  | { kind: "create_team"; team: EventTeam; membership: EventTeamMembership }
  | { kind: "add_membership"; membership: EventTeamMembership }
  | { kind: "leave_membership"; team: EventTeam; membershipId: string; leftAtMs: number }
  | { kind: "update_team"; team: EventTeam }
  | { kind: "create_proposal"; proposal: EventTeamProposal }
  | { kind: "update_proposal"; proposal: EventTeamProposal };

export interface EventTeamMutationCommitInput {
  mutation: EventTeamMutation;
  deleteSignup?: Pick<EventSignup, "guildId" | "eventId" | "userId" | "groupId">;
  audit: EventTeamAuditRecord;
  deliveries: EventTeamDeliveryOutboxRecord[];
}

export interface EventTeamDisbandCommitInput {
  team: EventTeam;
  membershipIds: string[];
  leftAtMs: number;
  cancelPendingProposals: boolean;
  deleteSignup?: Pick<EventSignup, "guildId" | "eventId" | "userId" | "groupId">;
  audit: EventTeamAuditRecord;
  deliveries: EventTeamDeliveryOutboxRecord[];
}

export interface EventLifecycleTransitionCommitInput {
  event: EventRecord;
  history: EventLifecycleHistoryRecord;
  snapshots: EventTeamRosterSnapshot[];
  expectedStatus: EventRecord["status"];
  expectedStateVersion: number;
}

export interface EventStore {
  recurrence?: EventRecurrenceStore;
  createTemplate(template: EventTemplate): Promise<void>;
  upsertTemplate(template: EventTemplate): Promise<void>;
  readTemplate(guildId: string, templateId: string): Promise<EventTemplate | null>;
  listTemplates(guildId: string): Promise<EventTemplate[]>;
  createEvent(event: EventRecord): Promise<void>;
  upsertEvent(event: EventRecord): Promise<void>;
  readEvent(guildId: string, eventId: string): Promise<EventRecord | null>;
  listEvents(guildId: string): Promise<EventRecord[]>;
  listDueReminders(nowMs: number, limit?: number): Promise<EventReminderDue[]>;
  updateReminderSentAt(input: {
    guildId: string;
    eventId: string;
    reminderId: string;
    sentAtMs: number;
  }): Promise<void>;
  listDueLifecycleEvents(nowMs: number, limit?: number): Promise<EventRecord[]>;
  upsertSignup(signup: EventSignup): Promise<void>;
  deleteSignup(input: {
    guildId: string;
    eventId: string;
    userId: string;
    groupId: string;
  }): Promise<void>;
  listSignups(guildId: string, eventId: string): Promise<EventSignup[]>;
  listUserSignups(guildId: string, eventId: string, userId: string): Promise<EventSignup[]>;
  createEventTeamWithCaptain(input: {
    team: EventTeam;
    membership: EventTeamMembership;
  }): Promise<void>;
  /** Commits one authoritative Team mutation with its audit and delivery intents. */
  commitEventTeamMutation?(input: EventTeamMutationCommitInput): Promise<void>;
  /** Commits all membership leaves and disband side effects in one transaction. */
  commitEventTeamDisband?(input: EventTeamDisbandCommitInput): Promise<void>;
  addEventTeamMembership(membership: EventTeamMembership): Promise<void>;
  leaveEventTeamMembership(input: {
    team: EventTeam;
    membershipId: string;
    leftAtMs: number;
  }): Promise<void>;
  listEventTeams(guildId: string, eventId: string): Promise<EventTeam[]>;
  listActiveEventTeamMemberships(guildId: string, eventId: string): Promise<EventTeamMembership[]>;
  readEventTeamStateVersion?(guildId: string, eventId: string): Promise<number>;
  createEventTeamProposal?(proposal: EventTeamProposal): Promise<void>;
  updateEventTeamProposal?(proposal: EventTeamProposal): Promise<void>;
  readEventTeamProposal?(
    guildId: string,
    eventId: string,
    proposalId: string,
  ): Promise<EventTeamProposal | null>;
  listEventTeamProposals?(input: {
    guildId: string;
    eventId: string;
    teamId?: string;
    status?: EventTeamProposal["status"];
    targetUserId?: string;
  }): Promise<EventTeamProposal[]>;
  createEventTeamInvitationBlock?(block: EventTeamInvitationBlock): Promise<void>;
  hasEventTeamInvitationBlock?(
    guildId: string,
    eventId: string,
    teamId: string,
    userId: string,
  ): Promise<boolean>;
  /** Atomic pending/version CAS: signup, membership, and proposal transitions commit together. */
  acceptEventTeamProposalAtomic?(input: {
    proposal: EventTeamProposal;
    membership: EventTeamMembership;
    signup?: EventSignup;
    cancelProposalIds: string[];
    audit?: EventTeamAuditRecord;
    deliveries?: EventTeamDeliveryOutboxRecord[];
  }): Promise<void>;
  cancelEventTeamProposals?(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    status?: EventTeamProposal["status"];
    nowMs: number;
  }): Promise<void>;
  updateEventTeam?(team: EventTeam): Promise<void>;
  appendEventTeamAudit?(record: EventTeamAuditRecord): Promise<void>;
  listEventTeamAudit?(input: {
    guildId: string;
    eventId: string;
    limit?: number;
  }): Promise<EventTeamAuditRecord[]>;
  /** Inserts once and returns the existing row when a snapshot was already captured. */
  captureEventTeamRosterSnapshot?(
    snapshot: EventTeamRosterSnapshot,
  ): Promise<EventTeamRosterSnapshot>;
  readEventTeamRosterSnapshot?(
    guildId: string,
    eventId: string,
    teamId: string,
  ): Promise<EventTeamRosterSnapshot | null>;
  listEventTeamRosterSnapshots?(
    guildId: string,
    eventId: string,
  ): Promise<EventTeamRosterSnapshot[]>;
  enqueueEventTeamDelivery?(
    record: EventTeamDeliveryOutboxRecord,
  ): Promise<EventTeamDeliveryOutboxRecord>;
  listEventTeamDeliveries?(input: {
    guildId: string;
    eventId: string;
    status?: EventTeamDeliveryOutboxRecord["status"];
    limit?: number;
  }): Promise<EventTeamDeliveryOutboxRecord[]>;
  listDueEventTeamDeliveries?(input: {
    guildId?: string;
    eventId?: string;
    nowMs: number;
    limit?: number;
  }): Promise<EventTeamDeliveryOutboxRecord[]>;
  claimEventTeamDelivery?(input: {
    record: EventTeamDeliveryOutboxRecord;
    nowMs: number;
    leaseMs: number;
  }): Promise<EventTeamDeliveryOutboxRecord | null>;
  updateEventTeamDelivery?(
    record: EventTeamDeliveryOutboxRecord,
    expected?: EventTeamDeliveryOutboxRecord,
  ): Promise<void>;
  appendEventLifecycleHistory?(record: EventLifecycleHistoryRecord): Promise<void>;
  /** Commits lifecycle state, history, and all prebuilt roster snapshots atomically. */
  commitEventLifecycleTransition?(input: EventLifecycleTransitionCommitInput): Promise<void>;
  listEventLifecycleHistory?(
    guildId: string,
    eventId: string,
  ): Promise<EventLifecycleHistoryRecord[]>;
  pruneEventLifecycleHistory?(nowMs: number, limit?: number): Promise<number>;
  /** Explicitly cascades all Event-owned team, audit, snapshot, outbox, history, signup rows. */
  deleteEventPermanently?(input: { guildId: string; eventId: string }): Promise<void>;
  /** Revalidates the full preview revision and mutable lifecycle in its write transaction. */
  commitEventTeamBulkFormation?(input: EventTeamBulkCommitInput): Promise<unknown>;
  /** Atomically advances a sliding-window Event Team abuse counter. */
  consumeEventTeamRateLimit?(input: {
    guildId: string;
    eventId: string;
    action: EventTeamRateLimitAction;
    scopeType: EventTeamRateLimitScope;
    scopeId: string;
    limit: number;
    windowMs: number;
    nowMs: number;
  }): Promise<EventTeamRateLimitResult>;
}
