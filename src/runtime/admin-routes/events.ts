import { defineRoute, type Route } from "../admin-route-registry";
import type { AdminAccess } from "../admin-access";
import type { RuntimeStores } from "../app-types";
import type { CustomerSession } from "../auth/customer-session";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { ServiceFactory } from "../service-factory";
import { EventConfigError } from "../../services/events-service";
import { EventRecurrenceError } from "../../services/event-recurrence-service";
import { summarizeEventTeamOperations } from "../../services/event-team-metrics";
import type { CreateEventInput, EventTeamReadiness } from "../../services/events-service";
import {
  EventTeamBulkError,
  EventTeamBulkService,
  EventTeamBulkStalePreviewError,
} from "../../services/event-team-bulk-service";
import type {
  EventRecord,
  EventSignup,
  EventTeam,
  EventTeamMembership,
  EventTeamProposal,
} from "../../types";
import {
  addEventSignup,
  adminErrorEnvelopeSchema,
  archiveEvent,
  assignEventTeamMember,
  cancelEvent,
  commitEventTeamBulkFormation,
  createEvent,
  createEventTeam,
  createEventTemplate,
  exportEventRoster,
  getEvents,
  startEventRecurrence,
  stopEventRecurrence,
  publishEvent,
  previewEventTeamBulkFormation,
  overrideEventTeam,
  removeEventSignup,
  updateEvent,
} from "../../contracts/admin";

export interface EventsAdminRoutesOptions {
  stores: RuntimeStores;
  adminAccess: AdminAccess;
  discordBotToken: string;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  services: Pick<ServiceFactory, "eventsService">;
}

