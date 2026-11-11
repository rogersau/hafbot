import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";
import {
  eventRecurrenceFrequencySchema,
  eventRecurrenceSummarySchema,
} from "../../event-recurrence";

const eventQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().optional(),
});

const eventParamsSchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  eventId: z.string().min(1),
});

const signupGroupInputSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  emoji: z.string().nullable().optional(),
  capacity: z.number().int().positive().nullable(),
  waitlistEnabled: z.boolean().optional(),
  allowedRoleIds: z.array(z.string().min(1)).optional(),
  blockedRoleIds: z.array(z.string().min(1)).optional(),
  grantRoleId: z.string().nullable().optional(),
});

const reminderInputSchema = z.object({
  id: z.string().min(1),
  offsetMinutes: z.number().int().min(0),
  audience: z.enum(["signed_up", "waitlisted", "not_signed_up", "channel_public", "signup_group"]),
  signupGroupIds: z.array(z.string().min(1)).optional(),
  message: z.string().max(1000).optional(),
  sentAtMs: z.number().int().nullable().optional(),
});

const eventBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  templateId: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().max(2000).optional(),
  channelId: z.string().min(1),
  startsAtMs: z.number().int().positive(),
  endsAtMs: z.number().int().positive().nullable(),
  signupCutoffAtMs: z.number().int().positive().nullable(),
  signupMode: z.enum(["single_choice", "multi_choice"]).optional(),
  participationMode: z.enum(["individual", "team"]).optional(),
  requiredTeamSize: z.number().int().min(2).max(50).nullable().optional(),
  threadEnabled: z.boolean().optional(),
  waitlistedMembersJoinThread: z.boolean().optional(),
  groups: z.array(signupGroupInputSchema).min(1).max(25),
  reminders: z.array(reminderInputSchema).optional(),
});

const updateEventBodySchema = eventBodySchema.extend({ eventId: z.string().min(1) });

const templateBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().max(1000).optional(),
  signupMode: z.enum(["single_choice", "multi_choice"]).optional(),
  participationMode: z.enum(["individual", "team"]).optional(),
  requiredTeamSize: z.number().int().min(2).max(50).nullable().optional(),
  threadEnabled: z.boolean().optional(),
  waitlistedMembersJoinThread: z.boolean().optional(),
  groups: z.array(signupGroupInputSchema).min(1).max(25),
  reminders: z.array(reminderInputSchema).optional(),
});

const signupBodySchema = eventParamsSchema.extend({
  userId: z.string().min(1),
  groupId: z.string().min(1),
  status: z.enum(["confirmed", "waitlisted"]).optional(),
});

const removeSignupBodySchema = signupBodySchema.omit({ status: true });

const signupGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  emoji: z.string().nullable(),
  capacity: z.number().int().positive().nullable(),
  waitlistEnabled: z.boolean(),
  allowedRoleIds: z.array(z.string()),
  blockedRoleIds: z.array(z.string()),
  grantRoleId: z.string().nullable(),
});

const reminderSchema = z.object({
  id: z.string(),
  offsetMinutes: z.number().int().min(0),
  audience: z.enum(["signed_up", "waitlisted", "not_signed_up", "channel_public", "signup_group"]),
  signupGroupIds: z.array(z.string()),
  message: z.string(),
  sentAtMs: z.number().int().nullable(),
});

const templateSchema = z.object({
  guildId: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  signupMode: z.enum(["single_choice", "multi_choice"]),
  participationMode: z.enum(["individual", "team"]),
  requiredTeamSize: z.number().int().min(2).max(50).nullable(),
  threadEnabled: z.boolean(),
  waitlistedMembersJoinThread: z.boolean(),
  groups: z.array(signupGroupSchema),
  reminders: z.array(reminderSchema),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

const eventSchema = z.object({
  guildId: z.string(),
  id: z.string(),
  templateId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["draft", "scheduled", "live", "ended", "cancelled", "archived"]),
  channelId: z.string(),
  messageId: z.string().nullable(),
  threadId: z.string().nullable(),
  startsAtMs: z.number().int(),
  endsAtMs: z.number().int().nullable(),
  signupCutoffAtMs: z.number().int(),
  signupMode: z.enum(["single_choice", "multi_choice"]),
  participationMode: z.enum(["individual", "team"]),
  requiredTeamSize: z.number().int().min(2).max(50).nullable(),
  threadEnabled: z.boolean(),
  waitlistedMembersJoinThread: z.boolean(),
  groups: z.array(signupGroupSchema),
  reminders: z.array(reminderSchema),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  publishedAtMs: z.number().nullable(),
  cancelledAtMs: z.number().nullable(),
  endedAtMs: z.number().nullable(),
  archivedAtMs: z.number().nullable(),
});

const signupSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  userId: z.string(),
  groupId: z.string(),
  status: z.enum(["confirmed", "waitlisted"]),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

const eventTeamSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  id: z.string(),
  groupId: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  captainUserId: z.string(),
  openToRequests: z.boolean(),
  status: z.enum(["active", "disbanded"]),
  createdByUserId: z.string(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  disbandedAtMs: z.number().nullable(),
});

const eventTeamMembershipSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  id: z.string(),
  teamId: z.string(),
  groupId: z.string(),
  userId: z.string(),
  joinedAtMs: z.number(),
  leftAtMs: z.number().nullable(),
});

const eventTeamProposalSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  id: z.string(),
  teamId: z.string(),
  kind: z.enum(["join_request", "invitation"]),
  requesterUserId: z.string(),
  targetUserId: z.string(),
  status: z.enum([
    "pending",
    "accepted",
    "declined",
    "rejected",
    "withdrawn",
    "cancelled",
    "expired",
  ]),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  resolvedAtMs: z.number().nullable(),
});

const eventTeamReadinessSchema = z.object({
  teamId: z.string(),
  rosterCount: z.number().int().nonnegative(),
  confirmedCount: z.number().int().nonnegative(),
  openPlaces: z.number().int().nonnegative(),
  ready: z.boolean(),
  reasons: z.array(z.enum(["roster_incomplete", "member_waitlisted"])),
});

const eventTeamAuditSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  id: z.string(),
  actorUserId: z.string(),
  action: z.string(),
  targetType: z.enum(["team", "proposal", "member", "captain", "admin", "event"]),
  targetId: z.string(),
  prior: z.unknown(),
  result: z.unknown(),
  occurredAtMs: z.number(),
});

const eventTeamSnapshotSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  teamId: z.string(),
  requiredTeamSize: z.number().int().min(2).max(50),
  members: z.array(
    z.object({
      membershipId: z.string(),
      userId: z.string(),
      groupId: z.string(),
      signupStatus: z.enum(["confirmed", "waitlisted"]).nullable(),
    }),
  ),
  capturedAtMs: z.number(),
});

const eventTeamDeliverySchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  id: z.string(),
  kind: z.enum(["notification", "canonical_refresh"]),
  dedupeKey: z.string(),
  payload: z.unknown(),
  status: z.enum(["pending", "processing", "delivered", "failed"]),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  lastError: z.string().nullable(),
  terminalFailureReason: z.string().nullable(),
  nextAttemptAtMs: z.number(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  deliveredAtMs: z.number().nullable(),
});

const eventTeamBulkProposalSchema = z.object({
  existingTeamId: z.string().nullable(),
  groupId: z.string(),
  name: z.string().min(2).max(40),
  captainUserId: z.string().min(1),
  memberUserIds: z.array(z.string().min(1)),
  addUserIds: z.array(z.string().min(1)),
  incomplete: z.boolean(),
});

const eventTeamBulkPreviewSchema = z.object({
  version: z.literal(1),
  guildId: z.string(),
  eventId: z.string(),
  groupId: z.string(),
  strategy: z.enum(["signup_order", "shuffle"]),
  seed: z.string(),
  fillPartialTeams: z.boolean(),
  includeIncomplete: z.boolean(),
  namePrefix: z.string(),
  revision: z.string(),
  proposals: z.array(eventTeamBulkProposalSchema),
  unassignedUserIds: z.array(z.string()),
  consideredSignupUserIds: z.array(z.string()),
});

const eventWithSignupsSchema = z.object({
  event: eventSchema,
  signups: z.array(signupSchema),
  teams: z.array(eventTeamSchema),
  memberships: z.array(eventTeamMembershipSchema),
  proposals: z.array(eventTeamProposalSchema),
  audit: z.array(eventTeamAuditSchema),
  snapshots: z.array(eventTeamSnapshotSchema),
  deliveries: z.array(eventTeamDeliverySchema),
  integrityWarnings: z.array(z.string()),
  expiredProposalCount: z.number().int().nonnegative(),
  readiness: z.array(eventTeamReadinessSchema),
});

