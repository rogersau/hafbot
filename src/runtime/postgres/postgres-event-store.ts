import { executePostgresStatements } from "./postgres-statements";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  eventSignups,
  eventLifecycleTransitionGuards,
  eventTeamInvitationBlocks,
  eventTeamAuditRecords,
  eventTeamBulkCommitGuards,
  eventTeamDeliveryOutbox,
  eventTeamMemberships,
  eventTeamProposals,
  eventTeamProposalAcceptanceGuards,
  eventTeamRosterSnapshots,
  eventTeamRateLimits,
  eventTeamStateVersions,
  eventTeams,
  eventSignupMutationGuards,
  eventLifecycleHistory,
  eventTemplates,
  events,
} from "../../db/postgres/app-schema";
import type {
  EventRecord,
  EventLifecycleHistoryRecord,
  EventReminder,
  EventSignup,
  EventSignupGroup,
  EventTeam,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamInvitationBlock,
  EventTeamMembership,
  EventTeamProposal,
  EventTeamRosterSnapshot,
  EventTemplate,
} from "../../types";
import type { EventReminderDue, EventStore } from "../contracts";
import type { EventTeamBulkCommitInput } from "../../services/event-team-bulk-service";
import { isRecord } from "../../unknown-parse";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import { createPostgresEventRecurrenceStore } from "./postgres-event-recurrence-store";

type EventTemplateRow = typeof eventTemplates.$inferSelect;
type EventRow = typeof events.$inferSelect;
type EventSignupRow = typeof eventSignups.$inferSelect;
type EventTeamRow = typeof eventTeams.$inferSelect;
type EventTeamMembershipRow = typeof eventTeamMemberships.$inferSelect;
type EventTeamProposalRow = typeof eventTeamProposals.$inferSelect;
type EventTeamAuditRow = typeof eventTeamAuditRecords.$inferSelect;
type EventTeamRosterSnapshotRow = typeof eventTeamRosterSnapshots.$inferSelect;
type EventTeamDeliveryOutboxRow = typeof eventTeamDeliveryOutbox.$inferSelect;
type EventLifecycleHistoryRow = typeof eventLifecycleHistory.$inferSelect;

