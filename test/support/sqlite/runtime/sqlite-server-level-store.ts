import { and, asc, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import {
  serverLevelAwards,
  serverLevelAnnouncementOutbox,
  serverLevelConfigs,
  serverLevelCurrentPresence,
  serverLevelEarningSessions,
  serverLevelIngressOutbox,
  serverLevelMemberTotals,
  serverLevelProcessingCursors,
  serverLevelServers,
  serverLevelWebhookInbox,
} from "../db/app-schema";
import {
  isServerLevelProviderEventType,
  isServerLevelWebhookEventType,
  type ConfiguredGameServer,
  type ServerLevelAward,
  type ServerLevelCapacityProposal,
  type ServerLevelConfig,
  type ServerLevelProviderEvent,
} from "../../../../src/server-levels/model";
import { createD1DrizzleDatabase } from "./drizzle-db";
import type { ServerLevelStore } from "../../../../src/runtime/contracts/server-level-store";
import { isRecord } from "../../../../src/unknown-parse";

type ConfigRow = typeof serverLevelConfigs.$inferSelect;
type ServerRow = typeof serverLevelServers.$inferSelect;
type InboxRow = typeof serverLevelWebhookInbox.$inferSelect;
type SessionRow = typeof serverLevelEarningSessions.$inferSelect;
type AwardRow = typeof serverLevelAwards.$inferSelect;

const MAX_CONFIGURED_GAME_SERVERS = 5;
const MAX_LEADERBOARD_ENTRIES = 100;

const storeCache = new WeakMap<D1Database, ServerLevelStore>();

export function createSqliteServerLevelStore(database: D1Database): ServerLevelStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);

  const store: ServerLevelStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(serverLevelConfigs)
        .where(eq(serverLevelConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? configFromRow(row) : null;
    },

    async upsertConfig(config) {
      validateConfig(config);
      await db
        .insert(serverLevelConfigs)
        .values({
          guildId: config.guildId,
          enabled: config.enabled,
          announcementChannelId: config.announcementChannelId,
          removedAtMs: config.removedAtMs,
          updatedAtMs: config.updatedAtMs,
        })
        .onConflictDoUpdate({
          target: serverLevelConfigs.guildId,
          set: {
            enabled: config.enabled,
            announcementChannelId: config.announcementChannelId,
            removedAtMs: config.removedAtMs,
            updatedAtMs: config.updatedAtMs,
          },
        })
        .run();
    },

    async createConfiguredGameServer(server) {
      validateServer(server);
      const existing = await db
        .select({ id: serverLevelServers.id })
        .from(serverLevelServers)
        .where(eq(serverLevelServers.guildId, server.guildId))
        .limit(MAX_CONFIGURED_GAME_SERVERS)
        .all();
      if (existing.length >= MAX_CONFIGURED_GAME_SERVERS) {
        throw new Error("A Guild may configure at most five Configured Game Servers.");
      }
      await db.insert(serverLevelServers).values(serverToRow(server)).run();
    },

    async updateConfiguredGameServer(server) {
      validateServer(server);
      const values = serverToRow(server);
      const result = await db
        .update(serverLevelServers)
        .set({
          displayName: values.displayName,
          providerServerId: values.providerServerId,
          maxSlots: values.maxSlots,
          endpointId: values.endpointId,
          webhookCredentialId: values.webhookCredentialId,
          webhookVerifiedAtMs: values.webhookVerifiedAtMs,
          subscribedEventsJson: values.subscribedEventsJson,
          capacityProposalJson: values.capacityProposalJson,
          lastRosterReconciledAtMs: values.lastRosterReconciledAtMs,
          lastCapacityCheckedAtMs: values.lastCapacityCheckedAtMs,
          updatedAtMs: values.updatedAtMs,
        })
        .where(
          and(eq(serverLevelServers.id, server.id), eq(serverLevelServers.guildId, server.guildId)),
        )
        .run();
      if (result.meta.changes === 0) throw new Error("Configured Game Server not found.");
    },

    async replaceConfiguredGameServerProvider(server, changedAtMs) {
      validateServer(server);
      safeTimestamp(changedAtMs, "provider server change timestamp");
      const values = serverToRow(server);
      const results = await database.batch([
        database
          .prepare(
            `UPDATE server_level_servers SET
               display_name = ?, provider_server_id = ?, max_slots = ?, endpoint_id = ?,
               webhook_credential_id = ?, webhook_verified_at_ms = ?, subscribed_events_json = ?,
               capacity_proposal_json = ?, last_roster_reconciled_at_ms = ?,
               last_capacity_checked_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND guild_id = ?`,
          )
          .bind(
            values.displayName,
            values.providerServerId,
            values.maxSlots,
            values.endpointId,
            values.webhookCredentialId,
            values.webhookVerifiedAtMs,
            values.subscribedEventsJson,
            values.capacityProposalJson,
            values.lastRosterReconciledAtMs,
            values.lastCapacityCheckedAtMs,
            values.updatedAtMs,
            server.id,
            server.guildId,
          ),
        database
          .prepare(
            `DELETE FROM server_level_ingress_outbox
             WHERE inbox_id IN (
               SELECT inbox_id FROM server_level_webhook_inbox
               WHERE configured_game_server_id = ? AND status = 'accepted'
             )`,
          )
          .bind(server.id),
        database
          .prepare(
            `UPDATE server_level_webhook_inbox
             SET status = 'rejected', reason_code = 'provider_server_changed', processed_at_ms = ?
             WHERE configured_game_server_id = ? AND status = 'accepted'`,
          )
          .bind(changedAtMs, server.id),
        database
          .prepare(
            "DELETE FROM server_level_processing_cursors WHERE configured_game_server_id = ?",
          )
          .bind(server.id),
        database
          .prepare("DELETE FROM server_level_current_presence WHERE configured_game_server_id = ?")
          .bind(server.id),
        database
          .prepare(
            `UPDATE server_level_earning_sessions
             SET closed_at_ms = ?, close_reason = 'provider_server_changed',
                 checkpoint_at_ms = ?, updated_at_ms = ?
             WHERE configured_game_server_id = ? AND closed_at_ms IS NULL`,
          )
          .bind(changedAtMs, changedAtMs, changedAtMs, server.id),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        throw new Error("Configured Game Server not found.");
      }
    },

    async deleteConfiguredGameServer(guildId, serverId) {
      const server = await db
        .select({ id: serverLevelServers.id })
        .from(serverLevelServers)
        .where(and(eq(serverLevelServers.guildId, guildId), eq(serverLevelServers.id, serverId)))
        .limit(1)
        .get();
      if (!server) return;
      await database.batch([
        database
          .prepare(
            "DELETE FROM server_level_ingress_outbox WHERE inbox_id IN (SELECT inbox_id FROM server_level_webhook_inbox WHERE configured_game_server_id = ?)",
          )
          .bind(serverId),
        database
          .prepare("DELETE FROM server_level_webhook_inbox WHERE configured_game_server_id = ?")
          .bind(serverId),
        database
          .prepare(
            "DELETE FROM server_level_processing_cursors WHERE configured_game_server_id = ?",
          )
          .bind(serverId),
        database
          .prepare("DELETE FROM server_level_processing_leases WHERE configured_game_server_id = ?")
          .bind(serverId),
        database
          .prepare("DELETE FROM server_level_current_presence WHERE configured_game_server_id = ?")
          .bind(serverId),
        database
          .prepare("DELETE FROM server_level_earning_sessions WHERE configured_game_server_id = ?")
          .bind(serverId),
        database
          .prepare("DELETE FROM server_level_credentials WHERE configured_game_server_id = ?")
          .bind(serverId),
        database
          .prepare("DELETE FROM server_level_servers WHERE guild_id = ? AND id = ?")
          .bind(guildId, serverId),
      ]);
    },

    async listConfiguredGameServers(guildId) {
      const rows = await db
        .select()
        .from(serverLevelServers)
        .where(eq(serverLevelServers.guildId, guildId))
        .orderBy(asc(serverLevelServers.createdAtMs), asc(serverLevelServers.id))
        .all();
      return rows.map(serverFromRow);
    },

    async readConfiguredGameServer(guildId, serverId) {
      const row = await db
        .select()
        .from(serverLevelServers)
        .where(and(eq(serverLevelServers.guildId, guildId), eq(serverLevelServers.id, serverId)))
        .limit(1)
        .get();
      return row ? serverFromRow(row) : null;
    },

    async readConfiguredGameServerById(serverId) {
      const row = await db
        .select()
        .from(serverLevelServers)
        .where(eq(serverLevelServers.id, serverId))
        .limit(1)
        .get();
      return row ? serverFromRow(row) : null;
    },

    async readConfiguredGameServerByEndpoint(endpointId) {
      const row = await db
        .select()
        .from(serverLevelServers)
        .where(eq(serverLevelServers.endpointId, endpointId))
        .limit(1)
        .get();
      return row ? serverFromRow(row) : null;
    },

    async listAllConfiguredGameServers(limit, after) {
      let query = db.select().from(serverLevelServers).$dynamic();
      if (after) {
        query = query.where(
          or(
            gt(serverLevelServers.guildId, after.guildId),
            and(
              eq(serverLevelServers.guildId, after.guildId),
              or(
                gt(serverLevelServers.createdAtMs, after.createdAtMs),
                and(
                  eq(serverLevelServers.createdAtMs, after.createdAtMs),
                  gt(serverLevelServers.id, after.id),
                ),
              ),
            ),
          ),
        );
      }
      const rows = await query
        .orderBy(
          asc(serverLevelServers.guildId),
          asc(serverLevelServers.createdAtMs),
          asc(serverLevelServers.id),
        )
        .limit(boundedPositiveInteger(limit, 1, 500))
        .all();
      return rows.map(serverFromRow);
    },

    async recordReconciliationState(guildId, serverId, state) {
      safeTimestamp(state.rosterAtMs, "roster reconciliation timestamp");
      if (state.capacityCheckedAtMs !== undefined) {
        safeTimestamp(state.capacityCheckedAtMs, "capacity check timestamp");
      }
      if (state.capacityProposal) {
        boundedPositiveInteger(state.capacityProposal.maxSlots, 1, 10_000);
        safeTimestamp(state.capacityProposal.observedAtMs, "capacity observation timestamp");
      }
      const values: Partial<typeof serverLevelServers.$inferInsert> = {
        lastRosterReconciledAtMs: state.rosterAtMs,
        updatedAtMs: state.rosterAtMs,
      };
      if (state.capacityCheckedAtMs !== undefined) {
        values.lastCapacityCheckedAtMs = state.capacityCheckedAtMs;
        values.capacityProposalJson = state.capacityProposal
          ? JSON.stringify(state.capacityProposal)
          : null;
      }
      const result = await db
        .update(serverLevelServers)
        .set(values)
        .where(and(eq(serverLevelServers.guildId, guildId), eq(serverLevelServers.id, serverId)))
        .run();
      if (result.meta.changes === 0) throw new Error("Configured Game Server not found.");
    },

    async acceptProviderEvent(event) {
      validateProviderEvent(event);
      const results = await database.batch([
        database
          .prepare(
            `INSERT OR IGNORE INTO server_level_webhook_inbox
              (inbox_id, delivery_id, configured_game_server_id, guild_id, event_type,
               occurred_at_ms, steam_id64, population, queue_size, status, reason_code,
               received_at_ms, body_sha256, processed_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, ?, NULL)`,
          )
          .bind(
            event.inboxId,
            event.deliveryId,
            event.configuredGameServerId,
            event.guildId,
            event.eventType,
            event.occurredAtMs,
            event.steamId64,
            event.population,
            event.queueSize,
            event.receivedAtMs,
            event.bodySha256 ?? null,
          ),
        database
          .prepare(
            `INSERT OR IGNORE INTO server_level_ingress_outbox
              (inbox_id, guild_id, created_at_ms, published_at_ms)
             SELECT ?, ?, ?, NULL WHERE changes() = 1`,
          )
          .bind(event.inboxId, event.guildId, event.receivedAtMs),
      ]);
      if ((results[0]?.meta.changes ?? 0) > 0) {
        return { accepted: true, inboxId: event.inboxId, duplicateBodyMatches: true };
      }
      const existing = await db
        .select({
          inboxId: serverLevelWebhookInbox.inboxId,
          bodySha256: serverLevelWebhookInbox.bodySha256,
        })
        .from(serverLevelWebhookInbox)
        .where(
          and(
            eq(serverLevelWebhookInbox.configuredGameServerId, event.configuredGameServerId),
            eq(serverLevelWebhookInbox.deliveryId, event.deliveryId),
          ),
        )
        .limit(1)
        .get();
      if (!existing)
        throw new Error("Server Levels provider event conflict could not be resolved.");
      return {
        accepted: false,
        inboxId: existing.inboxId,
        duplicateBodyMatches:
          event.bodySha256 === undefined || existing.bodySha256 === event.bodySha256,
      };
    },

    async readProviderEvent(inboxId) {
      const row = await db
        .select()
        .from(serverLevelWebhookInbox)
        .where(eq(serverLevelWebhookInbox.inboxId, inboxId))
        .limit(1)
        .get();
      return row ? eventFromRow(row) : null;
    },

    async listPendingIngressOutbox(limit) {
      const boundedLimit = boundedPositiveInteger(limit, 1, 100);
      return db
        .select({
          inboxId: serverLevelIngressOutbox.inboxId,
          guildId: serverLevelIngressOutbox.guildId,
          createdAtMs: serverLevelIngressOutbox.createdAtMs,
        })
        .from(serverLevelIngressOutbox)
        .where(isNull(serverLevelIngressOutbox.publishedAtMs))
        .orderBy(asc(serverLevelIngressOutbox.createdAtMs), asc(serverLevelIngressOutbox.inboxId))
        .limit(boundedLimit)
        .all();
    },

    async markIngressPublished(inboxId, publishedAtMs) {
      await db
        .update(serverLevelIngressOutbox)
        .set({ publishedAtMs })
        .where(eq(serverLevelIngressOutbox.inboxId, inboxId))
        .run();
    },

    async markProviderEventProcessed(inboxId, status, reasonCode, processedAtMs) {
      await db
        .update(serverLevelWebhookInbox)
        .set({ status, reasonCode, processedAtMs })
        .where(eq(serverLevelWebhookInbox.inboxId, inboxId))
        .run();
    },

    async readProfile(guildId, userId) {
      const row = await db
        .select()
        .from(serverLevelMemberTotals)
        .where(
          and(
            eq(serverLevelMemberTotals.guildId, guildId),
            eq(serverLevelMemberTotals.userId, userId),
          ),
        )
        .limit(1)
        .get();
      return row
        ? {
            guildId: row.guildId,
            userId: row.userId,
            totalXpUnits: row.totalXpUnits,
            updatedAtMs: row.updatedAtMs,
          }
        : null;
    },

    async listLeaderboard(guildId, limit, after) {
      const base = and(
        eq(serverLevelMemberTotals.guildId, guildId),
        eq(serverLevelMemberTotals.currentMember, true),
      );
      const rows = await db
        .select()
        .from(serverLevelMemberTotals)
        .where(
          after
            ? and(
                base,
                or(
                  lt(serverLevelMemberTotals.totalXpUnits, after.totalXpUnits),
                  and(
                    eq(serverLevelMemberTotals.totalXpUnits, after.totalXpUnits),
                    gt(serverLevelMemberTotals.userId, after.userId),
                  ),
                ),
              )
            : base,
        )
        .orderBy(desc(serverLevelMemberTotals.totalXpUnits), asc(serverLevelMemberTotals.userId))
        .limit(boundedPositiveInteger(limit, 1, MAX_LEADERBOARD_ENTRIES))
        .all();
      return rows.map((row) => ({
        guildId: row.guildId,
        userId: row.userId,
        totalXpUnits: row.totalXpUnits,
        updatedAtMs: row.updatedAtMs,
      }));
    },

    async listAcceptedProviderEvents(configuredGameServerId, safeThroughMs) {
      const rows = await db
        .select()
        .from(serverLevelWebhookInbox)
        .where(
          and(
            eq(serverLevelWebhookInbox.configuredGameServerId, configuredGameServerId),
            eq(serverLevelWebhookInbox.status, "accepted"),
            lte(serverLevelWebhookInbox.occurredAtMs, safeThroughMs),
            lte(serverLevelWebhookInbox.receivedAtMs, safeThroughMs),
          ),
        )
        .orderBy(asc(serverLevelWebhookInbox.occurredAtMs), asc(serverLevelWebhookInbox.deliveryId))
        .all();
      return rows.map(eventFromRow);
    },

    async readEarliestAcceptedProviderEvent(configuredGameServerId) {
      const row = await db
        .select()
        .from(serverLevelWebhookInbox)
        .where(
          and(
            eq(serverLevelWebhookInbox.configuredGameServerId, configuredGameServerId),
            eq(serverLevelWebhookInbox.status, "accepted"),
          ),
        )
        .orderBy(asc(serverLevelWebhookInbox.occurredAtMs), asc(serverLevelWebhookInbox.deliveryId))
        .limit(1)
        .get();
      return row ? eventFromRow(row) : null;
    },

    async acquireProcessingLease(configuredGameServerId, leaseId, nowMs, expiresAtMs) {
      const result = await database
        .prepare(
          `INSERT INTO server_level_processing_leases
            (configured_game_server_id, lease_id, expires_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(configured_game_server_id) DO UPDATE SET
             lease_id = excluded.lease_id,
             expires_at_ms = excluded.expires_at_ms
           WHERE server_level_processing_leases.expires_at_ms <= ?`,
        )
        .bind(configuredGameServerId, leaseId, expiresAtMs, nowMs)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async releaseProcessingLease(configuredGameServerId, leaseId) {
      await database
        .prepare(
          `DELETE FROM server_level_processing_leases
           WHERE configured_game_server_id = ? AND lease_id = ?`,
        )
        .bind(configuredGameServerId, leaseId)
        .run();
    },

    async readProcessingCursor(configuredGameServerId) {
      const row = await db
        .select()
        .from(serverLevelProcessingCursors)
        .where(eq(serverLevelProcessingCursors.configuredGameServerId, configuredGameServerId))
        .limit(1)
        .get();
      return row ? { ...row } : null;
    },

    async upsertProcessingCursor(cursor) {
      await db
        .insert(serverLevelProcessingCursors)
        .values(cursor)
        .onConflictDoUpdate({
          target: serverLevelProcessingCursors.configuredGameServerId,
          set: {
            latestSeenAtMs: cursor.latestSeenAtMs,
            watermarkAtMs: cursor.watermarkAtMs,
            lastDeliveryId: cursor.lastDeliveryId,
            population: cursor.population,
            queueSize: cursor.queueSize,
            lifecycleGeneration: cursor.lifecycleGeneration,
            updatedAtMs: cursor.updatedAtMs,
          },
        })
        .run();
    },

    async listCurrentPresence(configuredGameServerId) {
      return db
        .select()
        .from(serverLevelCurrentPresence)
        .where(eq(serverLevelCurrentPresence.configuredGameServerId, configuredGameServerId))
        .orderBy(
          asc(serverLevelCurrentPresence.joinedAtMs),
          asc(serverLevelCurrentPresence.steamId64),
        )
        .all();
    },

    async readCurrentPresence(configuredGameServerId, steamId64) {
      return (
        (await db
          .select()
          .from(serverLevelCurrentPresence)
          .where(
            and(
              eq(serverLevelCurrentPresence.configuredGameServerId, configuredGameServerId),
              eq(serverLevelCurrentPresence.steamId64, steamId64),
            ),
          )
          .limit(1)
          .get()) ?? null
      );
    },

    async upsertCurrentPresence(presence) {
      await db
        .insert(serverLevelCurrentPresence)
        .values(presence)
        .onConflictDoUpdate({
          target: [
            serverLevelCurrentPresence.configuredGameServerId,
            serverLevelCurrentPresence.steamId64,
          ],
          set: {
            lifecycleGeneration: presence.lifecycleGeneration,
            joinedAtMs: presence.joinedAtMs,
            lastConfirmedAtMs: presence.lastConfirmedAtMs,
            updatedAtMs: presence.updatedAtMs,
          },
        })
        .run();
    },

    async deleteCurrentPresence(guildId, configuredGameServerId, steamId64) {
      const ownedServer = await db
        .select({ id: serverLevelServers.id })
        .from(serverLevelServers)
        .where(
          and(
            eq(serverLevelServers.id, configuredGameServerId),
            eq(serverLevelServers.guildId, guildId),
          ),
        )
        .limit(1)
        .get();
      if (!ownedServer) return;
      await db
        .delete(serverLevelCurrentPresence)
        .where(
          and(
            eq(serverLevelCurrentPresence.configuredGameServerId, configuredGameServerId),
            eq(serverLevelCurrentPresence.steamId64, steamId64),
          ),
        )
        .run();
    },

    async clearCurrentPresence(guildId, configuredGameServerId) {
      const ownedServer = await db
        .select({ id: serverLevelServers.id })
        .from(serverLevelServers)
        .where(
          and(
            eq(serverLevelServers.id, configuredGameServerId),
            eq(serverLevelServers.guildId, guildId),
          ),
        )
        .limit(1)
        .get();
      if (!ownedServer) return;
      await db
        .delete(serverLevelCurrentPresence)
        .where(eq(serverLevelCurrentPresence.configuredGameServerId, configuredGameServerId))
        .run();
    },

    async listOpenEarningSessions(configuredGameServerId) {
      const rows = await db
        .select()
        .from(serverLevelEarningSessions)
        .where(
          and(
            eq(serverLevelEarningSessions.configuredGameServerId, configuredGameServerId),
            isNull(serverLevelEarningSessions.closedAtMs),
          ),
        )
        .orderBy(
          asc(serverLevelEarningSessions.startedAtMs),
          asc(serverLevelEarningSessions.sessionId),
        )
        .all();
      return rows.map(sessionFromRow);
    },

    async readOpenEarningSession(configuredGameServerId, steamId64) {
      const row = await db
        .select()
        .from(serverLevelEarningSessions)
        .where(
          and(
            eq(serverLevelEarningSessions.configuredGameServerId, configuredGameServerId),
            eq(serverLevelEarningSessions.steamId64, steamId64),
            isNull(serverLevelEarningSessions.closedAtMs),
          ),
        )
        .orderBy(desc(serverLevelEarningSessions.startedAtMs))
        .limit(1)
        .get();
      return row ? sessionFromRow(row) : null;
    },

    async upsertEarningSession(session) {
      await db
        .insert(serverLevelEarningSessions)
        .values(session)
        .onConflictDoUpdate({
          target: serverLevelEarningSessions.sessionId,
          set: {
            lastConfirmedAtMs: session.lastConfirmedAtMs,
            checkpointAtMs: session.checkpointAtMs,
            closedAtMs: session.closedAtMs,
            closeReason: session.closeReason,
            updatedAtMs: session.updatedAtMs,
          },
        })
        .run();
    },

    async closeEarningSession(sessionId, closedAtMs, closeReason) {
      await db
        .update(serverLevelEarningSessions)
        .set({ closedAtMs, closeReason, checkpointAtMs: closedAtMs, updatedAtMs: closedAtMs })
        .where(
          and(
            eq(serverLevelEarningSessions.sessionId, sessionId),
            isNull(serverLevelEarningSessions.closedAtMs),
          ),
        )
        .run();
    },

    async closeAllEarningSessions(configuredGameServerId, closedAtMs, closeReason) {
      await db
        .update(serverLevelEarningSessions)
        .set({ closedAtMs, closeReason, checkpointAtMs: closedAtMs, updatedAtMs: closedAtMs })
        .where(
          and(
            eq(serverLevelEarningSessions.configuredGameServerId, configuredGameServerId),
            isNull(serverLevelEarningSessions.closedAtMs),
          ),
        )
        .run();
    },

    async listMemberAwards(guildId, userId, startedBeforeMs, endedAfterMs) {
      const rows = await db
        .select()
        .from(serverLevelAwards)
        .where(
          and(
            eq(serverLevelAwards.guildId, guildId),
            eq(serverLevelAwards.userId, userId),
            lt(serverLevelAwards.intervalStartedAtMs, startedBeforeMs),
            gt(serverLevelAwards.intervalEndedAtMs, endedAfterMs),
          ),
        )
        .orderBy(asc(serverLevelAwards.intervalStartedAtMs), asc(serverLevelAwards.awardId))
        .all();
      return rows.map(awardFromRow);
    },

    async appendAward(award) {
      const results = await database.batch([
        database
          .prepare(
            `INSERT OR IGNORE INTO server_level_awards
              (award_id, guild_id, user_id, configured_game_server_id, source_inbox_id, kind,
               interval_started_at_ms, interval_ended_at_ms, qualifying_seconds, multiplier,
               xp_units, scoring_policy_version, actor_user_id, reason, created_at_ms,
               projection_applied_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               CASE WHEN ? < 0 THEN MAX(?, -COALESCE((
                 SELECT total_xp_units FROM server_level_member_totals
                 WHERE guild_id = ? AND user_id = ?
               ), 0)) ELSE ? END,
               ?, ?, ?, ?, NULL)`,
          )
          .bind(
            award.awardId,
            award.guildId,
            award.userId,
            award.configuredGameServerId,
            award.sourceInboxId,
            award.kind,
            award.intervalStartedAtMs,
            award.intervalEndedAtMs,
            award.qualifyingSeconds,
            award.multiplier,
            award.xpUnits,
            award.xpUnits,
            award.guildId,
            award.userId,
            award.xpUnits,
            award.scoringPolicyVersion,
            award.actorUserId,
            award.reason,
            award.createdAtMs,
          ),
        database
          .prepare(
            `INSERT INTO server_level_member_totals
              (guild_id, user_id, total_xp_units, current_member, updated_at_ms)
             SELECT guild_id, user_id, MAX(0, xp_units), TRUE, created_at_ms
             FROM server_level_awards
             WHERE award_id = ? AND projection_applied_at_ms IS NULL
             ON CONFLICT(guild_id, user_id) DO UPDATE SET
               total_xp_units = MAX(0, server_level_member_totals.total_xp_units + (
                 SELECT xp_units FROM server_level_awards WHERE award_id = ?
               )),
               updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(award.awardId, award.awardId),
        database
          .prepare(
            `UPDATE server_level_awards
             SET projection_applied_at_ms = ?
             WHERE award_id = ? AND projection_applied_at_ms IS NULL`,
          )
          .bind(award.createdAtMs, award.awardId),
      ]);

      const applied = (results[1]?.meta.changes ?? 0) > 0;
      const [storedAward, current] = await Promise.all([
        db
          .select({ xpUnits: serverLevelAwards.xpUnits })
          .from(serverLevelAwards)
          .where(eq(serverLevelAwards.awardId, award.awardId))
          .limit(1)
          .get(),
        db
          .select({ totalXpUnits: serverLevelMemberTotals.totalXpUnits })
          .from(serverLevelMemberTotals)
          .where(
            and(
              eq(serverLevelMemberTotals.guildId, award.guildId),
              eq(serverLevelMemberTotals.userId, award.userId),
            ),
          )
          .limit(1)
          .get(),
      ]);
      const totalXpUnits = current?.totalXpUnits ?? 0;
      return {
        applied,
        previousTotalXpUnits: applied ? totalXpUnits - (storedAward?.xpUnits ?? 0) : totalXpUnits,
        totalXpUnits,
      };
    },

    async setCurrentMembership(guildId, userId, current, atMs) {
      const existing = await db
        .select({ totalXpUnits: serverLevelMemberTotals.totalXpUnits })
        .from(serverLevelMemberTotals)
        .where(
          and(
            eq(serverLevelMemberTotals.guildId, guildId),
            eq(serverLevelMemberTotals.userId, userId),
          ),
        )
        .limit(1)
        .get();
      await db
        .insert(serverLevelMemberTotals)
        .values({
          guildId,
          userId,
          totalXpUnits: existing?.totalXpUnits ?? 0,
          currentMember: current,
          updatedAtMs: atMs,
        })
        .onConflictDoUpdate({
          target: [serverLevelMemberTotals.guildId, serverLevelMemberTotals.userId],
          set: { currentMember: current, updatedAtMs: atMs },
        })
        .run();
    },

    async enqueueLevelAnnouncement(announcement) {
      await db
        .insert(serverLevelAnnouncementOutbox)
        .values({ ...announcement, deliveredAtMs: null, terminalReason: null })
        .onConflictDoNothing()
        .run();
    },

    async listPendingLevelAnnouncements(limit) {
      const rows = await db
        .select()
        .from(serverLevelAnnouncementOutbox)
        .where(
          and(
            isNull(serverLevelAnnouncementOutbox.deliveredAtMs),
            isNull(serverLevelAnnouncementOutbox.terminalReason),
          ),
        )
        .orderBy(
          asc(serverLevelAnnouncementOutbox.createdAtMs),
          asc(serverLevelAnnouncementOutbox.announcementId),
        )
        .limit(boundedPositiveInteger(limit, 1, 100))
        .all();
      return rows.map(
        ({ deliveredAtMs: _deliveredAtMs, terminalReason: _terminalReason, ...row }) => row,
      );
    },

    async markLevelAnnouncementDelivered(announcementId, deliveredAtMs) {
      await db
        .update(serverLevelAnnouncementOutbox)
        .set({ deliveredAtMs })
        .where(eq(serverLevelAnnouncementOutbox.announcementId, announcementId))
        .run();
    },

    async markLevelAnnouncementTerminal(announcementId, reason, terminalAtMs) {
      await db
        .update(serverLevelAnnouncementOutbox)
        .set({ terminalReason: reason, deliveredAtMs: terminalAtMs })
        .where(eq(serverLevelAnnouncementOutbox.announcementId, announcementId))
        .run();
    },

    async compactIntervalAwards(createdBeforeMs, limit) {
      const rows = await db
        .select()
        .from(serverLevelAwards)
        .where(
          and(
            lte(serverLevelAwards.createdAtMs, createdBeforeMs),
            or(eq(serverLevelAwards.kind, "interval"), eq(serverLevelAwards.kind, "overlap_delta")),
          ),
        )
        .orderBy(asc(serverLevelAwards.createdAtMs), asc(serverLevelAwards.awardId))
        .limit(boundedPositiveInteger(limit, 1, 500))
        .all();
      if (rows.length === 0) return 0;
      const commands: D1PreparedStatement[] = [];
      for (const row of rows) {
        const dayUtc = new Date(row.intervalStartedAtMs ?? row.createdAtMs)
          .toISOString()
          .slice(0, 10);
        commands.push(
          database
            .prepare(
              `INSERT INTO server_level_daily_summaries (
                 guild_id, user_id, day_utc, xp_units, qualifying_seconds,
                 scoring_policy_version, created_at_ms
               )
               SELECT guild_id, user_id, ?, xp_units, qualifying_seconds,
                 scoring_policy_version, ?
               FROM server_level_awards WHERE award_id = ?
               ON CONFLICT(guild_id, user_id, day_utc, scoring_policy_version) DO UPDATE SET
                 xp_units = server_level_daily_summaries.xp_units + excluded.xp_units,
                 qualifying_seconds = server_level_daily_summaries.qualifying_seconds + excluded.qualifying_seconds`,
            )
            .bind(dayUtc, Date.now(), row.awardId),
          database.prepare("DELETE FROM server_level_awards WHERE award_id = ?").bind(row.awardId),
        );
      }
      const results = await database.batch(commands);
      return results.reduce(
        (total, result, index) => total + (index % 2 === 1 ? (result.meta.changes ?? 0) : 0),
        0,
      );
    },

    async purgeRemovedGuilds(removedBeforeMs, limit) {
      const configs = await db
        .select({ guildId: serverLevelConfigs.guildId })
        .from(serverLevelConfigs)
        .where(
          and(
            eq(serverLevelConfigs.enabled, false),
            lte(serverLevelConfigs.removedAtMs, removedBeforeMs),
          ),
        )
        .limit(boundedPositiveInteger(limit, 1, 25))
        .all();
      let purged = 0;
      for (const config of configs) {
        const servers = await db
          .select({ id: serverLevelServers.id })
          .from(serverLevelServers)
          .where(eq(serverLevelServers.guildId, config.guildId))
          .all();
        const commands = guildPurgeStatements(
          database,
          config.guildId,
          servers.map((row) => row.id),
          removedBeforeMs,
        );
        const results = await database.batch(commands);
        if ((results.at(-1)?.meta.changes ?? 0) > 0) purged += 1;
      }
      return purged;
    },

    async eraseMemberProgression(guildId, userId) {
      await database.batch([
        database
          .prepare(
            `DELETE FROM server_level_current_presence
             WHERE EXISTS (
               SELECT 1 FROM server_level_earning_sessions
               WHERE server_level_earning_sessions.guild_id = ?
                 AND server_level_earning_sessions.user_id = ?
                 AND server_level_earning_sessions.configured_game_server_id = server_level_current_presence.configured_game_server_id
                 AND server_level_earning_sessions.steam_id64 = server_level_current_presence.steam_id64
             )`,
          )
          .bind(guildId, userId),
        database
          .prepare("DELETE FROM server_level_earning_sessions WHERE guild_id = ? AND user_id = ?")
          .bind(guildId, userId),
        database
          .prepare("DELETE FROM server_level_awards WHERE guild_id = ? AND user_id = ?")
          .bind(guildId, userId),
        database
          .prepare("DELETE FROM server_level_daily_summaries WHERE guild_id = ? AND user_id = ?")
          .bind(guildId, userId),
        database
          .prepare(
            "DELETE FROM server_level_announcement_outbox WHERE guild_id = ? AND user_id = ?",
          )
          .bind(guildId, userId),
        database
          .prepare("DELETE FROM server_level_member_totals WHERE guild_id = ? AND user_id = ?")
          .bind(guildId, userId),
      ]);
    },
  };
  storeCache.set(database, store);
  return store;
}

function guildPurgeStatements(
  database: D1Database,
  guildId: string,
  serverIds: string[],
  removedBeforeMs: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const removalGuard = `EXISTS (
    SELECT 1 FROM server_level_configs purge_config
    WHERE purge_config.guild_id = ?
      AND purge_config.enabled = 0
      AND purge_config.removed_at_ms <= ?
  )`;
  for (const serverId of serverIds) {
    statements.push(
      database
        .prepare(
          `DELETE FROM server_level_ingress_outbox
           WHERE inbox_id IN (
             SELECT inbox_id FROM server_level_webhook_inbox
             WHERE configured_game_server_id = ?
           ) AND ${removalGuard}`,
        )
        .bind(serverId, guildId, removedBeforeMs),
      database
        .prepare(
          `DELETE FROM server_level_webhook_inbox
           WHERE configured_game_server_id = ? AND ${removalGuard}`,
        )
        .bind(serverId, guildId, removedBeforeMs),
      database
        .prepare(
          `DELETE FROM server_level_processing_cursors
           WHERE configured_game_server_id = ? AND ${removalGuard}`,
        )
        .bind(serverId, guildId, removedBeforeMs),
      database
        .prepare(
          `DELETE FROM server_level_processing_leases
           WHERE configured_game_server_id = ? AND ${removalGuard}`,
        )
        .bind(serverId, guildId, removedBeforeMs),
      database
        .prepare(
          `DELETE FROM server_level_current_presence
           WHERE configured_game_server_id = ? AND ${removalGuard}`,
        )
        .bind(serverId, guildId, removedBeforeMs),
      database
        .prepare(
          `DELETE FROM server_level_earning_sessions
           WHERE configured_game_server_id = ? AND ${removalGuard}`,
        )
        .bind(serverId, guildId, removedBeforeMs),
    );
  }
  for (const table of [
    "server_level_credentials",
    "server_level_awards",
    "server_level_daily_summaries",
    "server_level_announcement_outbox",
    "server_level_member_totals",
    "server_level_ingress_outbox",
    "server_level_webhook_inbox",
    "server_level_earning_sessions",
    "server_level_servers",
  ]) {
    statements.push(
      database
        .prepare(`DELETE FROM ${table} WHERE guild_id = ? AND ${removalGuard}`)
        .bind(guildId, guildId, removedBeforeMs),
    );
  }
  statements.push(
    database
      .prepare(
        `DELETE FROM server_level_configs
         WHERE guild_id = ? AND enabled = 0 AND removed_at_ms <= ?`,
      )
      .bind(guildId, removedBeforeMs),
  );
  return statements;
}

function configFromRow(row: ConfigRow): ServerLevelConfig {
  return {
    guildId: row.guildId,
    enabled: row.enabled,
    announcementChannelId: row.announcementChannelId,
    removedAtMs: row.removedAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function serverToRow(server: ConfiguredGameServer): typeof serverLevelServers.$inferInsert {
  return {
    id: server.id,
    guildId: server.guildId,
    displayName: server.displayName,
    providerServerId: server.providerServerId,
    maxSlots: server.maxSlots,
    endpointId: server.endpointId,
    webhookCredentialId: server.webhookCredentialId,
    webhookVerifiedAtMs: server.webhookVerifiedAtMs,
    subscribedEventsJson: JSON.stringify(server.subscribedEvents),
    capacityProposalJson: server.capacityProposal ? JSON.stringify(server.capacityProposal) : null,
    lastRosterReconciledAtMs: server.lastRosterReconciledAtMs,
    lastCapacityCheckedAtMs: server.lastCapacityCheckedAtMs,
    createdAtMs: server.createdAtMs,
    updatedAtMs: server.updatedAtMs,
  };
}

function serverFromRow(row: ServerRow): ConfiguredGameServer {
  const subscribedEvents = parseSubscribedEvents(row.subscribedEventsJson);
  return {
    id: row.id,
    guildId: row.guildId,
    displayName: row.displayName,
    providerServerId: row.providerServerId,
    maxSlots: row.maxSlots,
    endpointId: row.endpointId,
    webhookCredentialId: row.webhookCredentialId,
    webhookVerifiedAtMs: row.webhookVerifiedAtMs,
    subscribedEvents,
    capacityProposal: parseCapacityProposal(row.capacityProposalJson),
    lastRosterReconciledAtMs: row.lastRosterReconciledAtMs,
    lastCapacityCheckedAtMs: row.lastCapacityCheckedAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function eventFromRow(row: InboxRow): ServerLevelProviderEvent {
  if (!isServerLevelProviderEventType(row.eventType)) {
    throw new Error("Stored Server Levels provider event type is invalid.");
  }
  return {
    inboxId: row.inboxId,
    deliveryId: row.deliveryId,
    configuredGameServerId: row.configuredGameServerId,
    guildId: row.guildId,
    eventType: row.eventType,
    occurredAtMs: row.occurredAtMs,
    steamId64: row.steamId64,
    population: row.population,
    queueSize: row.queueSize,
    receivedAtMs: row.receivedAtMs,
    ...(row.bodySha256 ? { bodySha256: row.bodySha256 } : {}),
  };
}

function sessionFromRow(row: SessionRow) {
  return { ...row };
}

function awardFromRow(row: AwardRow): ServerLevelAward {
  if (
    row.kind !== "interval" &&
    row.kind !== "overlap_delta" &&
    row.kind !== "support_adjustment"
  ) {
    throw new Error("Stored Server Levels award kind is invalid.");
  }
  const { projectionAppliedAtMs: _projectionAppliedAtMs, ...award } = row;
  return { ...award, kind: row.kind };
}

function parseSubscribedEvents(value: string): ConfiguredGameServer["subscribedEvents"] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored Server Levels subscriptions are invalid.");
  }
  if (!parsed.every(isServerLevelWebhookEventType)) {
    throw new Error("Stored Server Levels subscriptions contain an unsupported event.");
  }
  return [...new Set(parsed)];
}

function parseCapacityProposal(value: string | null): ServerLevelCapacityProposal | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    !Number.isSafeInteger(parsed.maxSlots) ||
    !Number.isSafeInteger(parsed.observedAtMs)
  ) {
    throw new Error("Stored Server Levels capacity proposal is invalid.");
  }
  return {
    maxSlots: parsed.maxSlots as number,
    observedAtMs: parsed.observedAtMs as number,
  };
}

function validateConfig(config: ServerLevelConfig): void {
  requiredId(config.guildId, "Guild ID");
  optionalId(config.announcementChannelId, "announcement channel ID");
  safeTimestamp(config.updatedAtMs, "updated timestamp");
  if (config.removedAtMs !== null) safeTimestamp(config.removedAtMs, "removed timestamp");
}

function validateServer(server: ConfiguredGameServer): void {
  requiredId(server.id, "Configured Game Server ID");
  requiredId(server.guildId, "Guild ID");
  requiredId(server.endpointId, "endpoint ID");
  requiredId(server.webhookCredentialId, "webhook credential ID");
  const name = server.displayName.trim();
  if (name.length < 1 || name.length > 100) {
    throw new Error("Configured Game Server display name must be between 1 and 100 characters.");
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(server.providerServerId)) {
    throw new Error("CFTools server identity has an invalid format.");
  }
  boundedPositiveInteger(server.maxSlots, 1, 10_000);
  if (!server.subscribedEvents.every(isServerLevelWebhookEventType)) {
    throw new Error("Configured Game Server includes an unsupported webhook subscription.");
  }
  if (server.capacityProposal) {
    boundedPositiveInteger(server.capacityProposal.maxSlots, 1, 10_000);
    safeTimestamp(server.capacityProposal.observedAtMs, "capacity observation timestamp");
  }
  if (server.lastRosterReconciledAtMs !== null) {
    safeTimestamp(server.lastRosterReconciledAtMs, "roster reconciliation timestamp");
  }
  if (server.lastCapacityCheckedAtMs !== null) {
    safeTimestamp(server.lastCapacityCheckedAtMs, "capacity check timestamp");
  }
  safeTimestamp(server.createdAtMs, "created timestamp");
  safeTimestamp(server.updatedAtMs, "updated timestamp");
}

function validateProviderEvent(event: ServerLevelProviderEvent): void {
  requiredId(event.inboxId, "inbox ID");
  requiredId(event.deliveryId, "delivery ID");
  requiredId(event.configuredGameServerId, "Configured Game Server ID");
  requiredId(event.guildId, "Guild ID");
  safeTimestamp(event.occurredAtMs, "event timestamp");
  safeTimestamp(event.receivedAtMs, "received timestamp");
  if (
    event.population !== null &&
    (!Number.isSafeInteger(event.population) || event.population < 0)
  ) {
    throw new Error("Provider population must be a non-negative whole number.");
  }
  if (event.queueSize !== null && (!Number.isSafeInteger(event.queueSize) || event.queueSize < 0)) {
    throw new Error("Provider queue size must be a non-negative whole number.");
  }
}

function requiredId(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new Error(`${label} is invalid.`);
}

function optionalId(value: string | null, label: string): void {
  if (value !== null) requiredId(value, label);
}

function safeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
}

function boundedPositiveInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Value must be a whole number between ${minimum} and ${maximum}.`);
  }
  return value;
}
