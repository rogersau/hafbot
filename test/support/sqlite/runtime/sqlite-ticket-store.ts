import { and, asc, count, desc, eq, lt, ne, sql } from "drizzle-orm";
import {
  ticketCounters,
  ticketInstances,
  ticketClaimDeliveries,
  ticketParticipantEvents,
  ticketParticipants,
  ticketPanels,
  ticketStaffMessages,
  ticketTemplateReplies,
} from "../db/app-schema";
import type {
  TicketInstance,
  TicketPanelConfig,
  TicketParticipant,
  TicketParticipantEvent,
} from "../../../../src/types";
import { parseTicketPanelStorage, serializeTicketPanelStorage } from "../../../../src/tickets";
import type { TicketStore } from "../../../../src/runtime/contracts/ticket-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type TicketPanelRow = typeof ticketPanels.$inferSelect;
type TicketPanelInsert = typeof ticketPanels.$inferInsert;
type TicketInstanceRow = typeof ticketInstances.$inferSelect;
type TicketInstanceInsert = typeof ticketInstances.$inferInsert;
type TicketStaffMessageInsert = typeof ticketStaffMessages.$inferInsert;

const ticketStoreCache = new WeakMap<D1Database, TicketStore>();
const STAFF_MESSAGE_DELIVERY_LEASE_MS = 2 * 60 * 1_000;