export function createPostgresEventStore(database: PostgresDatabaseCapability): EventStore {
  const db = database.drizzle;
  const incrementEventTeamStateVersion = (guildId: string, eventId: string) =>
    db
      .insert(eventTeamStateVersions)
      .values({ guildId, eventId, version: 1 })
      .onConflictDoUpdate({
        target: [eventTeamStateVersions.guildId, eventTeamStateVersions.eventId],
        set: { version: sql`${eventTeamStateVersions.version} + 1` },
      });
  const deliveryInsert = (record: EventTeamDeliveryOutboxRecord) => {
    const values = eventTeamDeliveryToRow(record);
    const insert = db.insert(eventTeamDeliveryOutbox).values(values);
    return record.kind === "canonical_refresh"
      ? insert.onConflictDoUpdate({
          target: [
            eventTeamDeliveryOutbox.guildId,
            eventTeamDeliveryOutbox.eventId,
            eventTeamDeliveryOutbox.dedupeKey,
          ],
          set: {
            payloadJson: values.payloadJson,
            status: "pending",
            attemptCount: 0,
            maxAttempts: values.maxAttempts,
            lastError: null,
            terminalFailureReason: null,
            nextAttemptAtMs: values.nextAttemptAtMs,
            updatedAtMs: values.updatedAtMs,
            deliveredAtMs: null,
          },
        })
      : insert.onConflictDoNothing();
  };
  const mutationStatements = (
    mutation: Parameters<NonNullable<EventStore["commitEventTeamMutation"]>>[0]["mutation"],
  ): unknown[] => {
    switch (mutation.kind) {
      case "create_team":
        return [
          db.insert(eventTeams).values(teamToRow(mutation.team)),
          db.insert(eventTeamMemberships).values(membershipToRow(mutation.membership)),
        ];
      case "add_membership":
        return [db.insert(eventTeamMemberships).values(membershipToRow(mutation.membership))];
      case "leave_membership": {
        const values = teamToRow(mutation.team);
        return [
          db
            .update(eventTeamMemberships)
            .set({ leftAtMs: mutation.leftAtMs })
            .where(
              and(
                eq(eventTeamMemberships.guildId, mutation.team.guildId),
                eq(eventTeamMemberships.eventId, mutation.team.eventId),
                eq(eventTeamMemberships.membershipId, mutation.membershipId),
                isNull(eventTeamMemberships.leftAtMs),
              ),
            ),
          db
            .insert(eventTeams)
            .values(values)
            .onConflictDoUpdate({
              target: [eventTeams.guildId, eventTeams.eventId, eventTeams.teamId],
              set: values,
            }),
        ];
      }
      case "update_team":
        return [
          db
            .update(eventTeams)
            .set(teamToRow(mutation.team))
            .where(
              and(
                eq(eventTeams.guildId, mutation.team.guildId),
                eq(eventTeams.eventId, mutation.team.eventId),
                eq(eventTeams.teamId, mutation.team.id),
              ),
            ),
        ];
      case "create_proposal":
        return [db.insert(eventTeamProposals).values(proposalToRow(mutation.proposal))];
      case "update_proposal":
        return [
          db
            .update(eventTeamProposals)
            .set(proposalToRow(mutation.proposal))
            .where(
              and(
                eq(eventTeamProposals.guildId, mutation.proposal.guildId),
                eq(eventTeamProposals.eventId, mutation.proposal.eventId),
                eq(eventTeamProposals.proposalId, mutation.proposal.id),
              ),
            ),
        ];
    }
  };
  const store: EventStore = {
    recurrence: createPostgresEventRecurrenceStore(database),
    async createTemplate(template) {
      await db.insert(eventTemplates).values(templateToRow(template)).execute();
    },

    async upsertTemplate(template) {
      const values = templateToRow(template);
      await db
        .insert(eventTemplates)
        .values(values)
        .onConflictDoUpdate({
          target: [eventTemplates.guildId, eventTemplates.templateId],
          set: values,
        })
        .execute();
    },

    async readTemplate(guildId, templateId) {
      const row = await db
        .select()
        .from(eventTemplates)
        .where(and(eq(eventTemplates.guildId, guildId), eq(eventTemplates.templateId, templateId)))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToTemplate(row) : null;
    },

    async listTemplates(guildId) {
      const rows = await db
        .select()
        .from(eventTemplates)
        .where(eq(eventTemplates.guildId, guildId))
        .orderBy(desc(eventTemplates.updatedAtMs))
        .execute();
      return rows.map(rowToTemplate);
    },

    async createEvent(event) {
      await executePostgresStatements(database, [
        db.insert(events).values(eventToRow(event)),
        incrementEventTeamStateVersion(event.guildId, event.id),
      ]);
    },

    async upsertEvent(event) {
      const values = eventToRow(event);
      await executePostgresStatements(database, [
        db
          .insert(events)
          .values(values)
          .onConflictDoUpdate({
            target: [events.guildId, events.eventId],
            set: values,
          }),
        incrementEventTeamStateVersion(event.guildId, event.id),
      ]);
    },

    async readEvent(guildId, eventId) {
      const row = await db
        .select()
        .from(events)
        .where(and(eq(events.guildId, guildId), eq(events.eventId, eventId)))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToEvent(row) : null;
    },

    async listEvents(guildId) {
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.guildId, guildId))
        .orderBy(desc(events.startsAtMs))
        .execute();
      return rows.map(rowToEvent);
    },

    async listDueReminders(nowMs, limit = 50) {
      const rows = await db
        .select()
        .from(events)
        .where(inArray(events.status, ["scheduled", "live"]))
        .orderBy(asc(events.startsAtMs))
        .limit(Math.max(1, Math.min(limit * 4, 200)))
        .execute();
      const due: EventReminderDue[] = [];
      for (const row of rows) {
        const event = rowToEvent(row);
        for (const reminder of event.reminders) {
          if (reminder.sentAtMs !== null) continue;
          const dueAtMs = event.startsAtMs - reminder.offsetMinutes * 60 * 1000;
          if (dueAtMs <= nowMs) due.push({ event, reminder });
          if (due.length >= limit) return due;
        }
      }
      return due;
    },

    async updateReminderSentAt(input) {
      const event = await this.readEvent(input.guildId, input.eventId);
      if (!event) return;
      await this.upsertEvent({
        ...event,
        reminders: event.reminders.map((reminder) =>
          reminder.id === input.reminderId ? { ...reminder, sentAtMs: input.sentAtMs } : reminder,
        ),
        updatedAtMs: input.sentAtMs,
      });
    },

    async listDueLifecycleEvents(nowMs, limit = 50) {
      const rows = await db
        .select()
        .from(events)
        .where(
          or(
            and(eq(events.status, "scheduled"), lte(events.startsAtMs, nowMs)),
            and(eq(events.status, "live"), lte(events.endsAtMs, nowMs)),
          ),
        )
        .orderBy(asc(events.startsAtMs))
        .limit(Math.max(1, Math.min(limit, 100)))
        .execute();
      return rows.map(rowToEvent);
    },

    async upsertSignup(signup) {
      const values = signupToRow(signup);
      const guardId = crypto.randomUUID();
      await executePostgresStatements(database, [
        db.insert(eventSignupMutationGuards).values({
          guardId,
          guildId: signup.guildId,
          eventId: signup.eventId,
          userId: signup.userId,
          groupId: signup.groupId,
          operation: "upsert",
        }),
        db
          .insert(eventSignups)
          .values(values)
          .onConflictDoUpdate({
            target: [
              eventSignups.guildId,
              eventSignups.eventId,
              eventSignups.userId,
              eventSignups.groupId,
            ],
            set: values,
          }),
        incrementEventTeamStateVersion(signup.guildId, signup.eventId),
        db.delete(eventSignupMutationGuards).where(eq(eventSignupMutationGuards.guardId, guardId)),
      ] as never);
    },

    async deleteSignup(input) {
      const guardId = crypto.randomUUID();
      await executePostgresStatements(database, [
        db.insert(eventSignupMutationGuards).values({ ...input, guardId, operation: "delete" }),
        db
          .delete(eventSignups)
          .where(
            and(
              eq(eventSignups.guildId, input.guildId),
              eq(eventSignups.eventId, input.eventId),
              eq(eventSignups.userId, input.userId),
              eq(eventSignups.groupId, input.groupId),
            ),
          ),
        incrementEventTeamStateVersion(input.guildId, input.eventId),
        db.delete(eventSignupMutationGuards).where(eq(eventSignupMutationGuards.guardId, guardId)),
      ] as never);
    },

    async listSignups(guildId, eventId) {
      const rows = await db
        .select()
        .from(eventSignups)
        .where(and(eq(eventSignups.guildId, guildId), eq(eventSignups.eventId, eventId)))
        .orderBy(asc(eventSignups.createdAtMs))
        .execute();
      return rows.map(rowToSignup);
    },

    async listUserSignups(guildId, eventId, userId) {
      const rows = await db
        .select()
        .from(eventSignups)
        .where(
          and(
            eq(eventSignups.guildId, guildId),
            eq(eventSignups.eventId, eventId),
            eq(eventSignups.userId, userId),
          ),
        )
        .orderBy(asc(eventSignups.createdAtMs))
        .execute();
      return rows.map(rowToSignup);
    },

    async createEventTeamWithCaptain(input) {
      await executePostgresStatements(database, [
        db.insert(eventTeams).values(teamToRow(input.team)),
        db.insert(eventTeamMemberships).values(membershipToRow(input.membership)),
        incrementEventTeamStateVersion(input.team.guildId, input.team.eventId),
      ]);
    },

    async commitEventTeamMutation(input) {
      const rosterScope =
        input.mutation.kind === "create_proposal" || input.mutation.kind === "update_proposal"
          ? null
          : input.mutation.kind === "add_membership"
            ? input.mutation.membership
            : input.mutation.team;
      await executePostgresStatements(database, [
        ...mutationStatements(input.mutation),
        ...(input.deleteSignup
          ? [
              db
                .delete(eventSignups)
                .where(
                  and(
                    eq(eventSignups.guildId, input.deleteSignup.guildId),
                    eq(eventSignups.eventId, input.deleteSignup.eventId),
                    eq(eventSignups.userId, input.deleteSignup.userId),
                    eq(eventSignups.groupId, input.deleteSignup.groupId),
                  ),
                ),
            ]
          : []),
        db.insert(eventTeamAuditRecords).values(eventTeamAuditToRow(input.audit)),
        ...input.deliveries.map(deliveryInsert),
        ...(rosterScope
          ? [incrementEventTeamStateVersion(rosterScope.guildId, rosterScope.eventId)]
          : []),
      ] as never);
    },

    async commitEventTeamDisband(input) {
      const teamValues = teamToRow(input.team);
      const statements: unknown[] = [
        ...input.membershipIds.map((membershipId) =>
          db
            .update(eventTeamMemberships)
            .set({ leftAtMs: input.leftAtMs })
            .where(
              and(
                eq(eventTeamMemberships.guildId, input.team.guildId),
                eq(eventTeamMemberships.eventId, input.team.eventId),
                eq(eventTeamMemberships.membershipId, membershipId),
                isNull(eventTeamMemberships.leftAtMs),
              ),
            ),
        ),
        db
          .update(eventTeams)
          .set(teamValues)
          .where(
            and(
              eq(eventTeams.guildId, input.team.guildId),
              eq(eventTeams.eventId, input.team.eventId),
              eq(eventTeams.teamId, input.team.id),
            ),
          ),
      ];
      if (input.cancelPendingProposals) {
        statements.push(
          db
            .update(eventTeamProposals)
            .set({
              status: "cancelled",
              updatedAtMs: input.leftAtMs,
              resolvedAtMs: input.leftAtMs,
            })
            .where(
              and(
                eq(eventTeamProposals.guildId, input.team.guildId),
                eq(eventTeamProposals.eventId, input.team.eventId),
                eq(eventTeamProposals.teamId, input.team.id),
                eq(eventTeamProposals.status, "pending"),
              ),
            ),
        );
      }
      if (input.deleteSignup) {
        statements.push(
          db
            .delete(eventSignups)
            .where(
              and(
                eq(eventSignups.guildId, input.deleteSignup.guildId),
                eq(eventSignups.eventId, input.deleteSignup.eventId),
                eq(eventSignups.userId, input.deleteSignup.userId),
                eq(eventSignups.groupId, input.deleteSignup.groupId),
              ),
            ),
        );
      }
      statements.push(
        db.insert(eventTeamAuditRecords).values(eventTeamAuditToRow(input.audit)),
        ...input.deliveries.map(deliveryInsert),
        incrementEventTeamStateVersion(input.team.guildId, input.team.eventId),
      );
      await executePostgresStatements(database, statements as never);
    },

    async consumeEventTeamRateLimit(input) {
      const key = {
        guildId: input.guildId,
        eventId: input.eventId,
        action: input.action,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      };
      const values = {
        ...key,
        windowStartedAtMs: input.nowMs,
        attemptCount: 1,
        updatedAtMs: input.nowMs,
      };
      await db
        .insert(eventTeamRateLimits)
        .values(values)
        .onConflictDoUpdate({
          target: [
            eventTeamRateLimits.guildId,
            eventTeamRateLimits.eventId,
            eventTeamRateLimits.action,
            eventTeamRateLimits.scopeType,
            eventTeamRateLimits.scopeId,
          ],
          set: {
            windowStartedAtMs: sql`CASE WHEN ${eventTeamRateLimits.windowStartedAtMs} + ${input.windowMs} <= ${input.nowMs} THEN ${input.nowMs} ELSE ${eventTeamRateLimits.windowStartedAtMs} END`,
            attemptCount: sql`CASE WHEN ${eventTeamRateLimits.windowStartedAtMs} + ${input.windowMs} <= ${input.nowMs} THEN 1 ELSE LEAST(${input.limit + 1}, ${eventTeamRateLimits.attemptCount} + 1) END`,
            updatedAtMs: input.nowMs,
          },
        })
        .execute();
      const row = await db
        .select({
          windowStartedAtMs: eventTeamRateLimits.windowStartedAtMs,
          attemptCount: eventTeamRateLimits.attemptCount,
        })
        .from(eventTeamRateLimits)
        .where(
          and(
            eq(eventTeamRateLimits.guildId, input.guildId),
            eq(eventTeamRateLimits.eventId, input.eventId),
            eq(eventTeamRateLimits.action, input.action),
            eq(eventTeamRateLimits.scopeType, input.scopeType),
            eq(eventTeamRateLimits.scopeId, input.scopeId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      const attemptCount = row?.attemptCount ?? 1;
      const windowStartedAtMs = row?.windowStartedAtMs ?? input.nowMs;
      return {
        allowed: attemptCount <= input.limit,
        remaining: Math.max(0, input.limit - attemptCount),
        retryAfterMs: Math.max(0, windowStartedAtMs + input.windowMs - input.nowMs),
      };
    },

    async addEventTeamMembership(membership) {
      try {
        await executePostgresStatements(database, [
          db.insert(eventTeamMemberships).values(membershipToRow(membership)),
          incrementEventTeamStateVersion(membership.guildId, membership.eventId),
        ]);
      } catch (error) {
        if (error instanceof Error && error.cause instanceof Error) throw error.cause;
        throw error;
      }
    },

    async leaveEventTeamMembership(input) {
      const teamValues = teamToRow(input.team);
      await executePostgresStatements(database, [
        db
          .update(eventTeamMemberships)
          .set({ leftAtMs: input.leftAtMs })
          .where(
            and(
              eq(eventTeamMemberships.guildId, input.team.guildId),
              eq(eventTeamMemberships.eventId, input.team.eventId),
              eq(eventTeamMemberships.membershipId, input.membershipId),
              isNull(eventTeamMemberships.leftAtMs),
            ),
          ),
        db
          .insert(eventTeams)
          .values(teamValues)
          .onConflictDoUpdate({
            target: [eventTeams.guildId, eventTeams.eventId, eventTeams.teamId],
            set: teamValues,
          }),
        incrementEventTeamStateVersion(input.team.guildId, input.team.eventId),
      ]);
    },

    async listEventTeams(guildId, eventId) {
      const rows = await db
        .select()
        .from(eventTeams)
        .where(and(eq(eventTeams.guildId, guildId), eq(eventTeams.eventId, eventId)))
        .orderBy(asc(eventTeams.createdAtMs))
        .execute();
      return rows.map(rowToTeam);
    },

    async listActiveEventTeamMemberships(guildId, eventId) {
      const rows = await db
        .select()
        .from(eventTeamMemberships)
        .where(
          and(
            eq(eventTeamMemberships.guildId, guildId),
            eq(eventTeamMemberships.eventId, eventId),
            isNull(eventTeamMemberships.leftAtMs),
          ),
        )
        .orderBy(asc(eventTeamMemberships.joinedAtMs))
        .execute();
      return rows.map(rowToMembership);
    },

    async readEventTeamStateVersion(guildId, eventId) {
      const row = await db
        .select({ version: eventTeamStateVersions.version })
        .from(eventTeamStateVersions)
        .where(
          and(
            eq(eventTeamStateVersions.guildId, guildId),
            eq(eventTeamStateVersions.eventId, eventId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!row) throw new Error("Event Team state version not found.");
      return row.version;
    },

    async createEventTeamProposal(proposal) {
      await db.insert(eventTeamProposals).values(proposalToRow(proposal)).execute();
    },

    async updateEventTeamProposal(proposal) {
      const values = proposalToRow(proposal);
      await db
        .update(eventTeamProposals)
        .set(values)
        .where(
          and(
            eq(eventTeamProposals.guildId, proposal.guildId),
            eq(eventTeamProposals.eventId, proposal.eventId),
            eq(eventTeamProposals.proposalId, proposal.id),
          ),
        )
        .execute();
    },

    async readEventTeamProposal(guildId, eventId, proposalId) {
      const row = await db
        .select()
        .from(eventTeamProposals)
        .where(
          and(
            eq(eventTeamProposals.guildId, guildId),
            eq(eventTeamProposals.eventId, eventId),
            eq(eventTeamProposals.proposalId, proposalId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToProposal(row) : null;
    },

    async listEventTeamProposals(input) {
      const conditions = [
        eq(eventTeamProposals.guildId, input.guildId),
        eq(eventTeamProposals.eventId, input.eventId),
      ];
      if (input.teamId) conditions.push(eq(eventTeamProposals.teamId, input.teamId));
      if (input.status) conditions.push(eq(eventTeamProposals.status, input.status));
      if (input.targetUserId)
        conditions.push(eq(eventTeamProposals.targetUserId, input.targetUserId));
      const rows = await db
        .select()
        .from(eventTeamProposals)
        .where(and(...conditions))
        .orderBy(asc(eventTeamProposals.createdAtMs))
        .execute();
      return rows.map(rowToProposal);
    },

    async createEventTeamInvitationBlock(block) {
      await db
        .insert(eventTeamInvitationBlocks)
        .values(blockToRow(block))
        .onConflictDoNothing()
        .execute();
    },

    async hasEventTeamInvitationBlock(guildId, eventId, teamId, userId) {
      const row = await db
        .select({ userId: eventTeamInvitationBlocks.userId })
        .from(eventTeamInvitationBlocks)
        .where(
          and(
            eq(eventTeamInvitationBlocks.guildId, guildId),
            eq(eventTeamInvitationBlocks.eventId, eventId),
            eq(eventTeamInvitationBlocks.teamId, teamId),
            eq(eventTeamInvitationBlocks.userId, userId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return Boolean(row);
    },

    async acceptEventTeamProposalAtomic(input) {
      const current = await db
        .select({ updatedAtMs: eventTeamProposals.updatedAtMs })
        .from(eventTeamProposals)
        .where(
          and(
            eq(eventTeamProposals.guildId, input.proposal.guildId),
            eq(eventTeamProposals.eventId, input.proposal.eventId),
            eq(eventTeamProposals.proposalId, input.proposal.id),
            eq(eventTeamProposals.status, "pending"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!current) throw new Error("Event Team proposal is no longer pending.");
      const proposalValues = proposalToRow(input.proposal);
      const guard = {
        guildId: input.proposal.guildId,
        eventId: input.proposal.eventId,
        proposalId: input.proposal.id,
        expectedUpdatedAtMs: current.updatedAtMs,
      };
      const statements: unknown[] = [
        db.insert(eventTeamProposalAcceptanceGuards).values(guard),
        ...(input.signup
          ? [
              db
                .insert(eventSignups)
                .values(signupToRow(input.signup))
                .onConflictDoUpdate({
                  target: [
                    eventSignups.guildId,
                    eventSignups.eventId,
                    eventSignups.userId,
                    eventSignups.groupId,
                  ],
                  set: signupToRow(input.signup),
                }),
            ]
          : []),
        db
          .update(eventTeamProposals)
          .set(proposalValues)
          .where(
            and(
              eq(eventTeamProposals.guildId, input.proposal.guildId),
              eq(eventTeamProposals.eventId, input.proposal.eventId),
              eq(eventTeamProposals.proposalId, input.proposal.id),
              eq(eventTeamProposals.status, "pending"),
              eq(eventTeamProposals.updatedAtMs, current.updatedAtMs),
            ),
          ),
        db.insert(eventTeamMemberships).values(membershipToRow(input.membership)),
        ...input.cancelProposalIds.map((proposalId) =>
          db
            .update(eventTeamProposals)
            .set({
              status: "cancelled",
              updatedAtMs: input.proposal.updatedAtMs,
              resolvedAtMs: input.proposal.updatedAtMs,
            })
            .where(
              and(
                eq(eventTeamProposals.guildId, input.proposal.guildId),
                eq(eventTeamProposals.eventId, input.proposal.eventId),
                eq(eventTeamProposals.proposalId, proposalId),
                eq(eventTeamProposals.status, "pending"),
              ),
            ),
        ),
        ...(input.audit
          ? [db.insert(eventTeamAuditRecords).values(eventTeamAuditToRow(input.audit))]
          : []),
        ...(input.deliveries ?? []).map(deliveryInsert),
        incrementEventTeamStateVersion(input.proposal.guildId, input.proposal.eventId),
        db
          .delete(eventTeamProposalAcceptanceGuards)
          .where(
            and(
              eq(eventTeamProposalAcceptanceGuards.guildId, guard.guildId),
              eq(eventTeamProposalAcceptanceGuards.eventId, guard.eventId),
              eq(eventTeamProposalAcceptanceGuards.proposalId, guard.proposalId),
            ),
          ),
      ];
      await executePostgresStatements(database, statements as never);
    },

    async cancelEventTeamProposals(input) {
      const conditions = [
        eq(eventTeamProposals.guildId, input.guildId),
        eq(eventTeamProposals.eventId, input.eventId),
        eq(eventTeamProposals.teamId, input.teamId),
        eq(eventTeamProposals.status, input.status ?? "pending"),
      ];
      await db
        .update(eventTeamProposals)
        .set({ status: "cancelled", updatedAtMs: input.nowMs, resolvedAtMs: input.nowMs })
        .where(and(...conditions))
        .execute();
    },

    async updateEventTeam(team) {
      const values = teamToRow(team);
      await executePostgresStatements(database, [
        db
          .update(eventTeams)
          .set(values)
          .where(
            and(
              eq(eventTeams.guildId, team.guildId),
              eq(eventTeams.eventId, team.eventId),
              eq(eventTeams.teamId, team.id),
            ),
          ),
        incrementEventTeamStateVersion(team.guildId, team.eventId),
      ]);
    },

    async appendEventTeamAudit(record) {
      await db.insert(eventTeamAuditRecords).values(eventTeamAuditToRow(record)).execute();
    },

    async listEventTeamAudit(input) {
      const rows = await db
        .select()
        .from(eventTeamAuditRecords)
        .where(
          and(
            eq(eventTeamAuditRecords.guildId, input.guildId),
            eq(eventTeamAuditRecords.eventId, input.eventId),
          ),
        )
        .orderBy(desc(eventTeamAuditRecords.occurredAtMs))
        .limit(Math.max(1, Math.min(input.limit ?? 100, 500)))
        .execute();
      return rows.map(rowToEventTeamAudit);
    },

    async captureEventTeamRosterSnapshot(snapshot) {
      await db
        .insert(eventTeamRosterSnapshots)
        .values(eventTeamRosterSnapshotToRow(snapshot))
        .onConflictDoNothing()
        .execute();
      const saved = await db
        .select()
        .from(eventTeamRosterSnapshots)
        .where(
          and(
            eq(eventTeamRosterSnapshots.guildId, snapshot.guildId),
            eq(eventTeamRosterSnapshots.eventId, snapshot.eventId),
            eq(eventTeamRosterSnapshots.teamId, snapshot.teamId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return saved ? rowToEventTeamRosterSnapshot(saved) : snapshot;
    },

    async readEventTeamRosterSnapshot(guildId, eventId, teamId) {
      const row = await db
        .select()
        .from(eventTeamRosterSnapshots)
        .where(
          and(
            eq(eventTeamRosterSnapshots.guildId, guildId),
            eq(eventTeamRosterSnapshots.eventId, eventId),
            eq(eventTeamRosterSnapshots.teamId, teamId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToEventTeamRosterSnapshot(row) : null;
    },

    async listEventTeamRosterSnapshots(guildId, eventId) {
      const rows = await db
        .select()
        .from(eventTeamRosterSnapshots)
        .where(
          and(
            eq(eventTeamRosterSnapshots.guildId, guildId),
            eq(eventTeamRosterSnapshots.eventId, eventId),
          ),
        )
        .orderBy(asc(eventTeamRosterSnapshots.capturedAtMs))
        .execute();
      return rows.map(rowToEventTeamRosterSnapshot);
    },

    async enqueueEventTeamDelivery(record) {
      await deliveryInsert(record).execute();
      const saved = await db
        .select()
        .from(eventTeamDeliveryOutbox)
        .where(
          and(
            eq(eventTeamDeliveryOutbox.guildId, record.guildId),
            eq(eventTeamDeliveryOutbox.eventId, record.eventId),
            eq(eventTeamDeliveryOutbox.dedupeKey, record.dedupeKey),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return saved ? rowToEventTeamDelivery(saved) : record;
    },

    async listEventTeamDeliveries(input) {
      const conditions = [
        eq(eventTeamDeliveryOutbox.guildId, input.guildId),
        eq(eventTeamDeliveryOutbox.eventId, input.eventId),
      ];
      if (input.status) conditions.push(eq(eventTeamDeliveryOutbox.status, input.status));
      const rows = await db
        .select()
        .from(eventTeamDeliveryOutbox)
        .where(and(...conditions))
        .orderBy(desc(eventTeamDeliveryOutbox.createdAtMs))
        .limit(Math.max(1, Math.min(input.limit ?? 100, 500)))
        .execute();
      return rows.map(rowToEventTeamDelivery);
    },

    async listDueEventTeamDeliveries(input) {
      const conditions = [
        or(
          eq(eventTeamDeliveryOutbox.status, "pending"),
          eq(eventTeamDeliveryOutbox.status, "processing"),
        )!,
        lte(eventTeamDeliveryOutbox.nextAttemptAtMs, input.nowMs),
      ];
      if (input.guildId) conditions.push(eq(eventTeamDeliveryOutbox.guildId, input.guildId));
      if (input.eventId) conditions.push(eq(eventTeamDeliveryOutbox.eventId, input.eventId));
      const rows = await db
        .select()
        .from(eventTeamDeliveryOutbox)
        .where(and(...conditions))
        .orderBy(asc(eventTeamDeliveryOutbox.nextAttemptAtMs))
        .limit(Math.max(1, Math.min(input.limit ?? 100, 500)))
        .execute();
      return rows.map(rowToEventTeamDelivery);
    },

    async claimEventTeamDelivery(input) {
      const row = await db
        .update(eventTeamDeliveryOutbox)
        .set({
          status: "processing",
          nextAttemptAtMs: input.nowMs + input.leaseMs,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(eventTeamDeliveryOutbox.guildId, input.record.guildId),
            eq(eventTeamDeliveryOutbox.eventId, input.record.eventId),
            eq(eventTeamDeliveryOutbox.outboxId, input.record.id),
            or(
              eq(eventTeamDeliveryOutbox.status, "pending"),
              eq(eventTeamDeliveryOutbox.status, "processing"),
            ),
            lte(eventTeamDeliveryOutbox.nextAttemptAtMs, input.nowMs),
          ),
        )
        .returning()
        .then((rows) => rows[0]);
      return row ? rowToEventTeamDelivery(row) : null;
    },

    async updateEventTeamDelivery(record, expected) {
      const conditions = [
        eq(eventTeamDeliveryOutbox.guildId, record.guildId),
        eq(eventTeamDeliveryOutbox.eventId, record.eventId),
        eq(eventTeamDeliveryOutbox.outboxId, record.id),
      ];
      if (expected) {
        conditions.push(
          eq(eventTeamDeliveryOutbox.status, expected.status),
          eq(eventTeamDeliveryOutbox.updatedAtMs, expected.updatedAtMs),
          eq(eventTeamDeliveryOutbox.nextAttemptAtMs, expected.nextAttemptAtMs),
        );
      }
      await db
        .update(eventTeamDeliveryOutbox)
        .set(eventTeamDeliveryToRow(record))
        .where(and(...conditions))
        .execute();
    },

    async appendEventLifecycleHistory(record) {
      await db.insert(eventLifecycleHistory).values(eventLifecycleHistoryToRow(record)).execute();
    },

    async commitEventLifecycleTransition(input) {
      const values = eventToRow(input.event);
      const guardId = crypto.randomUUID();
      await executePostgresStatements(database, [
        db.insert(eventLifecycleTransitionGuards).values({
          guardId,
          guildId: input.event.guildId,
          eventId: input.event.id,
          expectedStatus: input.expectedStatus,
          expectedStateVersion: input.expectedStateVersion,
        }),
        db
          .insert(events)
          .values(values)
          .onConflictDoUpdate({ target: [events.guildId, events.eventId], set: values }),
        db.insert(eventLifecycleHistory).values(eventLifecycleHistoryToRow(input.history)),
        ...input.snapshots.map((snapshot) =>
          db
            .insert(eventTeamRosterSnapshots)
            .values(eventTeamRosterSnapshotToRow(snapshot))
            .onConflictDoNothing(),
        ),
        db
          .delete(eventLifecycleTransitionGuards)
          .where(eq(eventLifecycleTransitionGuards.guardId, guardId)),
      ] as never);
    },

    async listEventLifecycleHistory(guildId, eventId) {
      const rows = await db
        .select()
        .from(eventLifecycleHistory)
        .where(
          and(
            eq(eventLifecycleHistory.guildId, guildId),
            eq(eventLifecycleHistory.eventId, eventId),
          ),
        )
        .orderBy(asc(eventLifecycleHistory.occurredAtMs))
        .execute();
      return rows.map(rowToEventLifecycleHistory);
    },

    async pruneEventLifecycleHistory(nowMs, limit = 500) {
      const rows = await db
        .select({
          guildId: eventLifecycleHistory.guildId,
          eventId: eventLifecycleHistory.eventId,
          historyId: eventLifecycleHistory.historyId,
        })
        .from(eventLifecycleHistory)
        .where(lte(eventLifecycleHistory.retentionExpiresAtMs, nowMs))
        .limit(Math.max(1, Math.min(limit, 500)))
        .execute();
      if (rows.length === 0) return 0;
      await executePostgresStatements(
        database,
        rows.map((row) =>
          db
            .delete(eventLifecycleHistory)
            .where(
              and(
                eq(eventLifecycleHistory.guildId, row.guildId),
                eq(eventLifecycleHistory.eventId, row.eventId),
                eq(eventLifecycleHistory.historyId, row.historyId),
              ),
            ),
        ) as never,
      );
      return rows.length;
    },

    async deleteEventPermanently(input) {
      const predicates = (table: any) =>
        and(eq(table.guildId, input.guildId), eq(table.eventId, input.eventId));
      await executePostgresStatements(database, [
        db.delete(eventTeamAuditRecords).where(predicates(eventTeamAuditRecords)),
        db.delete(eventTeamRosterSnapshots).where(predicates(eventTeamRosterSnapshots)),
        db.delete(eventTeamDeliveryOutbox).where(predicates(eventTeamDeliveryOutbox)),
        db.delete(eventLifecycleHistory).where(predicates(eventLifecycleHistory)),
        db.delete(eventTeamInvitationBlocks).where(predicates(eventTeamInvitationBlocks)),
        db.delete(eventTeamProposals).where(predicates(eventTeamProposals)),
        db.delete(eventTeamMemberships).where(predicates(eventTeamMemberships)),
        db.delete(eventTeams).where(predicates(eventTeams)),
        db.delete(eventSignups).where(predicates(eventSignups)),
        db.delete(eventTeamStateVersions).where(predicates(eventTeamStateVersions)),
        db
          .delete(events)
          .where(and(eq(events.guildId, input.guildId), eq(events.eventId, input.eventId))),
      ] as never);
    },

    async commitEventTeamBulkFormation(input: EventTeamBulkCommitInput) {
      const stateVersion = await db
        .select({ version: eventTeamStateVersions.version })
        .from(eventTeamStateVersions)
        .where(
          and(
            eq(eventTeamStateVersions.guildId, input.preview.guildId),
            eq(eventTeamStateVersions.eventId, input.preview.eventId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      const [event, signups, existingTeams, memberships] = await Promise.all([
        this.readEvent(input.preview.guildId, input.preview.eventId),
        this.listSignups(input.preview.guildId, input.preview.eventId),
        this.listEventTeams(input.preview.guildId, input.preview.eventId),
        this.listActiveEventTeamMemberships(input.preview.guildId, input.preview.eventId),
      ]);
      if (!event || event.participationMode !== "team" || event.requiredTeamSize === null) {
        throw new Error("Bulk formation requires a Team Event.");
      }
      if (["ended", "cancelled", "archived"].includes(event.status)) {
        throw new Error("Bulk formation cannot change a terminal Event.");
      }
      if (
        !stateVersion ||
        bulkStateRevision(event, input.preview.groupId, signups, existingTeams, memberships) !==
          input.expectedRevision
      ) {
        throw new Error("Event Team bulk preview is stale.");
      }
      const existingNames = new Set(existingTeams.map((team) => team.normalizedName));
      const now = Date.now();
      const guardId = crypto.randomUUID();
      const statements: unknown[] = [
        db.insert(eventTeamBulkCommitGuards).values({
          guardId,
          guildId: input.preview.guildId,
          eventId: input.preview.eventId,
          expectedStateVersion: stateVersion.version,
        }),
      ];
      const createdTeams: EventTeam[] = [];
      const createdMemberships: EventTeamMembership[] = [];
      for (const proposal of input.preview.proposals) {
        let team = proposal.existingTeamId
          ? existingTeams.find((candidate) => candidate.id === proposal.existingTeamId)
          : undefined;
        if (!team) {
          const normalizedName = normalizeTeamNameForBulk(proposal.name);
          if (existingNames.has(normalizedName))
            throw new Error("Bulk formation team name conflict.");
          const teamId = `event-team-${now}-${Math.random().toString(36).slice(2, 8)}`;
          team = {
            guildId: input.preview.guildId,
            eventId: input.preview.eventId,
            id: teamId,
            groupId: proposal.groupId,
            name: proposal.name,
            normalizedName,
            captainUserId: proposal.captainUserId,
            openToRequests: false,
            status: "active",
            createdByUserId: input.actorUserId,
            createdAtMs: now,
            updatedAtMs: now,
            disbandedAtMs: null,
          };
          existingNames.add(normalizedName);
          createdTeams.push(team);
          statements.push(db.insert(eventTeams).values(teamToRow(team)));
        }
        for (const userId of proposal.addUserIds) {
          const membership: EventTeamMembership = {
            guildId: input.preview.guildId,
            eventId: input.preview.eventId,
            id: `event-team-membership-${now}-${Math.random().toString(36).slice(2, 8)}`,
            teamId: team.id,
            groupId: proposal.groupId,
            userId,
            joinedAtMs: now,
            leftAtMs: null,
          };
          createdMemberships.push(membership);
          statements.push(db.insert(eventTeamMemberships).values(membershipToRow(membership)));
        }
      }
      const audit: EventTeamAuditRecord = {
        guildId: input.preview.guildId,
        eventId: input.preview.eventId,
        id: crypto.randomUUID(),
        actorUserId: input.actorUserId,
        action: "bulk.committed",
        targetType: "admin",
        targetId: input.preview.groupId,
        prior: null,
        result: {
          revision: input.expectedRevision,
          proposalCount: input.preview.proposals.length,
          memberCount: createdMemberships.length,
        },
        occurredAtMs: now,
      };
      const refresh: EventTeamDeliveryOutboxRecord = {
        guildId: input.preview.guildId,
        eventId: input.preview.eventId,
        id: crypto.randomUUID(),
        kind: "canonical_refresh",
        dedupeKey: `canonical:${input.preview.eventId}`,
        payload: { revision: input.expectedRevision },
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
      statements.push(
        db.insert(eventTeamAuditRecords).values(eventTeamAuditToRow(audit)),
        deliveryInsert(refresh),
        incrementEventTeamStateVersion(input.preview.guildId, input.preview.eventId),
        db.delete(eventTeamBulkCommitGuards).where(eq(eventTeamBulkCommitGuards.guardId, guardId)),
      );
      await executePostgresStatements(database, statements as never);
      return {
        teams: createdTeams,
        memberships: createdMemberships,
        expectedRevision: input.expectedRevision,
      };
    },
  };

  return store;
}

function templateToRow(template: EventTemplate): typeof eventTemplates.$inferInsert {
  return {
    guildId: template.guildId,
    templateId: template.id,
    name: template.name,
    description: template.description,
    signupMode: template.signupMode,
    participationMode: template.participationMode,
    requiredTeamSize: template.requiredTeamSize,
    threadEnabled: template.threadEnabled ? 1 : 0,
    waitlistedMembersJoinThread: template.waitlistedMembersJoinThread ? 1 : 0,
    groupsJson: JSON.stringify(template.groups),
    remindersJson: JSON.stringify(template.reminders),
    createdAtMs: template.createdAtMs,
    updatedAtMs: template.updatedAtMs,
  };
}

function rowToTemplate(row: EventTemplateRow): EventTemplate {
  return {
    guildId: row.guildId,
    id: row.templateId,
    name: row.name,
    description: row.description,
    signupMode: row.signupMode as EventTemplate["signupMode"],
    participationMode: row.participationMode as EventTemplate["participationMode"],
    requiredTeamSize: row.requiredTeamSize,
    threadEnabled: row.threadEnabled === 1,
    waitlistedMembersJoinThread: row.waitlistedMembersJoinThread === 1,
    groups: parseJson<EventSignupGroup[]>(row.groupsJson, []),
    reminders: parseJson<EventReminder[]>(row.remindersJson, []),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function eventToRow(event: EventRecord): typeof events.$inferInsert {
  return {
    guildId: event.guildId,
    eventId: event.id,
    templateId: event.templateId,
    title: event.title,
    description: event.description,
    status: event.status,
    channelId: event.channelId,
    messageId: event.messageId,
    threadId: event.threadId,
    startsAtMs: event.startsAtMs,
    endsAtMs: event.endsAtMs,
    signupCutoffAtMs: event.signupCutoffAtMs,
    signupMode: event.signupMode,
    participationMode: event.participationMode,
    requiredTeamSize: event.requiredTeamSize,
    threadEnabled: event.threadEnabled ? 1 : 0,
    waitlistedMembersJoinThread: event.waitlistedMembersJoinThread ? 1 : 0,
    groupsJson: JSON.stringify(event.groups),
    remindersJson: JSON.stringify(event.reminders),
    createdAtMs: event.createdAtMs,
    updatedAtMs: event.updatedAtMs,
    publishedAtMs: event.publishedAtMs,
    cancelledAtMs: event.cancelledAtMs,
    endedAtMs: event.endedAtMs,
    archivedAtMs: event.archivedAtMs,
  };
}

function rowToEvent(row: EventRow): EventRecord {
  return {
    guildId: row.guildId,
    id: row.eventId,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    status: row.status as EventRecord["status"],
    channelId: row.channelId,
    messageId: row.messageId,
    threadId: row.threadId,
    startsAtMs: row.startsAtMs,
    endsAtMs: row.endsAtMs,
    signupCutoffAtMs: row.signupCutoffAtMs,
    signupMode: row.signupMode as EventRecord["signupMode"],
    participationMode: row.participationMode as EventRecord["participationMode"],
    requiredTeamSize: row.requiredTeamSize,
    threadEnabled: row.threadEnabled === 1,
    waitlistedMembersJoinThread: row.waitlistedMembersJoinThread === 1,
    groups: parseJson<EventSignupGroup[]>(row.groupsJson, []),
    reminders: parseJson<EventReminder[]>(row.remindersJson, []),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    publishedAtMs: row.publishedAtMs,
    cancelledAtMs: row.cancelledAtMs,
    endedAtMs: row.endedAtMs,
    archivedAtMs: row.archivedAtMs,
  };
}

function signupToRow(signup: EventSignup): typeof eventSignups.$inferInsert {
  return signup;
}

function rowToSignup(row: EventSignupRow): EventSignup {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    userId: row.userId,
    groupId: row.groupId,
    status: row.status as EventSignup["status"],
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function teamToRow(team: EventTeam): typeof eventTeams.$inferInsert {
  return {
    guildId: team.guildId,
    eventId: team.eventId,
    teamId: team.id,
    groupId: team.groupId,
    name: team.name,
    normalizedName: team.normalizedName,
    captainUserId: team.captainUserId,
    openToRequests: team.openToRequests ? 1 : 0,
    status: team.status,
    createdByUserId: team.createdByUserId,
    createdAtMs: team.createdAtMs,
    updatedAtMs: team.updatedAtMs,
    disbandedAtMs: team.disbandedAtMs,
  };
}

function rowToTeam(row: EventTeamRow): EventTeam {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    id: row.teamId,
    groupId: row.groupId,
    name: row.name,
    normalizedName: row.normalizedName,
    captainUserId: row.captainUserId,
    openToRequests: row.openToRequests === 1,
    status: row.status as EventTeam["status"],
    createdByUserId: row.createdByUserId,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    disbandedAtMs: row.disbandedAtMs,
  };
}

function membershipToRow(
  membership: EventTeamMembership,
): typeof eventTeamMemberships.$inferInsert {
  return {
    guildId: membership.guildId,
    eventId: membership.eventId,
    membershipId: membership.id,
    teamId: membership.teamId,
    groupId: membership.groupId,
    userId: membership.userId,
    joinedAtMs: membership.joinedAtMs,
    leftAtMs: membership.leftAtMs,
  };
}

function rowToMembership(row: EventTeamMembershipRow): EventTeamMembership {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    id: row.membershipId,
    teamId: row.teamId,
    groupId: row.groupId,
    userId: row.userId,
    joinedAtMs: row.joinedAtMs,
    leftAtMs: row.leftAtMs,
  };
}

function proposalToRow(proposal: EventTeamProposal): typeof eventTeamProposals.$inferInsert {
  return {
    guildId: proposal.guildId,
    eventId: proposal.eventId,
    proposalId: proposal.id,
    teamId: proposal.teamId,
    kind: proposal.kind,
    requesterUserId: proposal.requesterUserId,
    targetUserId: proposal.targetUserId,
    status: proposal.status,
    createdAtMs: proposal.createdAtMs,
    updatedAtMs: proposal.updatedAtMs,
    resolvedAtMs: proposal.resolvedAtMs,
  };
}

function rowToProposal(row: EventTeamProposalRow): EventTeamProposal {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    id: row.proposalId,
    teamId: row.teamId,
    kind: row.kind as EventTeamProposal["kind"],
    requesterUserId: row.requesterUserId,
    targetUserId: row.targetUserId,
    status: row.status as EventTeamProposal["status"],
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    resolvedAtMs: row.resolvedAtMs,
  };
}

function blockToRow(
  block: EventTeamInvitationBlock,
): typeof eventTeamInvitationBlocks.$inferInsert {
  return block;
}

function eventTeamAuditToRow(
  record: EventTeamAuditRecord,
): typeof eventTeamAuditRecords.$inferInsert {
  return {
    guildId: record.guildId,
    eventId: record.eventId,
    auditId: record.id,
    actorUserId: record.actorUserId,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    priorJson: JSON.stringify(record.prior ?? null),
    resultJson: JSON.stringify(record.result ?? null),
    occurredAtMs: record.occurredAtMs,
  };
}

function rowToEventTeamAudit(row: EventTeamAuditRow): EventTeamAuditRecord {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    id: row.auditId,
    actorUserId: row.actorUserId,
    action: row.action,
    targetType: row.targetType as EventTeamAuditRecord["targetType"],
    targetId: row.targetId,
    prior: parseJson(row.priorJson, null),
    result: parseJson(row.resultJson, null),
    occurredAtMs: row.occurredAtMs,
  };
}

function eventTeamRosterSnapshotToRow(
  snapshot: EventTeamRosterSnapshot,
): typeof eventTeamRosterSnapshots.$inferInsert {
  return {
    guildId: snapshot.guildId,
    eventId: snapshot.eventId,
    teamId: snapshot.teamId,
    requiredTeamSize: snapshot.requiredTeamSize,
    membersJson: JSON.stringify(snapshot.members),
    capturedAtMs: snapshot.capturedAtMs,
  };
}

function rowToEventTeamRosterSnapshot(row: EventTeamRosterSnapshotRow): EventTeamRosterSnapshot {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    teamId: row.teamId,
    requiredTeamSize: row.requiredTeamSize,
    members: parseJson(row.membersJson, []),
    capturedAtMs: row.capturedAtMs,
  };
}

function eventTeamDeliveryToRow(
  record: EventTeamDeliveryOutboxRecord,
): typeof eventTeamDeliveryOutbox.$inferInsert {
  return {
    guildId: record.guildId,
    eventId: record.eventId,
    outboxId: record.id,
    kind: record.kind,
    dedupeKey: record.dedupeKey,
    payloadJson: JSON.stringify(record.payload ?? null),
    status: record.status,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    lastError: record.lastError,
    terminalFailureReason: record.terminalFailureReason,
    nextAttemptAtMs: record.nextAttemptAtMs,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    deliveredAtMs: record.deliveredAtMs,
  };
}

function rowToEventTeamDelivery(row: EventTeamDeliveryOutboxRow): EventTeamDeliveryOutboxRecord {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    id: row.outboxId,
    kind: row.kind as EventTeamDeliveryOutboxRecord["kind"],
    dedupeKey: row.dedupeKey,
    payload: parseJson(row.payloadJson, null),
    status: row.status as EventTeamDeliveryOutboxRecord["status"],
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    terminalFailureReason: row.terminalFailureReason,
    nextAttemptAtMs: row.nextAttemptAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    deliveredAtMs: row.deliveredAtMs,
  };
}

function eventLifecycleHistoryToRow(
  record: EventLifecycleHistoryRecord,
): typeof eventLifecycleHistory.$inferInsert {
  return {
    guildId: record.guildId,
    eventId: record.eventId,
    historyId: record.id,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    occurredAtMs: record.occurredAtMs,
    retentionExpiresAtMs: record.retentionExpiresAtMs,
  };
}

function rowToEventLifecycleHistory(row: EventLifecycleHistoryRow): EventLifecycleHistoryRecord {
  return {
    guildId: row.guildId,
    eventId: row.eventId,
    id: row.historyId,
    fromStatus: row.fromStatus as EventLifecycleHistoryRecord["fromStatus"],
    toStatus: row.toStatus as EventLifecycleHistoryRecord["toStatus"],
    occurredAtMs: row.occurredAtMs,
    retentionExpiresAtMs: row.retentionExpiresAtMs,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTeamNameForBulk(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bulkStateRevision(
  event: EventRecord,
  groupId: string,
  signups: EventSignup[],
  teams: EventTeam[],
  memberships: EventTeamMembership[],
): string {
  return hashBulkState(
    stableSerializeBulk({
      event: {
        guildId: event.guildId,
        id: event.id,
        participationMode: event.participationMode,
        requiredTeamSize: event.requiredTeamSize,
        groups: event.groups,
      },
      groupId,
      signups: [...signups].sort(
        (a, b) =>
          a.createdAtMs - b.createdAtMs ||
          a.updatedAtMs - b.updatedAtMs ||
          a.userId.localeCompare(b.userId) ||
          a.groupId.localeCompare(b.groupId),
      ),
      teams: [...teams].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
      memberships: [...memberships].sort(
        (a, b) => a.joinedAtMs - b.joinedAtMs || a.id.localeCompare(b.id),
      ),
    }),
  );
}

function stableSerializeBulk(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerializeBulk).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerializeBulk(record[key])}`)
    .join(",")}}`;
}

function hashBulkState(value: string): string {
  let hash = 0xcbf29ce4;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