export function createEventsAdminRoutes(
  options: EventsAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  const service = options.services.eventsService;
  return [
    defineRoute({
      ...getEvents,
      method: "GET",
      path: "/admin/api/events",
      feature: "events",
      paidOnly: "premium-only-features",
      query: getEvents.query,
      success: getEvents.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [templates, events] = await Promise.all([
          options.stores.events.listTemplates(guildId),
          options.stores.events.listEvents(guildId),
        ]);
        const eventsWithSignups = await Promise.all(
          events.map(async (event) => {
            const [signups, teams, memberships, proposals, audit, snapshots, deliveries] =
              await Promise.all([
                options.stores.events.listSignups(guildId, event.id),
                options.stores.events.listEventTeams(guildId, event.id),
                options.stores.events.listActiveEventTeamMemberships(guildId, event.id),
                event.participationMode === "team"
                  ? service.listEventTeamProposals({ guildId, eventId: event.id })
                  : Promise.resolve([]),
                event.participationMode === "team"
                  ? options.stores.events.listEventTeamAudit({
                      guildId,
                      eventId: event.id,
                      limit: 200,
                    })
                  : Promise.resolve([]),
                event.participationMode === "team"
                  ? options.stores.events.listEventTeamRosterSnapshots(guildId, event.id)
                  : Promise.resolve([]),
                event.participationMode === "team"
                  ? options.stores.events.listEventTeamDeliveries({
                      guildId,
                      eventId: event.id,
                      limit: 200,
                    })
                  : Promise.resolve([]),
              ]);
            const readiness =
              event.participationMode === "team"
                ? await Promise.all(
                    teams.map((team) =>
                      service.getEventTeamReadiness({
                        guildId,
                        eventId: event.id,
                        teamId: team.id,
                      }),
                    ),
                  )
                : [];
            return {
              event,
              signups,
              teams,
              memberships,
              proposals,
              audit,
              snapshots,
              deliveries,
              integrityWarnings: deriveEventTeamIntegrityWarnings({
                event,
                signups,
                teams,
                memberships,
                proposals,
              }),
              expiredProposalCount: proposals.filter((proposal) => proposal.status === "expired")
                .length,
              readiness,
            };
          }),
        );
        const summary = summarizeEventTeamOperations(eventsWithSignups);
        console.info({ event: "haf.metric", metric: "event_team_readiness", guildId, ...summary });
        return Response.json({
          guildId,
          templates,
          events: eventsWithSignups,
          recurrences: await service.listRecurrences(guildId),
        });
      },
    }),
    defineRoute({
      ...startEventRecurrence,
      method: "POST",
      path: "/admin/api/events/recurrences",
      feature: "events",
      paidOnly: "premium-only-features",
      body: startEventRecurrence.body,
      success: startEventRecurrence.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          return Response.json({
            series: await service.startRecurrence({
              ...body,
              actorUserId: await readActorUserId(options, request),
            }),
          });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...stopEventRecurrence,
      method: "POST",
      path: "/admin/api/events/recurrences/stop",
      feature: "events",
      paidOnly: "premium-only-features",
      body: stopEventRecurrence.body,
      success: stopEventRecurrence.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          return Response.json({
            series: await service.stopRecurrence(body.guildId, body.seriesId),
          });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...createEventTemplate,
      method: "POST",
      path: "/admin/api/events/templates",
      feature: "events",
      paidOnly: "premium-only-features",
      body: createEventTemplate.body,
      success: createEventTemplate.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          const template = await service.createTemplate({
            guildId: body.guildId,
            id: createTemplateId(),
            name: body.name,
            description: body.description ?? "",
            signupMode: body.signupMode ?? "single_choice",
            participationMode: body.participationMode ?? "individual",
            requiredTeamSize: body.requiredTeamSize ?? null,
            threadEnabled: body.threadEnabled ?? false,
            waitlistedMembersJoinThread: body.waitlistedMembersJoinThread ?? false,
            groups: normalizeGroups(body.groups),
            reminders: normalizeReminders(body.reminders ?? []),
          });
          return Response.json({ template });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...createEvent,
      method: "POST",
      path: "/admin/api/events",
      feature: "events",
      paidOnly: "premium-only-features",
      body: createEvent.body,
      success: createEvent.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          const event = await service.createEvent(toCreateEventInput(body));
          return Response.json({ event, signups: [] });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...updateEvent,
      method: "PUT",
      path: "/admin/api/events",
      feature: "events",
      paidOnly: "premium-only-features",
      body: updateEvent.body,
      success: updateEvent.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          const event = await service.updateEvent({
            ...toCreateEventInput(body),
            eventId: body.eventId,
          });
          const signups = await options.stores.events.listSignups(body.guildId, body.eventId);
          return Response.json({ event, signups });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...publishEvent,
      method: "POST",
      path: "/admin/api/events/publish",
      feature: "events",
      paidOnly: "premium-only-features",
      body: publishEvent.body,
      success: publishEvent.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const event = await service.publishEvent({
            guildId: body.guildId,
            eventId: body.eventId,
            actorUserId: await readActorUserId(options, request),
          });
          const signups = await options.stores.events.listSignups(body.guildId, body.eventId);
          return Response.json({ event, signups });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...cancelEvent,
      method: "POST",
      path: "/admin/api/events/cancel",
      feature: "events",
      paidOnly: "premium-only-features",
      body: cancelEvent.body,
      success: cancelEvent.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const event = await service.cancelEvent({
            guildId: body.guildId,
            eventId: body.eventId,
            actorUserId: await readActorUserId(options, request),
          });
          const signups = await options.stores.events.listSignups(body.guildId, body.eventId);
          return Response.json({ event, signups });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...archiveEvent,
      method: "POST",
      path: "/admin/api/events/archive",
      feature: "events",
      paidOnly: "premium-only-features",
      body: archiveEvent.body,
      success: archiveEvent.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const event = await service.archiveEvent({
            guildId: body.guildId,
            eventId: body.eventId,
            actorUserId: await readActorUserId(options, request),
          });
          const signups = await options.stores.events.listSignups(body.guildId, body.eventId);
          return Response.json({ event, signups });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...addEventSignup,
      method: "POST",
      path: "/admin/api/events/signup",
      feature: "events",
      paidOnly: "premium-only-features",
      body: addEventSignup.body,
      success: addEventSignup.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          await service.organizerSignup({
            guildId: body.guildId,
            eventId: body.eventId,
            userId: body.userId,
            groupId: body.groupId,
            status: body.status,
          });
          const event = await options.stores.events.readEvent(body.guildId, body.eventId);
          const signups = await options.stores.events.listSignups(body.guildId, body.eventId);
          return Response.json({ event, signups });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...removeEventSignup,
      method: "POST",
      path: "/admin/api/events/remove-signup",
      feature: "events",
      paidOnly: "premium-only-features",
      body: removeEventSignup.body,
      success: removeEventSignup.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          await service.organizerRemoveSignup({
            guildId: body.guildId,
            eventId: body.eventId,
            userId: body.userId,
            groupId: body.groupId,
          });
          const event = await options.stores.events.readEvent(body.guildId, body.eventId);
          const signups = await options.stores.events.listSignups(body.guildId, body.eventId);
          return Response.json({ event, signups });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...createEventTeam,
      method: "POST",
      path: "/admin/api/events/teams",
      feature: "events",
      paidOnly: "premium-only-features",
      body: createEventTeam.body,
      success: createEventTeam.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const team = await service.createEventTeam({
            guildId: body.guildId,
            eventId: body.eventId,
            userId: body.userId,
            groupId: body.groupId,
            name: body.name,
            actorUserId: await readActorUserId(options, request),
          });
          return Response.json({ team });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...assignEventTeamMember,
      method: "POST",
      path: "/admin/api/events/teams/members",
      feature: "events",
      paidOnly: "premium-only-features",
      body: assignEventTeamMember.body,
      success: assignEventTeamMember.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const membership = await service.organizerAddEventTeamMember({
            guildId: body.guildId,
            eventId: body.eventId,
            teamId: body.teamId,
            userId: body.userId,
            actorUserId: await readActorUserId(options, request),
          });
          return Response.json({ membership });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...overrideEventTeam,
      method: "POST",
      path: "/admin/api/events/teams/override",
      feature: "events",
      paidOnly: "premium-only-features",
      body: overrideEventTeam.body,
      success: overrideEventTeam.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const result = await service.organizerOverrideEventTeam({
            guildId: body.guildId,
            eventId: body.eventId,
            teamId: body.teamId,
            actorUserId: await readActorUserId(options, request),
            action: body.action,
            confirmed: body.confirmed,
            name: body.name,
            userId: body.userId,
            newCaptainUserId: body.newCaptainUserId,
          });
          return Response.json(result);
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...previewEventTeamBulkFormation,
      method: "POST",
      path: "/admin/api/events/teams/bulk-preview",
      feature: "events",
      paidOnly: "premium-only-features",
      body: previewEventTeamBulkFormation.body,
      success: previewEventTeamBulkFormation.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          const preview = await resolveEventTeamBulkService(options).preview({
            guildId: body.guildId,
            eventId: body.eventId,
            groupId: body.groupId,
            strategy: body.strategy,
            seed: body.seed,
            fillPartialTeams: body.fillPartialTeams,
            includeIncomplete: body.includeIncomplete,
            namePrefix: body.namePrefix,
          });
          return Response.json({ preview });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...commitEventTeamBulkFormation,
      method: "POST",
      path: "/admin/api/events/teams/bulk-commit",
      feature: "events",
      paidOnly: "premium-only-features",
      body: commitEventTeamBulkFormation.body,
      success: commitEventTeamBulkFormation.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          if (body.preview.guildId !== body.guildId || body.preview.eventId !== body.eventId) {
            throw new EventTeamBulkError(
              "event_mismatch",
              "Bulk preview scope does not match this Event.",
            );
          }
          await resolveEventTeamBulkService(options).commit(
            body.preview,
            await readActorUserId(options, request),
          );
          return Response.json({ committed: true as const });
        } catch (error) {
          return eventErrorResponse(error);
        }
      },
    }),
    defineRoute({
      ...exportEventRoster,
      method: "GET",
      path: "/admin/api/events/roster-export",
      feature: "events",
      paidOnly: "premium-only-features",
      query: exportEventRoster.query,
      success: exportEventRoster.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const event = await options.stores.events.readEvent(guildId, query.eventId);
        if (!event) return eventErrorResponse(new EventConfigError("Event not found."));
        const [signups, teams, memberships] = await Promise.all([
          options.stores.events.listSignups(guildId, event.id),
          options.stores.events.listEventTeams(guildId, event.id),
          options.stores.events.listActiveEventTeamMemberships(guildId, event.id),
        ]);
        const readiness = new Map(
          await Promise.all(
            teams
              .filter((team) => team.status === "active")
              .map(async (team) => {
                const summary = await service.getEventTeamReadiness({
                  guildId,
                  eventId: event.id,
                  teamId: team.id,
                });
                return [team.id, summary] as const;
              }),
          ),
        );
        return Response.json({
          filename: `${slugifyFilename(event.title)}-${event.id}-roster.csv`,
          csv: buildEventRosterCsv({ event, signups, teams, memberships, readiness }),
        });
      },
    }),
  ];
}

