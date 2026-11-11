import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import {
  clanApplications,
  clanChangeRequests,
  clanHistory,
  clanInvitations,
  clanManagementConfigs,
  clanMembershipBlocks,
  clanMemberships,
  clanOwnershipTransfers,
  clanRequests,
  clans,
} from "../db/app-schema";
import type {
  Clan,
  ClanApplication,
  ClanHistoryEvent,
  ClanInvitation,
  ClanManagementConfig,
  ClanMembership,
  ClanMembershipBlock,
  ClanOwnershipTransfer,
  ClanRequest,
} from "../../../../src/clans";
import type { ClanStore } from "../../../../src/runtime/contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

const clanStoreCache = new WeakMap<D1Database, ClanStore>();

export function createSqliteClanStore(database: D1Database): ClanStore {
  const cached = clanStoreCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);

  const store: ClanStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(clanManagementConfigs)
        .where(eq(clanManagementConfigs.guildId, guildId))
        .get();
      return row ? configFromRow(row) : null;
    },
    async upsertConfig(config) {
      const values = configToRow(config);
      await db
        .insert(clanManagementConfigs)
        .values(values)
        .onConflictDoUpdate({ target: clanManagementConfigs.guildId, set: values })
        .run();
    },
    async createRequest(request) {
      await db.insert(clanRequests).values(requestToRow(request)).run();
    },
    async readRequestById(requestId) {
      const row = await db.select().from(clanRequests).where(eq(clanRequests.id, requestId)).get();
      return row ? requestFromRow(row) : null;
    },
    async readRequest(guildId, requestId) {
      const row = await db
        .select()
        .from(clanRequests)
        .where(and(eq(clanRequests.guildId, guildId), eq(clanRequests.id, requestId)))
        .get();
      return row ? requestFromRow(row) : null;
    },
    async readPendingRequestByRequester(guildId, requesterId) {
      const row = await db
        .select()
        .from(clanRequests)
        .where(
          and(
            eq(clanRequests.guildId, guildId),
            eq(clanRequests.requesterId, requesterId),
            inArray(clanRequests.status, ["pending", "changes-requested"]),
          ),
        )
        .orderBy(desc(clanRequests.updatedAtMs))
        .get();
      return row ? requestFromRow(row) : null;
    },
    async readLatestTerminalRequest(guildId, requesterId) {
      const row = await db
        .select()
        .from(clanRequests)
        .where(
          and(
            eq(clanRequests.guildId, guildId),
            eq(clanRequests.requesterId, requesterId),
            inArray(clanRequests.status, ["rejected", "cancelled"]),
          ),
        )
        .orderBy(desc(clanRequests.terminalAtMs))
        .get();
      return row ? requestFromRow(row) : null;
    },
    async listRequests(guildId, status) {
      const rows = await db
        .select()
        .from(clanRequests)
        .where(
          status
            ? and(eq(clanRequests.guildId, guildId), eq(clanRequests.status, status))
            : eq(clanRequests.guildId, guildId),
        )
        .orderBy(desc(clanRequests.createdAtMs))
        .all();
      return rows.map(requestFromRow);
    },
    async listRequestReviewRecoveries(nowMs, limit) {
      const rows = await db
        .select()
        .from(clanRequests)
        .where(
          or(
            eq(clanRequests.reviewTicketState, "pending"),
            eq(clanRequests.reviewTicketState, "decision-pending"),
            and(
              eq(clanRequests.reviewTicketState, "creating"),
              lte(clanRequests.updatedAtMs, nowMs - 5 * 60 * 1000),
            ),
          ),
        )
        .orderBy(asc(clanRequests.updatedAtMs))
        .limit(boundedLimit(limit))
        .all();
      return rows.map(requestFromRow);
    },
    async updateRequest(request, expectedRevision) {
      const result = await db
        .update(clanRequests)
        .set(requestToRow(request))
        .where(
          and(
            eq(clanRequests.id, request.id),
            eq(clanRequests.guildId, request.guildId),
            eq(clanRequests.revision, expectedRevision),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },
    async claimRequestReviewTicket(guildId, requestId, revision, nowMs) {
      const result = await db
        .update(clanRequests)
        .set({ reviewTicketState: "creating", reviewTicketError: null, updatedAtMs: nowMs })
        .where(
          and(
            eq(clanRequests.guildId, guildId),
            eq(clanRequests.id, requestId),
            eq(clanRequests.revision, revision),
            or(
              eq(clanRequests.reviewTicketState, "pending"),
              and(
                eq(clanRequests.reviewTicketState, "creating"),
                lte(clanRequests.updatedAtMs, nowMs - 5 * 60 * 1000),
              ),
            ),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },
    async createClan(clan) {
      await db.insert(clans).values(clanToRow(clan)).run();
    },
    async updateClan(clan) {
      await db
        .update(clans)
        .set(clanToRow(clan))
        .where(and(eq(clans.guildId, clan.guildId), eq(clans.id, clan.id)))
        .run();
    },
    async readClan(guildId, clanId) {
      const row = await db
        .select()
        .from(clans)
        .where(and(eq(clans.guildId, guildId), eq(clans.id, clanId)))
        .get();
      return row ? clanFromRow(row) : null;
    },
    async readClanByRequest(requestId) {
      const row = await db.select().from(clans).where(eq(clans.requestId, requestId)).get();
      return row ? clanFromRow(row) : null;
    },
    async readClanByResource(guildId, resourceId) {
      const row = await db
        .select()
        .from(clans)
        .where(
          and(
            eq(clans.guildId, guildId),
            or(
              eq(clans.roleId, resourceId),
              eq(clans.textChannelId, resourceId),
              eq(clans.voiceChannelId, resourceId),
              eq(clans.boardProjectionId, resourceId),
            ),
          ),
        )
        .get();
      return row ? clanFromRow(row) : null;
    },
    async listClans(guildId) {
      return (
        await db
          .select()
          .from(clans)
          .where(eq(clans.guildId, guildId))
          .orderBy(asc(clans.createdAtMs))
          .all()
      ).map(clanFromRow);
    },
    async countCapacityConsumingClans(guildId) {
      const row = await db
        .select({ value: count() })
        .from(clans)
        .where(
          and(
            eq(clans.guildId, guildId),
            inArray(clans.lifecycleState, [
              "provisioning",
              "active",
              "degraded",
              "archived",
              "deletion-recovery",
            ]),
          ),
        )
        .get();
      return row?.value ?? 0;
    },
    async createMembership(membership) {
      await db.insert(clanMemberships).values(membershipToRow(membership)).run();
    },
    async updateMembership(membership) {
      await db
        .update(clanMemberships)
        .set(membershipToRow(membership))
        .where(
          and(
            eq(clanMemberships.clanId, membership.clanId),
            eq(clanMemberships.userId, membership.userId),
            eq(clanMemberships.joinedAtMs, membership.joinedAtMs),
          ),
        )
        .run();
    },
    async readActiveMembership(guildId, userId) {
      const row = await db
        .select()
        .from(clanMemberships)
        .where(
          and(
            eq(clanMemberships.guildId, guildId),
            eq(clanMemberships.userId, userId),
            isNull(clanMemberships.leftAtMs),
          ),
        )
        .get();
      return row ? (row as ClanMembership) : null;
    },
    async listActiveMemberships(clanId) {
      return (await db
        .select()
        .from(clanMemberships)
        .where(and(eq(clanMemberships.clanId, clanId), isNull(clanMemberships.leftAtMs)))
        .orderBy(asc(clanMemberships.joinedAtMs))
        .all()) as ClanMembership[];
    },
    async createApplication(application) {
      await db.insert(clanApplications).values(application).run();
    },
    async readApplication(guildId, applicationId) {
      const row = await db
        .select()
        .from(clanApplications)
        .where(and(eq(clanApplications.guildId, guildId), eq(clanApplications.id, applicationId)))
        .get();
      return (row as ClanApplication | undefined) ?? null;
    },
    async updateApplication(application) {
      await db
        .update(clanApplications)
        .set(application)
        .where(eq(clanApplications.id, application.id))
        .run();
    },
    async claimApplication(guildId, applicationId, nowMs) {
      const result = await db
        .update(clanApplications)
        .set({ status: "accepting", updatedAtMs: nowMs })
        .where(
          and(
            eq(clanApplications.guildId, guildId),
            eq(clanApplications.id, applicationId),
            eq(clanApplications.status, "pending"),
            gt(clanApplications.expiresAtMs, nowMs),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },
    async createInvitation(invitation) {
      await db.insert(clanInvitations).values(invitation).run();
    },
    async readInvitation(guildId, invitationId) {
      const row = await db
        .select()
        .from(clanInvitations)
        .where(and(eq(clanInvitations.guildId, guildId), eq(clanInvitations.id, invitationId)))
        .get();
      return (row as ClanInvitation | undefined) ?? null;
    },
    async updateInvitation(invitation) {
      await db
        .update(clanInvitations)
        .set(invitation)
        .where(eq(clanInvitations.id, invitation.id))
        .run();
    },
    async claimInvitation(guildId, invitationId, nowMs) {
      const result = await db
        .update(clanInvitations)
        .set({ status: "accepting", updatedAtMs: nowMs })
        .where(
          and(
            eq(clanInvitations.guildId, guildId),
            eq(clanInvitations.id, invitationId),
            eq(clanInvitations.status, "pending"),
            gt(clanInvitations.expiresAtMs, nowMs),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },
    async createMembershipBlock(block) {
      await db.insert(clanMembershipBlocks).values(block).run();
    },
    async readActiveMembershipBlock(clanId, userId, nowMs) {
      const row = await db
        .select()
        .from(clanMembershipBlocks)
        .where(
          and(
            eq(clanMembershipBlocks.clanId, clanId),
            eq(clanMembershipBlocks.userId, userId),
            isNull(clanMembershipBlocks.liftedAtMs),
            gte(clanMembershipBlocks.expiresAtMs, nowMs),
          ),
        )
        .orderBy(desc(clanMembershipBlocks.createdAtMs))
        .get();
      return (row as ClanMembershipBlock | undefined) ?? null;
    },
    async createOwnershipTransfer(transfer) {
      await db.insert(clanOwnershipTransfers).values(transfer).run();
    },
    async readOwnershipTransfer(guildId, transferId) {
      const row = await db
        .select()
        .from(clanOwnershipTransfers)
        .where(
          and(
            eq(clanOwnershipTransfers.guildId, guildId),
            eq(clanOwnershipTransfers.id, transferId),
          ),
        )
        .get();
      return (row as ClanOwnershipTransfer | undefined) ?? null;
    },
    async updateOwnershipTransfer(transfer) {
      await db
        .update(clanOwnershipTransfers)
        .set(transfer)
        .where(eq(clanOwnershipTransfers.id, transfer.id))
        .run();
    },
    async appendHistory(event) {
      await db.insert(clanHistory).values(event).run();
    },
    async listHistory(guildId, clanId, limit = 100) {
      return (await db
        .select()
        .from(clanHistory)
        .where(and(eq(clanHistory.guildId, guildId), eq(clanHistory.clanId, clanId)))
        .orderBy(desc(clanHistory.createdAtMs))
        .limit(Math.min(Math.max(limit, 1), 250))
        .all()) as ClanHistoryEvent[];
    },
    async listDueApplications(nowMs, limit) {
      return (await db
        .select()
        .from(clanApplications)
        .where(
          and(eq(clanApplications.status, "pending"), lte(clanApplications.expiresAtMs, nowMs)),
        )
        .orderBy(asc(clanApplications.expiresAtMs))
        .limit(boundedLimit(limit))
        .all()) as ClanApplication[];
    },
    async listDueInvitations(nowMs, limit) {
      return (await db
        .select()
        .from(clanInvitations)
        .where(and(eq(clanInvitations.status, "pending"), lte(clanInvitations.expiresAtMs, nowMs)))
        .orderBy(asc(clanInvitations.expiresAtMs))
        .limit(boundedLimit(limit))
        .all()) as ClanInvitation[];
    },
    async expireApplication(guildId, applicationId, nowMs) {
      const result = await db
        .update(clanApplications)
        .set({ status: "expired", updatedAtMs: nowMs })
        .where(
          and(
            eq(clanApplications.guildId, guildId),
            eq(clanApplications.id, applicationId),
            eq(clanApplications.status, "pending"),
            lte(clanApplications.expiresAtMs, nowMs),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },
    async expireInvitation(guildId, invitationId, nowMs) {
      const result = await db
        .update(clanInvitations)
        .set({ status: "expired", updatedAtMs: nowMs })
        .where(
          and(
            eq(clanInvitations.guildId, guildId),
            eq(clanInvitations.id, invitationId),
            eq(clanInvitations.status, "pending"),
            lte(clanInvitations.expiresAtMs, nowMs),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },
    async listScheduledClans(limit) {
      return (
        await db
          .select()
          .from(clans)
          .where(
            inArray(clans.lifecycleState, [
              "active",
              "degraded",
              "archived",
              "deletion-recovery",
              "plan-dormant",
            ]),
          )
          .orderBy(asc(clans.updatedAtMs), asc(clans.createdAtMs))
          .limit(boundedLimit(limit))
          .all()
      ).map(clanFromRow);
    },
    async listDueDeletionClans(nowMs, limit) {
      return (
        await db
          .select()
          .from(clans)
          .where(
            and(
              eq(clans.lifecycleState, "deletion-recovery"),
              isNotNull(clans.deletionDueAtMs),
              lte(clans.deletionDueAtMs, nowMs),
            ),
          )
          .orderBy(asc(clans.deletionDueAtMs))
          .limit(boundedLimit(limit))
          .all()
      ).map(clanFromRow);
    },
    async purgeExpiredHistory(nowMs, limit) {
      const rows = await db
        .select({ id: clanHistory.id })
        .from(clanHistory)
        .where(lte(clanHistory.retentionExpiresAtMs, nowMs))
        .limit(Math.min(Math.max(limit, 1), 500))
        .all();
      if (rows.length === 0) return 0;
      await db
        .delete(clanHistory)
        .where(
          inArray(
            clanHistory.id,
            rows.map((row) => row.id),
          ),
        )
        .run();
      return rows.length;
    },
    async purgeExpiredWorkflowRecords(nowMs, limit) {
      const max = boundedLimit(limit);
      const requestRows = await db
        .select({ id: clanRequests.id })
        .from(clanRequests)
        .where(
          and(
            inArray(clanRequests.status, ["rejected", "cancelled"]),
            isNotNull(clanRequests.retentionExpiresAtMs),
            lte(clanRequests.retentionExpiresAtMs, nowMs),
          ),
        )
        .limit(max)
        .all();
      const changeRows = await db
        .select({ id: clanChangeRequests.id })
        .from(clanChangeRequests)
        .where(
          and(
            isNotNull(clanChangeRequests.retentionExpiresAtMs),
            lte(clanChangeRequests.retentionExpiresAtMs, nowMs),
          ),
        )
        .limit(Math.max(0, max - requestRows.length))
        .all();
      const remaining = Math.max(0, max - requestRows.length - changeRows.length);
      const cutoffMs = nowMs - 365 * 24 * 60 * 60 * 1000;
      const applicationRows = remaining
        ? await db
            .select({ id: clanApplications.id })
            .from(clanApplications)
            .where(
              and(
                inArray(clanApplications.status, ["accepted", "rejected", "expired", "cancelled"]),
                lte(clanApplications.updatedAtMs, cutoffMs),
              ),
            )
            .limit(remaining)
            .all()
        : [];
      const invitationRows =
        remaining > applicationRows.length
          ? await db
              .select({ id: clanInvitations.id })
              .from(clanInvitations)
              .where(
                and(
                  inArray(clanInvitations.status, ["accepted", "rejected", "expired", "cancelled"]),
                  lte(clanInvitations.updatedAtMs, cutoffMs),
                ),
              )
              .limit(remaining - applicationRows.length)
              .all()
          : [];
      if (invitationRows.length)
        await db
          .delete(clanInvitations)
          .where(
            inArray(
              clanInvitations.id,
              invitationRows.map((row) => row.id),
            ),
          )
          .run();
      if (applicationRows.length)
        await db
          .delete(clanApplications)
          .where(
            inArray(
              clanApplications.id,
              applicationRows.map((row) => row.id),
            ),
          )
          .run();
      if (changeRows.length)
        await db
          .delete(clanChangeRequests)
          .where(
            inArray(
              clanChangeRequests.id,
              changeRows.map((row) => row.id),
            ),
          )
          .run();
      if (requestRows.length)
        await db
          .delete(clanRequests)
          .where(
            inArray(
              clanRequests.id,
              requestRows.map((row) => row.id),
            ),
          )
          .run();
      return (
        requestRows.length + changeRows.length + applicationRows.length + invitationRows.length
      );
    },
  };
  clanStoreCache.set(database, store);
  return store;
}

function boundedLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), 500);
}

type ConfigRow = typeof clanManagementConfigs.$inferSelect;
function parseIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
function configFromRow(row: ConfigRow): ClanManagementConfig {
  const {
    reviewerRoleIdsJson,
    staffAccessRoleIdsJson,
    eligibilityAllowedRoleIdsJson,
    eligibilityRequiredRoleIdsJson,
    ...rest
  } = row;
  return {
    ...rest,
    reviewerRoleIds: parseIds(reviewerRoleIdsJson),
    staffAccessRoleIds: parseIds(staffAccessRoleIdsJson),
    eligibilityAllowedRoleIds: parseIds(eligibilityAllowedRoleIdsJson),
    eligibilityRequiredRoleIds: parseIds(eligibilityRequiredRoleIdsJson),
    boardChannelType: row.boardChannelType as ClanManagementConfig["boardChannelType"],
  };
}
function configToRow(config: ClanManagementConfig): typeof clanManagementConfigs.$inferInsert {
  const {
    reviewerRoleIds,
    staffAccessRoleIds,
    eligibilityAllowedRoleIds,
    eligibilityRequiredRoleIds,
    ...rest
  } = config;
  return {
    ...rest,
    reviewerRoleIdsJson: JSON.stringify(reviewerRoleIds),
    staffAccessRoleIdsJson: JSON.stringify(staffAccessRoleIds),
    eligibilityAllowedRoleIdsJson: JSON.stringify(eligibilityAllowedRoleIds),
    eligibilityRequiredRoleIdsJson: JSON.stringify(eligibilityRequiredRoleIds),
  };
}
function requestFromRow(row: typeof clanRequests.$inferSelect): ClanRequest {
  const { proposedOfficerIdsJson, ...rest } = row;
  return {
    ...rest,
    recruitmentState: row.recruitmentState as ClanRequest["recruitmentState"],
    status: row.status as ClanRequest["status"],
    reviewTicketState: row.reviewTicketState as ClanRequest["reviewTicketState"],
    proposedOfficerIds: parseIds(proposedOfficerIdsJson),
  };
}
function requestToRow(request: ClanRequest): typeof clanRequests.$inferInsert {
  const { proposedOfficerIds, ...rest } = request;
  return { ...rest, proposedOfficerIdsJson: JSON.stringify(proposedOfficerIds) };
}
function clanFromRow(row: typeof clans.$inferSelect): Clan {
  return {
    ...row,
    recruitmentState: row.recruitmentState as Clan["recruitmentState"],
    lifecycleState: row.lifecycleState as Clan["lifecycleState"],
    latestActivityType: row.latestActivityType as Clan["latestActivityType"],
  };
}
function clanToRow(clan: Clan): typeof clans.$inferInsert {
  return clan;
}
function membershipToRow(membership: ClanMembership): typeof clanMemberships.$inferInsert {
  return membership;
}