const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.entitlementRequired,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const writeErrors = [
  ...readErrors,
  adminOperationErrors.resourceNotFound,
  adminOperationErrors.conflict,
] as const;
const metadata = {
  tags: ["Events"],
  feature: "events",
  entitlement: "premium-only-features",
} as const;

export const getEvents = defineAdminOperation({
  ...metadata,
  operationId: "events.get",
  method: "GET",
  path: "/admin/api/events",
  summary: "List Events and Event Templates",
  query: eventQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      templates: z.array(templateSchema),
      events: z.array(eventWithSignupsSchema),
      recurrences: z.array(eventRecurrenceSummarySchema).optional(),
    }),
    description: "Events, Signup rosters, and Event Templates for the Guild",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const startEventRecurrence = defineAdminOperation({
  ...metadata,
  operationId: "eventsRecurrences.post",
  method: "POST",
  path: "/admin/api/events/recurrences",
  summary: "Start daily or weekly Event recurrence",
  body: eventParamsSchema.extend({
    frequency: eventRecurrenceFrequencySchema,
    untilAtMs: z.number().int().positive().nullable(),
  }),
  success: {
    status: 200,
    schema: z.object({ series: eventRecurrenceSummarySchema }),
    description: "The recurring Event series",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const stopEventRecurrence = defineAdminOperation({
  ...metadata,
  operationId: "eventsRecurrencesStop.post",
  method: "POST",
  path: "/admin/api/events/recurrences/stop",
  summary: "Stop future occurrences of an Event series",
  body: z.object({
    guildId: z.string().min(1),
    workspaceId: z.string().optional(),
    seriesId: z.string().min(1),
  }),
  success: {
    status: 200,
    schema: z.object({ series: eventRecurrenceSummarySchema }),
    description: "The stopped recurring Event series",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const createEventTemplate = defineAdminOperation({
  ...metadata,
  operationId: "eventsTemplates.post",
  method: "POST",
  path: "/admin/api/events/templates",
  summary: "Create an Event Template",
  body: templateBodySchema,
  success: {
    status: 200,
    schema: z.object({ template: templateSchema }),
    description: "The created Event Template",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const createEvent = defineAdminOperation({
  ...metadata,
  operationId: "events.post",
  method: "POST",
  path: "/admin/api/events",
  summary: "Create an Event",
  body: eventBodySchema,
  success: {
    status: 200,
    schema: z.object({ event: eventSchema, signups: z.array(signupSchema) }),
    description: "The created Event and its Signup roster",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const updateEvent = defineAdminOperation({
  ...metadata,
  operationId: "events.put",
  method: "PUT",
  path: "/admin/api/events",
  summary: "Update an Event",
  body: updateEventBodySchema,
  success: {
    status: 200,
    schema: z.object({ event: eventSchema, signups: z.array(signupSchema) }),
    description: "The updated Event and its Signup roster",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

function eventAction(name: "publish" | "cancel" | "archive") {
  return defineAdminOperation({
    ...metadata,
    operationId: `events${name[0]!.toUpperCase()}${name.slice(1)}.post`,
    method: "POST",
    path: `/admin/api/events/${name}`,
    summary: `${name[0]!.toUpperCase()}${name.slice(1)} an Event`,
    body: eventParamsSchema,
    success: {
      status: 200,
      schema: z.object({ event: eventSchema, signups: z.array(signupSchema) }),
      description: `The ${name}d Event and its Signup roster`,
    },
    errors: writeErrors,
    access: { scope: "guild", mode: "write" },
  });
}

export const publishEvent = eventAction("publish");
export const cancelEvent = eventAction("cancel");
export const archiveEvent = eventAction("archive");

export const addEventSignup = defineAdminOperation({
  ...metadata,
  operationId: "eventsSignup.post",
  method: "POST",
  path: "/admin/api/events/signup",
  summary: "Add or update an Event Signup",
  body: signupBodySchema,
  success: {
    status: 200,
    schema: z.object({ event: eventSchema, signups: z.array(signupSchema) }),
    description: "The Event and updated Signup roster",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const removeEventSignup = defineAdminOperation({
  ...metadata,
  operationId: "eventsRemoveSignup.post",
  method: "POST",
  path: "/admin/api/events/remove-signup",
  summary: "Remove an Event Signup",
  body: removeSignupBodySchema,
  success: {
    status: 200,
    schema: z.object({ event: eventSchema, signups: z.array(signupSchema) }),
    description: "The Event and updated Signup roster",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const createEventTeam = defineAdminOperation({
  ...metadata,
  operationId: "eventsTeam.post",
  method: "POST",
  path: "/admin/api/events/teams",
  summary: "Create an Event Team",
  body: eventParamsSchema.extend({
    userId: z.string().min(1),
    groupId: z.string().min(1),
    name: z.string().min(2).max(40),
  }),
  success: {
    status: 200,
    schema: z.object({ team: eventTeamSchema }),
    description: "The created Event Team",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const assignEventTeamMember = defineAdminOperation({
  ...metadata,
  operationId: "eventsTeamMember.post",
  method: "POST",
  path: "/admin/api/events/teams/members",
  summary: "Assign a participant to an Event Team",
  body: eventParamsSchema.extend({
    teamId: z.string().min(1),
    userId: z.string().min(1),
  }),
  success: {
    status: 200,
    schema: z.object({ membership: eventTeamMembershipSchema }),
    description: "The created Event Team membership",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const overrideEventTeam = defineAdminOperation({
  ...metadata,
  operationId: "eventsTeamOverride.post",
  method: "POST",
  path: "/admin/api/events/teams/override",
  summary: "Override an Event Team roster",
  body: eventParamsSchema.extend({
    teamId: z.string().min(1),
    action: z.enum(["rename", "disband", "transfer_captain", "remove_member"]),
    // Overrides are deliberately impossible to submit without an explicit
    // confirmation from the authenticated administrator.
    confirmed: z.literal(true),
    name: z.string().min(2).max(40).optional(),
    userId: z.string().min(1).optional(),
    newCaptainUserId: z.string().min(1).optional(),
  }),
  success: {
    status: 200,
    schema: z.object({ team: eventTeamSchema, membership: eventTeamMembershipSchema.optional() }),
    description: "The updated Event Team and optional membership",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const exportEventRoster = defineAdminOperation({
  ...metadata,
  operationId: "eventsRosterExport.get",
  method: "GET",
  path: "/admin/api/events/roster-export",
  summary: "Export an Event roster as CSV",
  query: eventParamsSchema,
  success: {
    status: 200,
    schema: z.object({ filename: z.string().min(1), csv: z.string() }),
    description: "The operational Event roster CSV",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const previewEventTeamBulkFormation = defineAdminOperation({
  ...metadata,
  operationId: "eventsTeamBulkPreview.post",
  method: "POST",
  path: "/admin/api/events/teams/bulk-preview",
  summary: "Preview bulk Event Team formation",
  body: eventParamsSchema.extend({
    groupId: z.string().min(1),
    strategy: z.enum(["signup_order", "shuffle"]).optional(),
    seed: z.string().optional(),
    fillPartialTeams: z.boolean().optional(),
    includeIncomplete: z.boolean().optional(),
    namePrefix: z.string().max(32).optional(),
  }),
  success: {
    status: 200,
    schema: z.object({ preview: eventTeamBulkPreviewSchema }),
    description: "A stable, editable Event Team bulk formation preview",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const commitEventTeamBulkFormation = defineAdminOperation({
  ...metadata,
  operationId: "eventsTeamBulkCommit.post",
  method: "POST",
  path: "/admin/api/events/teams/bulk-commit",
  summary: "Atomically commit an Event Team bulk preview",
  body: z.object({
    guildId: z.string().min(1),
    workspaceId: z.string().optional(),
    eventId: z.string().min(1),
    preview: eventTeamBulkPreviewSchema,
  }),
  success: {
    status: 200,
    schema: z.object({ committed: z.literal(true) }),
    description: "The Event Team bulk preview was committed atomically",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const eventsContracts = {
  get: getEvents,
  startRecurrence: startEventRecurrence,
  stopRecurrence: stopEventRecurrence,
  createTemplate: createEventTemplate,
  create: createEvent,
  update: updateEvent,
  publish: publishEvent,
  cancel: cancelEvent,
  archive: archiveEvent,
  signup: addEventSignup,
  removeSignup: removeEventSignup,
  createTeam: createEventTeam,
  assignTeamMember: assignEventTeamMember,
  overrideTeam: overrideEventTeam,
  exportRoster: exportEventRoster,
  previewBulkFormation: previewEventTeamBulkFormation,
  commitBulkFormation: commitEventTeamBulkFormation,
} as const;