export function createSqliteTicketStore(database: D1Database): TicketStore {
  const cached = ticketStoreCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: TicketStore = {
    async reserveNextTicketNumber(guildId: string): Promise<number> {
      await db
        .insert(ticketCounters)
        .values({ guildId, nextTicketNumber: 1 })
        .onConflictDoNothing()
        .run();

      const [row] = await db.all<{ ticketNumber: number }>(sql`UPDATE ticket_counters
        SET next_ticket_number = next_ticket_number + 1
        WHERE guild_id = ${guildId}
        RETURNING next_ticket_number - 1 AS "ticketNumber"`);

      return row?.ticketNumber ?? 1;
    },

    async readTicketPanelConfig(guildId: string): Promise<TicketPanelConfig | null> {
      const row = await db
        .select()
        .from(ticketPanels)
        .where(eq(ticketPanels.guildId, guildId))
        .orderBy(asc(ticketPanels.panelId))
        .limit(1)
        .get();

      return row ? rowToPanel(row) : null;
    },

    async readTicketPanelConfigById(
      guildId: string,
      panelId: string,
    ): Promise<TicketPanelConfig | null> {
      const row = await db
        .select()
        .from(ticketPanels)
        .where(and(eq(ticketPanels.guildId, guildId), eq(ticketPanels.panelId, panelId)))
        .limit(1)
        .get();

      return row ? rowToPanel(row) : null;
    },

    async listTicketPanelConfigs(guildId: string): Promise<TicketPanelConfig[]> {
      const rows = await db
        .select()
        .from(ticketPanels)
        .where(eq(ticketPanels.guildId, guildId))
        .orderBy(asc(ticketPanels.panelId))
        .all();

      return rows.map(rowToPanel);
    },

    async upsertTicketPanelConfig(panel: TicketPanelConfig): Promise<void> {
      const values = panelToRow(panel);
      await db
        .insert(ticketPanels)
        .values(values)
        .onConflictDoUpdate({
          target: [ticketPanels.guildId, ticketPanels.panelId],
          set: values,
        })
        .run();
    },

    async countOpenTicketsForPanel(guildId: string, panelId: string): Promise<number> {
      const row = await db
        .select({ total: count() })
        .from(ticketInstances)
        .where(
          and(
            eq(ticketInstances.guildId, guildId),
            eq(ticketInstances.panelId, panelId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .get();
      return row?.total ?? 0;
    },

    async deleteTicketPanelConfig(guildId: string, panelId: string): Promise<void> {
      const openTicketsRow = await db
        .select({ total: count() })
        .from(ticketInstances)
        .where(
          and(
            eq(ticketInstances.guildId, guildId),
            eq(ticketInstances.panelId, panelId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .get();
      const openTickets = openTicketsRow?.total ?? 0;
      if (openTickets && openTickets > 0) {
        throw new Error("Cannot delete a ticket panel while it has open tickets.");
      }
      await db
        .delete(ticketPanels)
        .where(and(eq(ticketPanels.guildId, guildId), eq(ticketPanels.panelId, panelId)))
        .run();
    },

    async countOpenTicketsByUser(guildId: string, userId: string): Promise<number> {
      const panel = await this.readTicketPanelConfig(guildId);
      const excludedTypeIds = new Set(
        panel?.ticketTypes
          .filter((ticketType) => ticketType.limitExclusion)
          .map((ticketType) => ticketType.id) ?? [],
      );
      const rows = await db
        .select({ ticketTypeId: ticketInstances.ticketTypeId })
        .from(ticketInstances)
        .where(
          and(
            eq(ticketInstances.guildId, guildId),
            eq(ticketInstances.openerUserId, userId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .all();

      return rows.filter((row) => !excludedTypeIds.has(row.ticketTypeId)).length;
    },

    async createTicketInstance(instance: TicketInstance): Promise<void> {
      await db.insert(ticketInstances).values(instanceToRow(instance)).run();
    },

    async deleteTicketInstance(body: { guildId: string; channelId: string }): Promise<void> {
      await db
        .delete(ticketClaimDeliveries)
        .where(
          and(
            eq(ticketClaimDeliveries.guildId, body.guildId),
            eq(ticketClaimDeliveries.channelId, body.channelId),
          ),
        )
        .run();
      await db
        .delete(ticketInstances)
        .where(
          and(
            eq(ticketInstances.guildId, body.guildId),
            eq(ticketInstances.channelId, body.channelId),
          ),
        )
        .run();
    },

    async updateTicketClaim(body: {
      guildId: string;
      channelId: string;
      claimedByUserId: string | null;
      claimedAtMs: number | null;
    }): Promise<void> {
      await db
        .update(ticketInstances)
        .set({ claimedByUserId: body.claimedByUserId, claimedAtMs: body.claimedAtMs })
        .where(
          and(
            eq(ticketInstances.guildId, body.guildId),
            eq(ticketInstances.channelId, body.channelId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .run();
    },

    async updateTicketOpeningMessageId(body) {
      await db
        .update(ticketInstances)
        .set({ openingMessageId: body.openingMessageId })
        .where(
          and(
            eq(ticketInstances.guildId, body.guildId),
            eq(ticketInstances.channelId, body.channelId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .run();
    },

    async claimTicketClaimDelivery(body) {
      const result = await database
        .prepare(
          `INSERT INTO ticket_claim_deliveries
          (guild_id, channel_id, claimed_by_user_id, claimed_at_ms, phase, state, lease_until_ms)
         VALUES (?, ?, ?, ?, ?, 'delivering', ?)
         ON CONFLICT (guild_id, channel_id, claimed_by_user_id, claimed_at_ms, phase)
         DO UPDATE SET state = 'delivering', lease_until_ms = excluded.lease_until_ms
         WHERE ticket_claim_deliveries.state = 'pending'
           OR (ticket_claim_deliveries.state = 'delivering' AND ticket_claim_deliveries.lease_until_ms <= ?)`,
        )
        .bind(
          body.guildId,
          body.channelId,
          body.claimedByUserId,
          body.claimedAtMs,
          body.phase,
          body.leaseUntilMs,
          body.nowMs,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async completeTicketClaimDelivery(body) {
      await database
        .prepare(
          `UPDATE ticket_claim_deliveries SET state = 'delivered', lease_until_ms = NULL
         WHERE guild_id = ? AND channel_id = ? AND claimed_by_user_id = ? AND claimed_at_ms = ?
           AND phase = ? AND state = 'delivering' AND lease_until_ms = ?`,
        )
        .bind(
          body.guildId,
          body.channelId,
          body.claimedByUserId,
          body.claimedAtMs,
          body.phase,
          body.leaseUntilMs,
        )
        .run();
    },

    async releaseTicketClaimDelivery(body) {
      await database
        .prepare(
          `UPDATE ticket_claim_deliveries SET state = 'pending', lease_until_ms = NULL
         WHERE guild_id = ? AND channel_id = ? AND claimed_by_user_id = ? AND claimed_at_ms = ?
           AND phase = ? AND state = 'delivering' AND lease_until_ms = ?`,
        )
        .bind(
          body.guildId,
          body.channelId,
          body.claimedByUserId,
          body.claimedAtMs,
          body.phase,
          body.leaseUntilMs,
        )
        .run();
    },

    async readOpenTicketByChannel(
      guildId: string,
      channelId: string,
    ): Promise<TicketInstance | null> {
      const row = await db
        .select()
        .from(ticketInstances)
        .where(
          and(
            eq(ticketInstances.guildId, guildId),
            eq(ticketInstances.channelId, channelId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .limit(1)
        .get();

      return row ? rowToInstance(row) : null;
    },

    async readTicketParticipant(
      guildId: string,
      ticketChannelId: string,
      userId: string,
    ): Promise<TicketParticipant | null> {
      const row = await db
        .select()
        .from(ticketParticipants)
        .where(
          and(
            eq(ticketParticipants.guildId, guildId),
            eq(ticketParticipants.ticketChannelId, ticketChannelId),
            eq(ticketParticipants.userId, userId),
          ),
        )
        .get();
      return row ?? null;
    },

    async addTicketParticipant(body) {
      const eventId = crypto.randomUUID();
      const results = await database.batch([
        database
          .prepare(
            `INSERT OR IGNORE INTO ticket_participants
              (guild_id, ticket_channel_id, user_id, added_event_id, added_by_user_id, added_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            body.guildId,
            body.ticketChannelId,
            body.userId,
            eventId,
            body.addedByUserId,
            body.addedAtMs,
          ),
        database
          .prepare(
            `INSERT INTO ticket_participant_events
              (id, guild_id, ticket_channel_id, ticket_type_id, action, target_user_id, actor_user_id, created_at_ms)
             SELECT ?, ?, ?, ?, 'participant-added', ?, ?, ? WHERE changes() = 1`,
          )
          .bind(
            eventId,
            body.guildId,
            body.ticketChannelId,
            body.ticketTypeId,
            body.userId,
            body.addedByUserId,
            body.addedAtMs,
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) > 0) return { created: true, eventId };
      const existing = await this.readTicketParticipant(
        body.guildId,
        body.ticketChannelId,
        body.userId,
      );
      if (!existing) throw new Error("Ticket participant conflict could not be resolved.");
      return { created: false, eventId: existing.addedEventId };
    },

    async removeTicketParticipant(body) {
      const eventId = crypto.randomUUID();
      const results = await database.batch([
        database
          .prepare(
            "DELETE FROM ticket_participants WHERE guild_id = ? AND ticket_channel_id = ? AND user_id = ?",
          )
          .bind(body.guildId, body.ticketChannelId, body.userId),
        database
          .prepare(
            `INSERT INTO ticket_participant_events
              (id, guild_id, ticket_channel_id, ticket_type_id, action, target_user_id, actor_user_id, created_at_ms)
             SELECT ?, ?, ?, ?, 'participant-removed', ?, ?, ? WHERE changes() = 1`,
          )
          .bind(
            eventId,
            body.guildId,
            body.ticketChannelId,
            body.ticketTypeId,
            body.userId,
            body.removedByUserId,
            body.removedAtMs,
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) > 0) return { removed: true, eventId };
      const existing = await this.readLatestTicketParticipantEvent({
        guildId: body.guildId,
        ticketChannelId: body.ticketChannelId,
        targetUserId: body.userId,
        action: "participant-removed",
      });
      return { removed: false, eventId: existing?.id ?? null };
    },

    async listTicketParticipants(guildId, ticketChannelId): Promise<TicketParticipant[]> {
      return db
        .select()
        .from(ticketParticipants)
        .where(
          and(
            eq(ticketParticipants.guildId, guildId),
            eq(ticketParticipants.ticketChannelId, ticketChannelId),
          ),
        )
        .orderBy(asc(ticketParticipants.addedAtMs), asc(ticketParticipants.userId))
        .all();
    },

    async listTicketParticipantEvents(guildId, ticketChannelId): Promise<TicketParticipantEvent[]> {
      const rows = await db
        .select()
        .from(ticketParticipantEvents)
        .where(
          and(
            eq(ticketParticipantEvents.guildId, guildId),
            eq(ticketParticipantEvents.ticketChannelId, ticketChannelId),
          ),
        )
        .orderBy(asc(ticketParticipantEvents.createdAtMs), asc(ticketParticipantEvents.id))
        .all();
      return rows.map((row) => ({
        ...row,
        action: row.action as TicketParticipantEvent["action"],
        notificationState: row.notificationState as TicketParticipantEvent["notificationState"],
      }));
    },

    async readLatestTicketParticipantEvent(body): Promise<TicketParticipantEvent | null> {
      const row = await db
        .select()
        .from(ticketParticipantEvents)
        .where(
          and(
            eq(ticketParticipantEvents.guildId, body.guildId),
            eq(ticketParticipantEvents.ticketChannelId, body.ticketChannelId),
            eq(ticketParticipantEvents.targetUserId, body.targetUserId),
            eq(ticketParticipantEvents.action, body.action),
          ),
        )
        .orderBy(desc(ticketParticipantEvents.createdAtMs), desc(ticketParticipantEvents.id))
        .get();
      return row
        ? {
            ...row,
            action: row.action as TicketParticipantEvent["action"],
            notificationState: row.notificationState as TicketParticipantEvent["notificationState"],
          }
        : null;
    },

    async claimTicketParticipantNotification(eventId, claimedAtMs): Promise<boolean> {
      const result = await database
        .prepare(
          `UPDATE ticket_participant_events
           SET notification_state = 'delivering', notification_claimed_at_ms = ?
           WHERE id = ? AND (
             notification_state = 'pending'
             OR (notification_state = 'delivering' AND notification_claimed_at_ms < ?)
           )`,
        )
        .bind(claimedAtMs, eventId, claimedAtMs - 2 * 60 * 1000)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async completeTicketParticipantNotification(eventId, claimedAtMs): Promise<void> {
      await db
        .update(ticketParticipantEvents)
        .set({ notificationState: "delivered", notificationClaimedAtMs: null })
        .where(
          and(
            eq(ticketParticipantEvents.id, eventId),
            eq(ticketParticipantEvents.notificationState, "delivering"),
            eq(ticketParticipantEvents.notificationClaimedAtMs, claimedAtMs),
          ),
        )
        .run();
    },

    async releaseTicketParticipantNotification(eventId, claimedAtMs): Promise<void> {
      await db
        .update(ticketParticipantEvents)
        .set({ notificationState: "pending", notificationClaimedAtMs: null })
        .where(
          and(
            eq(ticketParticipantEvents.id, eventId),
            eq(ticketParticipantEvents.notificationState, "delivering"),
            eq(ticketParticipantEvents.notificationClaimedAtMs, claimedAtMs),
          ),
        )
        .run();
    },

    async readOpenTicketByStaffThread(
      guildId: string,
      staffThreadId: string,
    ): Promise<TicketInstance | null> {
      const row = await db
        .select()
        .from(ticketInstances)
        .where(
          and(
            eq(ticketInstances.guildId, guildId),
            eq(ticketInstances.staffThreadId, staffThreadId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .limit(1)
        .get();

      return row ? rowToInstance(row) : null;
    },

    async listClosedTicketInstances(body: {
      guildId: string;
      panelId?: string | null;
      limit: number;
      beforeOpenedAtMs: number | null;
    }) {
      const limit = Math.max(1, Math.min(100, Math.floor(body.limit)));
      const baseWhere = body.panelId
        ? and(
            eq(ticketInstances.guildId, body.guildId),
            eq(ticketInstances.panelId, body.panelId),
            eq(ticketInstances.status, "closed"),
          )
        : and(eq(ticketInstances.guildId, body.guildId), eq(ticketInstances.status, "closed"));
      const where =
        body.beforeOpenedAtMs === null
          ? baseWhere
          : and(baseWhere, lt(ticketInstances.openedAtMs, body.beforeOpenedAtMs));
      const rows = await db
        .select()
        .from(ticketInstances)
        .where(where)
        .orderBy(desc(ticketInstances.openedAtMs))
        .limit(limit + 1)
        .all();
      const pageRows = rows.slice(0, limit);
      const totalRow = await db
        .select({ total: count() })
        .from(ticketInstances)
        .where(baseWhere)
        .get();

      return {
        tickets: pageRows.map(rowToInstance),
        total: totalRow?.total ?? 0,
        nextCursor:
          rows.length > limit ? (pageRows[pageRows.length - 1]?.openedAtMs ?? null) : null,
      };
    },

    async listMemberTicketHistory(body: {
      guildId: string;
      openerUserId: string;
      excludeChannelId?: string | null;
      limit: number;
      beforeOpenedAtMs: number | null;
    }) {
      const limit = Math.max(1, Math.min(100, Math.floor(body.limit)));
      const baseWhere = and(
        eq(ticketInstances.guildId, body.guildId),
        eq(ticketInstances.openerUserId, body.openerUserId),
        body.excludeChannelId ? ne(ticketInstances.channelId, body.excludeChannelId) : undefined,
      );
      const where =
        body.beforeOpenedAtMs === null
          ? baseWhere
          : and(baseWhere, lt(ticketInstances.openedAtMs, body.beforeOpenedAtMs));
      const rows = await db
        .select()
        .from(ticketInstances)
        .where(where)
        .orderBy(desc(ticketInstances.openedAtMs))
        .limit(limit + 1)
        .all();
      const pageRows = rows.slice(0, limit);
      const totalRow = await db
        .select({ total: count() })
        .from(ticketInstances)
        .where(baseWhere)
        .get();

      return {
        tickets: pageRows.map(rowToInstance),
        total: totalRow?.total ?? 0,
        nextCursor:
          rows.length > limit ? (pageRows[pageRows.length - 1]?.openedAtMs ?? null) : null,
      };
    },

    async closeTicketInstance(body: {
      guildId: string;
      channelId: string;
      closedByUserId: string;
      closedAtMs: number;
      transcriptMessageId: string | null;
    }): Promise<void> {
      const existing = await this.readOpenTicketByChannel(body.guildId, body.channelId);
      if (!existing) {
        const closed = await db
          .select()
          .from(ticketInstances)
          .where(
            and(
              eq(ticketInstances.guildId, body.guildId),
              eq(ticketInstances.channelId, body.channelId),
              eq(ticketInstances.status, "closed"),
            ),
          )
          .get();
        if (
          closed?.closedByUserId === body.closedByUserId &&
          closed.closedAtMs === body.closedAtMs &&
          closed.transcriptMessageId === body.transcriptMessageId
        ) {
          return;
        }
        throw new Error(`No open ticket found for guild ${body.guildId} channel ${body.channelId}`);
      }

      await db
        .update(ticketInstances)
        .set({
          status: "closed",
          closedByUserId: body.closedByUserId,
          closedAtMs: body.closedAtMs,
          transcriptMessageId: body.transcriptMessageId,
        })
        .where(
          and(
            eq(ticketInstances.guildId, body.guildId),
            eq(ticketInstances.channelId, body.channelId),
            eq(ticketInstances.status, "open"),
          ),
        )
        .run();
    },

    async updateTicketInstanceStaffThreadId(body: {
      guildId: string;
      channelId: string;
      staffThreadId: string | null;
    }): Promise<void> {
      await db
        .update(ticketInstances)
        .set({ staffThreadId: body.staffThreadId })
        .where(
          and(
            eq(ticketInstances.guildId, body.guildId),
            eq(ticketInstances.channelId, body.channelId),
          ),
        )
        .run();
    },

    async recordStaffMessageMapping(body: {
      guildId: string;
      ticketChannelId: string;
      staffThreadId: string;
      staffMessageId: string;
      botMessageId: string;
      staffUserId: string;
      staffDisplayName: string;
      content: string;
      createdAtMs: number;
    }): Promise<void> {
      await db
        .insert(ticketStaffMessages)
        .values(body satisfies TicketStaffMessageInsert)
        .run();
    },

    async claimStaffMessageDelivery(body): Promise<boolean> {
      const claimed = await database
        .prepare(
          `INSERT INTO ticket_staff_messages (
             guild_id, ticket_channel_id, staff_thread_id, staff_message_id,
             bot_message_id, staff_user_id, staff_display_name, content,
             created_at_ms, delivery_status
           ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'pending')
           ON CONFLICT(guild_id, staff_thread_id, staff_message_id) DO UPDATE SET
             created_at_ms = excluded.created_at_ms
           WHERE ticket_staff_messages.delivery_status = 'pending'
             AND ticket_staff_messages.created_at_ms <= excluded.created_at_ms - ?
           RETURNING staff_message_id`,
        )
        .bind(
          body.guildId,
          body.ticketChannelId,
          body.staffThreadId,
          body.staffMessageId,
          body.staffUserId,
          body.staffDisplayName,
          body.content,
          body.createdAtMs,
          STAFF_MESSAGE_DELIVERY_LEASE_MS,
        )
        .first<{ staff_message_id: string }>();
      return claimed !== null;
    },

    async completeStaffMessageDelivery(body): Promise<void> {
      await db
        .update(ticketStaffMessages)
        .set({ botMessageId: body.botMessageId, deliveryStatus: "sent" })
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.staffThreadId, body.staffThreadId),
            eq(ticketStaffMessages.staffMessageId, body.staffMessageId),
            eq(ticketStaffMessages.deliveryStatus, "pending"),
            eq(ticketStaffMessages.createdAtMs, body.claimedAtMs),
          ),
        )
        .run();
    },

    async releaseStaffMessageDelivery(body): Promise<void> {
      await db
        .delete(ticketStaffMessages)
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.staffThreadId, body.staffThreadId),
            eq(ticketStaffMessages.staffMessageId, body.staffMessageId),
            eq(ticketStaffMessages.deliveryStatus, "pending"),
            eq(ticketStaffMessages.createdAtMs, body.claimedAtMs),
          ),
        )
        .run();
    },

    async readStaffMessageMapping(body: {
      guildId: string;
      ticketChannelId: string;
      botMessageId: string;
    }): Promise<{ staffUserId: string; staffDisplayName: string } | null> {
      const row = await db
        .select()
        .from(ticketStaffMessages)
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.ticketChannelId, body.ticketChannelId),
            eq(ticketStaffMessages.botMessageId, body.botMessageId),
            eq(ticketStaffMessages.deliveryStatus, "sent"),
          ),
        )
        .limit(1)
        .get();

      if (!row) return null;
      return {
        staffUserId: row.staffUserId,
        staffDisplayName: row.staffDisplayName,
      };
    },

    async readStaffMessageMappingByStaffMessage(body: {
      guildId: string;
      staffThreadId: string;
      staffMessageId: string;
    }) {
      const row = await db
        .select()
        .from(ticketStaffMessages)
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.staffThreadId, body.staffThreadId),
            eq(ticketStaffMessages.staffMessageId, body.staffMessageId),
            eq(ticketStaffMessages.deliveryStatus, "sent"),
          ),
        )
        .limit(1)
        .get();

      if (!row) return null;
      return {
        ticketChannelId: row.ticketChannelId,
        botMessageId: row.botMessageId,
        staffUserId: row.staffUserId,
        staffDisplayName: row.staffDisplayName,
        content: row.content,
      };
    },

    async updateStaffMessageMapping(body: {
      guildId: string;
      staffThreadId: string;
      staffMessageId: string;
      staffDisplayName: string;
      content: string;
    }): Promise<void> {
      await db
        .update(ticketStaffMessages)
        .set({ staffDisplayName: body.staffDisplayName, content: body.content })
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.staffThreadId, body.staffThreadId),
            eq(ticketStaffMessages.staffMessageId, body.staffMessageId),
          ),
        )
        .run();
    },

    async deleteStaffMessageMapping(body: {
      guildId: string;
      staffThreadId: string;
      staffMessageId: string;
    }): Promise<void> {
      await db
        .delete(ticketStaffMessages)
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.staffThreadId, body.staffThreadId),
            eq(ticketStaffMessages.staffMessageId, body.staffMessageId),
          ),
        )
        .run();
    },

    async cleanupStaffMessages(body: { guildId: string; ticketChannelId: string }): Promise<void> {
      await db
        .delete(ticketStaffMessages)
        .where(
          and(
            eq(ticketStaffMessages.guildId, body.guildId),
            eq(ticketStaffMessages.ticketChannelId, body.ticketChannelId),
          ),
        )
        .run();
    },

    async claimTicketTemplateReply(reply): Promise<boolean> {
      const claimed = await db
        .insert(ticketTemplateReplies)
        .values(reply)
        .onConflictDoNothing()
        .returning({ interactionId: ticketTemplateReplies.interactionId })
        .get();
      return claimed !== undefined;
    },

    async completeTicketTemplateReply(body): Promise<void> {
      await db
        .update(ticketTemplateReplies)
        .set({ botMessageId: body.botMessageId, status: "sent" })
        .where(
          and(
            eq(ticketTemplateReplies.interactionId, body.interactionId),
            eq(ticketTemplateReplies.status, "pending"),
          ),
        )
        .run();
    },

    async releaseTicketTemplateReply(interactionId): Promise<void> {
      await db
        .delete(ticketTemplateReplies)
        .where(
          and(
            eq(ticketTemplateReplies.interactionId, interactionId),
            eq(ticketTemplateReplies.status, "pending"),
          ),
        )
        .run();
    },

    async listTicketTemplateReplies(guildId, ticketChannelId) {
      const rows = await db
        .select()
        .from(ticketTemplateReplies)
        .where(
          and(
            eq(ticketTemplateReplies.guildId, guildId),
            eq(ticketTemplateReplies.ticketChannelId, ticketChannelId),
          ),
        )
        .orderBy(desc(ticketTemplateReplies.createdAtMs))
        .all();
      return rows.map((row) => ({
        interactionId: row.interactionId,
        guildId: row.guildId,
        ticketChannelId: row.ticketChannelId,
        templateId: row.templateId,
        templateInternalName: row.templateInternalName,
        staffUserId: row.staffUserId,
        botMessageId: row.botMessageId,
        status: row.status === "sent" ? ("sent" as const) : ("pending" as const),
        createdAtMs: row.createdAtMs,
      }));
    },
  };

  ticketStoreCache.set(database, store);
  return store;
}

function rowToPanel(row: TicketPanelRow): TicketPanelConfig {
  const storedPanel = parseTicketPanelStorage(row.ticketTypesJson);
  return {
    guildId: row.guildId,
    panelId: row.panelId,
    panelName: row.panelName,
    panelChannelId: row.panelChannelId,
    categoryChannelId: row.categoryChannelId,
    transcriptChannelId: row.transcriptChannelId,
    panelEmoji: storedPanel.panelEmoji,
    panelTitle: storedPanel.panelTitle,
    panelDescription: storedPanel.panelDescription,
    panelFooter: storedPanel.panelFooter,
    panelColor: storedPanel.panelColor,
    panelMessageId: row.panelMessageId,
    ticketCreationLimit: row.ticketCreationLimit,
    ticketLimitRejectionMessage: row.ticketLimitRejectionMessage,
    enableTicketClaiming: row.enableTicketClaiming === 1,
    aiTranscriptSummariesEnabled: row.aiTranscriptSummariesEnabled === 1,
    ticketTypes: storedPanel.ticketTypes,
  };
}

function panelToRow(panel: TicketPanelConfig): TicketPanelInsert {
  return {
    guildId: panel.guildId,
    panelId: panel.panelId ?? "main",
    panelName: panel.panelName ?? "Main panel",
    panelChannelId: panel.panelChannelId,
    categoryChannelId: panel.categoryChannelId,
    transcriptChannelId: panel.transcriptChannelId,
    panelMessageId: panel.panelMessageId,
    ticketTypesJson: serializeTicketPanelStorage(panel),
    ticketCreationLimit: panel.ticketCreationLimit,
    ticketLimitRejectionMessage: panel.ticketLimitRejectionMessage,
    enableTicketClaiming: panel.enableTicketClaiming ? 1 : 0,
    aiTranscriptSummariesEnabled: panel.aiTranscriptSummariesEnabled ? 1 : 0,
  };
}

function rowToInstance(row: TicketInstanceRow): TicketInstance {
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    panelId: row.panelId,
    ticketTypeId: row.ticketTypeId,
    ticketTypeLabel: row.ticketTypeLabel,
    openerUserId: row.openerUserId,
    supportRoleId: row.supportRoleId,
    status: row.status as TicketInstance["status"],
    answers: JSON.parse(row.answersJson) as TicketInstance["answers"],
    openedAtMs: row.openedAtMs,
    closedAtMs: row.closedAtMs,
    closedByUserId: row.closedByUserId,
    transcriptMessageId: row.transcriptMessageId,
    staffThreadId: row.staffThreadId,
    claimedByUserId: row.claimedByUserId,
    claimedAtMs: row.claimedAtMs,
    openingMessageId: row.openingMessageId,
  };
}

function instanceToRow(instance: TicketInstance): TicketInstanceInsert {
  return {
    guildId: instance.guildId,
    channelId: instance.channelId,
    panelId: instance.panelId ?? "main",
    ticketTypeId: instance.ticketTypeId,
    ticketTypeLabel: instance.ticketTypeLabel,
    openerUserId: instance.openerUserId,
    supportRoleId: instance.supportRoleId,
    status: instance.status,
    answersJson: JSON.stringify(instance.answers),
    openedAtMs: instance.openedAtMs,
    closedAtMs: instance.closedAtMs,
    closedByUserId: instance.closedByUserId,
    transcriptMessageId: instance.transcriptMessageId,
    staffThreadId: instance.staffThreadId,
    claimedByUserId: instance.claimedByUserId ?? null,
    claimedAtMs: instance.claimedAtMs ?? null,
    openingMessageId: instance.openingMessageId ?? null,
  };
}