function eventErrorResponse(error: unknown): Response {
  if (error instanceof EventTeamBulkStalePreviewError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof EventTeamBulkError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof EventConfigError || error instanceof EventRecurrenceError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  throw error;
}

function resolveEventTeamBulkService(options: EventsAdminRoutesOptions): EventTeamBulkService {
  return new EventTeamBulkService(options.stores.events);
}

function toCreateEventInput(body: any): CreateEventInput {
  return {
    guildId: body.guildId,
    templateId: body.templateId ?? null,
    title: body.title,
    description: body.description ?? "",
    channelId: body.channelId,
    startsAtMs: body.startsAtMs,
    endsAtMs: body.endsAtMs,
    signupCutoffAtMs: body.signupCutoffAtMs,
    signupMode: body.signupMode ?? "single_choice",
    participationMode: body.participationMode ?? "individual",
    requiredTeamSize: body.requiredTeamSize ?? null,
    threadEnabled: body.threadEnabled ?? false,
    waitlistedMembersJoinThread: body.waitlistedMembersJoinThread ?? false,
    groups: normalizeGroups(body.groups),
    reminders: normalizeReminders(body.reminders ?? []),
  };
}

function normalizeGroups(groups: any[]) {
  return groups.map((group: any) => ({
    id: group.id,
    label: group.label,
    emoji: group.emoji ?? null,
    capacity: group.capacity,
    waitlistEnabled: group.waitlistEnabled ?? true,
    allowedRoleIds: group.allowedRoleIds ?? [],
    blockedRoleIds: group.blockedRoleIds ?? [],
    grantRoleId: group.grantRoleId ?? null,
  }));
}

function normalizeReminders(reminders: any[]) {
  return reminders.map((reminder: any) => ({
    id: reminder.id,
    offsetMinutes: reminder.offsetMinutes,
    audience: reminder.audience,
    signupGroupIds: reminder.signupGroupIds ?? [],
    message: reminder.message ?? "",
    sentAtMs: reminder.sentAtMs ?? null,
  }));
}

function createTemplateId() {
  return `event-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildEventRosterCsv(input: {
  event: EventRecord | null;
  signups: EventSignup[];
  teams: EventTeam[];
  memberships: EventTeamMembership[];
  readiness: Map<string, EventTeamReadiness>;
}): string {
  if (!input.event) throw new EventConfigError("Event not found.");
  const groupById = new Map(input.event.groups.map((group) => [group.id, group]));
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const membershipByUserId = new Map(
    input.memberships.map((membership) => [membership.userId, membership]),
  );
  const rows = input.signups.map((signup) => {
    const membership = membershipByUserId.get(signup.userId);
    const team = membership ? teamById.get(membership.teamId) : undefined;
    const summary = team ? input.readiness.get(team.id) : undefined;
    const readiness = !team
      ? "unassigned"
      : summary?.ready
        ? "ready"
        : summary?.reasons.includes("member_waitlisted")
          ? "awaiting_capacity"
          : "incomplete";
    return [
      groupById.get(signup.groupId)?.label ?? signup.groupId,
      team?.name ?? "",
      String(team?.captainUserId === signup.userId),
      signup.userId,
      signup.status,
      readiness,
    ];
  });
  return [
    [
      "signup_group",
      "event_team",
      "is_captain",
      "participant_id",
      "confirmation_state",
      "readiness",
    ],
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")
    .concat("\n");
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function slugifyFilename(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "event"
  );
}

function deriveEventTeamIntegrityWarnings(input: {
  event: EventRecord;
  signups: EventSignup[];
  teams: EventTeam[];
  memberships: EventTeamMembership[];
  proposals: EventTeamProposal[];
}): string[] {
  if (input.event.participationMode !== "team") return [];
  const warnings = new Set<string>();
  const activeTeams = new Map(
    input.teams.filter((team) => team.status === "active").map((team) => [team.id, team]),
  );
  const signupsByUserId = new Map(input.signups.map((signup) => [signup.userId, signup]));
  for (const team of activeTeams.values()) {
    const roster = input.memberships.filter((membership) => membership.teamId === team.id);
    if (!roster.some((membership) => membership.userId === team.captainUserId)) {
      warnings.add("Event Team captain is not an active member.");
    }
    if (input.event.requiredTeamSize !== null && roster.length > input.event.requiredTeamSize) {
      warnings.add("Event Team roster exceeds the required size.");
    }
  }
  for (const membership of input.memberships) {
    const team = activeTeams.get(membership.teamId);
    if (!team) {
      warnings.add("An active membership references a missing or disbanded Event Team.");
      continue;
    }
    const signup = signupsByUserId.get(membership.userId);
    if (!signup || signup.groupId !== team.groupId || membership.groupId !== team.groupId) {
      warnings.add("An Event Team membership has an incompatible Signup Group.");
    }
  }
  if (
    input.proposals.some(
      (proposal) => proposal.status === "pending" && !activeTeams.has(proposal.teamId),
    )
  ) {
    warnings.add("A pending proposal references a missing or disbanded Event Team.");
  }
  return [...warnings];
}

async function readActorUserId(
  options: EventsAdminRoutesOptions,
  request: Request,
): Promise<string> {
  const session = await options.readCustomerAdminSession?.(request);
  return session?.user.discordUserId ?? session?.user.id ?? "admin-ui";
}
