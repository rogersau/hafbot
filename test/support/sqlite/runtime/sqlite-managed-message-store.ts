import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  managedMessageAuditOutbox,
  managedMessageDrafts,
  managedMessageMediaAssets,
  managedMessageMediaRefs,
  managedMessages,
} from "../db/app-schema";
import type {
  ManagedMessage,
  ManagedMessageAnnouncement,
  ManagedMessageDraft,
  ManagedMessageEmbed,
  ManagedMessageLinkButton,
} from "../../../../src/types";
import { isRecord } from "../../../../src/unknown-parse";
import type { ManagedMessageStore } from "../../../../src/runtime/contracts/managed-message-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type ManagedMessageRow = typeof managedMessages.$inferSelect;
type ManagedMessageInsert = typeof managedMessages.$inferInsert;
type ManagedMessageDraftRow = typeof managedMessageDrafts.$inferSelect;
type ManagedMessageDraftInsert = typeof managedMessageDrafts.$inferInsert;
type ManagedMessageAuditOutboxRow = typeof managedMessageAuditOutbox.$inferSelect;

const AUDIT_CLAIM_LEASE_MS = 30_000;
const PUBLICATION_CLAIM_LEASE_MS = 60_000;

const storeCache = new WeakMap<D1Database, ManagedMessageStore>();

export function createSqliteManagedMessageStore(database: D1Database): ManagedMessageStore {
  const cached = storeCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: ManagedMessageStore = {
    async registerMediaAsset(guildId, filename, createdAtMs = Date.now()) {
      await db
        .insert(managedMessageMediaAssets)
        .values({ guildId, filename, createdAtMs, status: "active" })
        .onConflictDoNothing()
        .run();
    },

    async listPendingMediaAssets(guildId) {
      const rows = await db
        .select({ filename: managedMessageMediaAssets.filename })
        .from(managedMessageMediaAssets)
        .where(
          and(
            eq(managedMessageMediaAssets.guildId, guildId),
            eq(managedMessageMediaAssets.status, "pending_deletion"),
          ),
        )
        .all();
      return rows.map(({ filename }) => filename);
    },

    async deleteMediaAsset(guildId, filename) {
      await db
        .delete(managedMessageMediaAssets)
        .where(
          and(
            eq(managedMessageMediaAssets.guildId, guildId),
            eq(managedMessageMediaAssets.filename, filename),
            eq(managedMessageMediaAssets.status, "pending_deletion"),
            sql`NOT EXISTS (
              SELECT 1 FROM managed_message_media_refs
              WHERE managed_message_media_refs.guild_id = ${guildId}
                AND managed_message_media_refs.filename = ${filename}
            )`,
          ),
        )
        .run();
    },

    async claimMediaAssetDeletion(guildId, filename) {
      const updated = await db
        .update(managedMessageMediaAssets)
        .set({ status: "pending_deletion" })
        .where(
          and(
            eq(managedMessageMediaAssets.guildId, guildId),
            eq(managedMessageMediaAssets.filename, filename),
            or(
              eq(managedMessageMediaAssets.status, "active"),
              eq(managedMessageMediaAssets.status, "pending_deletion"),
            ),
            sql`NOT EXISTS (
              SELECT 1 FROM managed_message_media_refs
              WHERE managed_message_media_refs.guild_id = ${guildId}
                AND managed_message_media_refs.filename = ${filename}
            )`,
          ),
        )
        .run();
      return updated.meta.changes > 0;
    },

    async syncMediaReferences(guildId, ownerType, ownerId, filenames) {
      const uniqueFilenames: string[] = [];
      for (const filename of new Set(filenames)) {
        const asset = await db
          .select({ filename: managedMessageMediaAssets.filename })
          .from(managedMessageMediaAssets)
          .where(
            and(
              eq(managedMessageMediaAssets.guildId, guildId),
              eq(managedMessageMediaAssets.filename, filename),
              or(
                eq(managedMessageMediaAssets.status, "active"),
                eq(managedMessageMediaAssets.status, "pending_deletion"),
              ),
            ),
          )
          .limit(1)
          .get();
        if (asset) uniqueFilenames.push(filename);
      }
      const existing = await db
        .select({ filename: managedMessageMediaRefs.filename })
        .from(managedMessageMediaRefs)
        .where(
          and(
            eq(managedMessageMediaRefs.guildId, guildId),
            eq(managedMessageMediaRefs.ownerType, ownerType),
            eq(managedMessageMediaRefs.ownerId, ownerId),
          ),
        )
        .all();
      const deleteExisting = db
        .delete(managedMessageMediaRefs)
        .where(
          and(
            eq(managedMessageMediaRefs.guildId, guildId),
            eq(managedMessageMediaRefs.ownerType, ownerType),
            eq(managedMessageMediaRefs.ownerId, ownerId),
          ),
        );
      if (uniqueFilenames.length > 0) {
        const insertNext = db
          .insert(managedMessageMediaRefs)
          .values(uniqueFilenames.map((filename) => ({ guildId, filename, ownerType, ownerId })))
          .onConflictDoNothing();
        await db.batch([
          deleteExisting,
          reactivateMediaAssets(db, guildId, uniqueFilenames),
          insertNext,
        ]);
      } else {
        await deleteExisting.run();
      }
      return orphanMediaAssets(
        db,
        guildId,
        existing.map(({ filename }) => filename),
        uniqueFilenames,
      );
    },

    async deleteMediaReferences(guildId, ownerType, ownerId) {
      return store.syncMediaReferences(guildId, ownerType, ownerId, []);
    },

    async listByGuild(guildId) {
      const rows = await db
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.guildId, guildId))
        .orderBy(asc(managedMessages.internalName), desc(managedMessages.updatedAtMs))
        .all();
      return rows.map(mapRow);
    },

    async listDraftsByGuild(guildId) {
      const rows = await db
        .select()
        .from(managedMessageDrafts)
        .where(eq(managedMessageDrafts.guildId, guildId))
        .orderBy(asc(managedMessageDrafts.internalName), desc(managedMessageDrafts.updatedAtMs))
        .all();
      return rows.map(mapDraftRow);
    },

    async readById(guildId, id) {
      const row = await db
        .select()
        .from(managedMessages)
        .where(and(eq(managedMessages.guildId, guildId), eq(managedMessages.id, id)))
        .limit(1)
        .get();
      return row ? mapRow(row) : null;
    },

    async readDraftById(guildId, id) {
      const row = await db
        .select()
        .from(managedMessageDrafts)
        .where(and(eq(managedMessageDrafts.guildId, guildId), eq(managedMessageDrafts.id, id)))
        .limit(1)
        .get();
      return row ? mapDraftRow(row) : null;
    },

    async readByCanonicalMessage(guildId, channelId, messageId) {
      const row = await db
        .select()
        .from(managedMessages)
        .where(
          and(
            eq(managedMessages.guildId, guildId),
            eq(managedMessages.channelId, channelId),
            eq(managedMessages.messageId, messageId),
          ),
        )
        .limit(1)
        .get();
      return row ? mapRow(row) : null;
    },

    async countByGuild(guildId) {
      const rows = await db
        .select({ id: managedMessages.id })
        .from(managedMessages)
        .where(eq(managedMessages.guildId, guildId))
        .all();
      return rows.length;
    },

    async countDraftsByGuild(guildId) {
      const rows = await db
        .select({ id: managedMessageDrafts.id })
        .from(managedMessageDrafts)
        .where(eq(managedMessageDrafts.guildId, guildId))
        .all();
      return rows.length;
    },

    async upsert(message, mediaFilenames = []) {
      const values = toRow(message);
      const validMediaFilenames = await readRegisteredMediaFilenames(
        db,
        message.guildId,
        mediaFilenames,
      );
      const existingMediaFilenames = await readOwnedMediaFilenames(
        db,
        message.guildId,
        "message",
        message.id,
      );
      const upsertMessage = db
        .insert(managedMessages)
        .values(values)
        .onConflictDoUpdate({
          target: managedMessages.id,
          set: {
            guildId: values.guildId,
            internalName: values.internalName,
            channelId: values.channelId,
            messageId: values.messageId,
            embedsJson: values.embedsJson,
            buttonsJson: values.buttonsJson,
            announcementJson: values.announcementJson,
            status: values.status,
            createdAtMs: values.createdAtMs,
            updatedAtMs: values.updatedAtMs,
          },
        });
      const deleteExistingRefs = deleteOwnedMediaReferences(
        db,
        message.guildId,
        "message",
        message.id,
      );
      if (validMediaFilenames.length > 0) {
        const insertNextRefs = insertOwnedMediaReferences(
          db,
          message.guildId,
          "message",
          message.id,
          validMediaFilenames,
        );
        await db.batch([
          upsertMessage,
          deleteExistingRefs,
          reactivateMediaAssets(db, message.guildId, validMediaFilenames),
          insertNextRefs,
        ]);
      } else {
        await db.batch([upsertMessage, deleteExistingRefs]);
      }
      return orphanMediaAssets(db, message.guildId, existingMediaFilenames, validMediaFilenames);
    },

    async upsertDraft(draft, mediaFilenames = []) {
      const values = toDraftRow(draft);
      const validMediaFilenames = await readRegisteredMediaFilenames(
        db,
        draft.guildId,
        mediaFilenames,
      );
      const existingMediaFilenames = await readOwnedMediaFilenames(
        db,
        draft.guildId,
        "draft",
        draft.id,
      );
      const upsertDraft = db
        .insert(managedMessageDrafts)
        .values(values)
        .onConflictDoUpdate({
          target: managedMessageDrafts.id,
          set: {
            guildId: values.guildId,
            internalName: values.internalName,
            channelId: values.channelId,
            embedsJson: values.embedsJson,
            buttonsJson: values.buttonsJson,
            announcementJson: values.announcementJson,
            status: values.status,
            scheduledAtMs: values.scheduledAtMs,
            failureReason: values.failureReason,
            attemptCount: values.attemptCount,
            updatedAtMs: values.updatedAtMs,
          },
        });
      const deleteExistingRefs = deleteOwnedMediaReferences(db, draft.guildId, "draft", draft.id);
      if (validMediaFilenames.length > 0) {
        const insertNextRefs = insertOwnedMediaReferences(
          db,
          draft.guildId,
          "draft",
          draft.id,
          validMediaFilenames,
        );
        await db.batch([
          upsertDraft,
          deleteExistingRefs,
          reactivateMediaAssets(db, draft.guildId, validMediaFilenames),
          insertNextRefs,
        ]);
      } else {
        await db.batch([upsertDraft, deleteExistingRefs]);
      }
      return orphanMediaAssets(db, draft.guildId, existingMediaFilenames, validMediaFilenames);
    },

    async claimDueDrafts(nowMs, limit) {
      const candidates = await db
        .select()
        .from(managedMessageDrafts)
        .where(
          and(
            eq(managedMessageDrafts.status, "scheduled"),
            lte(managedMessageDrafts.scheduledAtMs, nowMs),
            or(
              isNull(managedMessageDrafts.publicationClaimedAtMs),
              lte(managedMessageDrafts.publicationClaimedAtMs, nowMs - PUBLICATION_CLAIM_LEASE_MS),
            ),
          ),
        )
        .orderBy(asc(managedMessageDrafts.scheduledAtMs))
        .limit(limit)
        .all();
      const claims = [];
      for (const candidate of candidates) {
        const claimed = await db
          .update(managedMessageDrafts)
          .set({ publicationClaimedAtMs: nowMs })
          .where(
            and(
              eq(managedMessageDrafts.id, candidate.id),
              eq(managedMessageDrafts.status, "scheduled"),
              or(
                isNull(managedMessageDrafts.publicationClaimedAtMs),
                lte(
                  managedMessageDrafts.publicationClaimedAtMs,
                  nowMs - PUBLICATION_CLAIM_LEASE_MS,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (claimed) claims.push({ draft: mapDraftRow(claimed), claimedAtMs: nowMs });
      }
      return claims;
    },

    async recordDraftPublicationFailure(
      guildId,
      draftId,
      claimedAtMs,
      attemptCount,
      failureReason,
      retryAtMs,
      updatedAtMs,
    ) {
      const updated = await db
        .update(managedMessageDrafts)
        .set({
          status: retryAtMs === null ? "failed" : "scheduled",
          scheduledAtMs: retryAtMs,
          failureReason: retryAtMs === null ? failureReason : null,
          attemptCount,
          publicationClaimedAtMs: null,
          updatedAtMs,
        })
        .where(
          and(
            eq(managedMessageDrafts.guildId, guildId),
            eq(managedMessageDrafts.id, draftId),
            eq(managedMessageDrafts.publicationClaimedAtMs, claimedAtMs),
          ),
        )
        .returning()
        .get();
      return updated ? mapDraftRow(updated) : null;
    },

    async publishDraft(guildId, draftId, message, mediaFilenames = []) {
      const values = toRow(message);
      const validMediaFilenames: string[] = [];
      for (const filename of new Set(mediaFilenames)) {
        const asset = await db
          .select({ filename: managedMessageMediaAssets.filename })
          .from(managedMessageMediaAssets)
          .where(
            and(
              eq(managedMessageMediaAssets.guildId, guildId),
              eq(managedMessageMediaAssets.filename, filename),
              or(
                eq(managedMessageMediaAssets.status, "active"),
                eq(managedMessageMediaAssets.status, "pending_deletion"),
              ),
            ),
          )
          .limit(1)
          .get();
        if (asset) validMediaFilenames.push(filename);
      }
      const transferRefs =
        validMediaFilenames.length > 0
          ? db
              .insert(managedMessageMediaRefs)
              .values(
                validMediaFilenames.map((filename) => ({
                  guildId,
                  filename,
                  ownerType: "message",
                  ownerId: message.id,
                })),
              )
              .onConflictDoNothing()
          : null;
      const reactivateAssets =
        validMediaFilenames.length > 0
          ? reactivateMediaAssets(db, guildId, validMediaFilenames)
          : null;
      const insertMessage = db.insert(managedMessages).values(values);
      const deleteDraft = db
        .delete(managedMessageDrafts)
        .where(
          and(eq(managedMessageDrafts.guildId, guildId), eq(managedMessageDrafts.id, draftId)),
        );
      const deleteDraftRefs = db
        .delete(managedMessageMediaRefs)
        .where(
          and(
            eq(managedMessageMediaRefs.guildId, guildId),
            eq(managedMessageMediaRefs.ownerType, "draft"),
            eq(managedMessageMediaRefs.ownerId, draftId),
          ),
        );
      if (transferRefs && reactivateAssets) {
        await db.batch([
          insertMessage,
          deleteDraft,
          deleteDraftRefs,
          reactivateAssets,
          transferRefs,
        ]);
      } else {
        await db.batch([insertMessage, deleteDraft, deleteDraftRefs]);
      }
    },

    async markMissingByCanonicalMessage(guildId, channelId, messageId, updatedAtMs = Date.now()) {
      const updated = await db
        .update(managedMessages)
        .set({ status: "missing", updatedAtMs })
        .where(
          and(
            eq(managedMessages.guildId, guildId),
            eq(managedMessages.channelId, channelId),
            eq(managedMessages.messageId, messageId),
            eq(managedMessages.status, "published"),
          ),
        )
        .returning()
        .get();
      if (updated) return { message: mapRow(updated), changed: true };

      const existing = await db
        .select()
        .from(managedMessages)
        .where(
          and(
            eq(managedMessages.guildId, guildId),
            eq(managedMessages.channelId, channelId),
            eq(managedMessages.messageId, messageId),
          ),
        )
        .limit(1)
        .get();
      return existing && existing.status !== "unpublished" && existing.status !== "unpublishing"
        ? { message: mapRow(existing), changed: false }
        : null;
    },

    async claimCanonicalMessageDeleteAudit(
      guildId,
      channelId,
      messageId,
      claimedAtMs = Date.now(),
    ) {
      const eventKey = canonicalDeleteAuditEventKey(guildId, messageId);
      const claimed = await db
        .update(managedMessageAuditOutbox)
        .set({ claimedAtMs })
        .where(
          and(
            eq(managedMessageAuditOutbox.eventKey, eventKey),
            eq(managedMessageAuditOutbox.channelId, channelId),
            isNull(managedMessageAuditOutbox.deliveredAtMs),
            or(
              isNull(managedMessageAuditOutbox.claimedAtMs),
              lte(managedMessageAuditOutbox.claimedAtMs, claimedAtMs - AUDIT_CLAIM_LEASE_MS),
            ),
          ),
        )
        .returning()
        .get();
      if (claimed) {
        return { status: "claimed", event: mapAuditOutboxRow(claimed), claimedAtMs };
      }

      const existing = await db
        .select()
        .from(managedMessageAuditOutbox)
        .where(
          and(
            eq(managedMessageAuditOutbox.eventKey, eventKey),
            eq(managedMessageAuditOutbox.channelId, channelId),
          ),
        )
        .limit(1)
        .get();
      if (!existing) return { status: "missing" };
      return existing.deliveredAtMs === null ? { status: "busy" } : { status: "delivered" };
    },

    async markCanonicalMessageDeleteAuditDelivered(
      eventKey,
      claimedAtMs,
      deliveredAtMs = Date.now(),
    ) {
      await db
        .update(managedMessageAuditOutbox)
        .set({ deliveredAtMs, claimedAtMs: null })
        .where(
          and(
            eq(managedMessageAuditOutbox.eventKey, eventKey),
            eq(managedMessageAuditOutbox.claimedAtMs, claimedAtMs),
            isNull(managedMessageAuditOutbox.deliveredAtMs),
          ),
        )
        .run();
    },

    async releaseCanonicalMessageDeleteAuditClaim(eventKey, claimedAtMs) {
      await db
        .update(managedMessageAuditOutbox)
        .set({ claimedAtMs: null })
        .where(
          and(
            eq(managedMessageAuditOutbox.eventKey, eventKey),
            eq(managedMessageAuditOutbox.claimedAtMs, claimedAtMs),
            isNull(managedMessageAuditOutbox.deliveredAtMs),
          ),
        )
        .run();
    },

    async delete(guildId, id) {
      const existingMediaFilenames = await readOwnedMediaFilenames(db, guildId, "message", id);
      await db.batch([
        db
          .delete(managedMessages)
          .where(and(eq(managedMessages.guildId, guildId), eq(managedMessages.id, id))),
        deleteOwnedMediaReferences(db, guildId, "message", id),
        ...existingMediaFilenames.map((filename) => markOrphanedMediaAsset(db, guildId, filename)),
      ]);
      return existingMediaFilenames;
    },

    async deleteDraft(guildId, id) {
      const existingMediaFilenames = await readOwnedMediaFilenames(db, guildId, "draft", id);
      await db.batch([
        db
          .delete(managedMessageDrafts)
          .where(and(eq(managedMessageDrafts.guildId, guildId), eq(managedMessageDrafts.id, id))),
        deleteOwnedMediaReferences(db, guildId, "draft", id),
        ...existingMediaFilenames.map((filename) => markOrphanedMediaAsset(db, guildId, filename)),
      ]);
      return existingMediaFilenames;
    },
  };

  storeCache.set(database, store);
  return store;
}

function mapRow(row: ManagedMessageRow): ManagedMessage {
  return {
    id: row.id,
    guildId: row.guildId,
    internalName: row.internalName,
    channelId: row.channelId,
    messageId: row.messageId,
    embeds: parseEmbeds(row.embedsJson),
    buttons: parseButtons(row.buttonsJson),
    announcement: parseAnnouncement(row.announcementJson),
    status:
      row.status === "unpublishing"
        ? "unpublishing"
        : row.status === "unpublished"
          ? "unpublished"
          : row.status === "missing"
            ? "missing"
            : "published",
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toRow(message: ManagedMessage): ManagedMessageInsert {
  return {
    id: message.id,
    guildId: message.guildId,
    internalName: message.internalName,
    channelId: message.channelId,
    messageId: message.messageId,
    embedsJson: JSON.stringify(message.embeds),
    buttonsJson: JSON.stringify(message.buttons ?? []),
    announcementJson: JSON.stringify(message.announcement),
    status: message.status,
    createdAtMs: message.createdAtMs,
    updatedAtMs: message.updatedAtMs,
  };
}

function mapDraftRow(row: ManagedMessageDraftRow): ManagedMessageDraft {
  return {
    id: row.id,
    guildId: row.guildId,
    internalName: row.internalName,
    channelId: row.channelId,
    embeds: parseEmbeds(row.embedsJson),
    buttons: parseButtons(row.buttonsJson),
    announcement: parseAnnouncement(row.announcementJson),
    status: row.status === "scheduled" ? "scheduled" : row.status === "failed" ? "failed" : "draft",
    scheduledAtMs: row.scheduledAtMs,
    failureReason: row.failureReason,
    attemptCount: row.attemptCount,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toDraftRow(draft: ManagedMessageDraft): ManagedMessageDraftInsert {
  return {
    id: draft.id,
    guildId: draft.guildId,
    internalName: draft.internalName,
    channelId: draft.channelId,
    embedsJson: JSON.stringify(draft.embeds),
    buttonsJson: JSON.stringify(draft.buttons ?? []),
    announcementJson: JSON.stringify(draft.announcement),
    status: draft.status,
    scheduledAtMs: draft.scheduledAtMs,
    failureReason: draft.failureReason,
    attemptCount: draft.attemptCount,
    publicationClaimedAtMs: null,
    createdAtMs: draft.createdAtMs,
    updatedAtMs: draft.updatedAtMs,
  };
}

function mapAuditOutboxRow(row: ManagedMessageAuditOutboxRow) {
  return {
    eventKey: row.eventKey,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    internalName: row.internalName,
  };
}

function canonicalDeleteAuditEventKey(guildId: string, messageId: string): string {
  return `managed-message.deleted-out-of-band:${guildId}:${messageId}`;
}

function parseEmbeds(json: string): ManagedMessageEmbed[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map((embed) => ({
      ...(typeof embed.title === "string" ? { title: embed.title } : {}),
      description: typeof embed.description === "string" ? embed.description : "",
      ...(typeof embed.color === "number" ? { color: embed.color } : {}),
      ...(typeof embed.imageUrl === "string" ? { imageUrl: embed.imageUrl } : {}),
      ...(typeof embed.thumbnailUrl === "string" ? { thumbnailUrl: embed.thumbnailUrl } : {}),
      ...(typeof embed.footer === "string" ? { footer: embed.footer } : {}),
      fields: Array.isArray(embed.fields)
        ? embed.fields.filter(isRecord).map((field) => ({
            name: typeof field.name === "string" ? field.name : "",
            value: typeof field.value === "string" ? field.value : "",
            inline: field.inline === true,
          }))
        : [],
    }));
  } catch {
    return [];
  }
}

function parseAnnouncement(json: string): ManagedMessageAnnouncement {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) return defaultAnnouncement();
    return {
      roleIds: Array.isArray(parsed.roleIds)
        ? parsed.roleIds.filter((roleId): roleId is string => typeof roleId === "string")
        : [],
      everyone: parsed.everyone === true,
      here: parsed.here === true,
      notifyOnCreate: parsed.notifyOnCreate === true,
    };
  } catch {
    return defaultAnnouncement();
  }
}

function parseButtons(json: string): ManagedMessageLinkButton[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map((button) => ({
      label: typeof button.label === "string" ? button.label : "",
      url: typeof button.url === "string" ? button.url : "",
      ...(typeof button.emoji === "string" ? { emoji: button.emoji } : {}),
    }));
  } catch {
    return [];
  }
}

function defaultAnnouncement(): ManagedMessageAnnouncement {
  return { roleIds: [], everyone: false, here: false, notifyOnCreate: false };
}

async function readRegisteredMediaFilenames(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  filenames: string[],
): Promise<string[]> {
  const registered: string[] = [];
  for (const filename of new Set(filenames)) {
    const asset = await db
      .select({ filename: managedMessageMediaAssets.filename })
      .from(managedMessageMediaAssets)
      .where(
        and(
          eq(managedMessageMediaAssets.guildId, guildId),
          eq(managedMessageMediaAssets.filename, filename),
          or(
            eq(managedMessageMediaAssets.status, "active"),
            eq(managedMessageMediaAssets.status, "pending_deletion"),
          ),
        ),
      )
      .limit(1)
      .get();
    if (asset) registered.push(filename);
  }
  return registered;
}

function reactivateMediaAssets(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  filenames: string[],
) {
  return db
    .update(managedMessageMediaAssets)
    .set({ status: "active" })
    .where(
      and(
        eq(managedMessageMediaAssets.guildId, guildId),
        eq(managedMessageMediaAssets.status, "pending_deletion"),
        sql`${managedMessageMediaAssets.filename} IN (${sql.join(
          filenames.map((filename) => sql`${filename}`),
          sql`, `,
        )})`,
      ),
    );
}

function markOrphanedMediaAsset(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  filename: string,
) {
  return db
    .update(managedMessageMediaAssets)
    .set({ status: "pending_deletion" })
    .where(
      and(
        eq(managedMessageMediaAssets.guildId, guildId),
        eq(managedMessageMediaAssets.filename, filename),
        eq(managedMessageMediaAssets.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM managed_message_media_refs
          WHERE managed_message_media_refs.guild_id = ${guildId}
            AND managed_message_media_refs.filename = ${filename}
        )`,
      ),
    );
}

async function readOwnedMediaFilenames(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  ownerType: "draft" | "message",
  ownerId: string,
): Promise<string[]> {
  const rows = await db
    .select({ filename: managedMessageMediaRefs.filename })
    .from(managedMessageMediaRefs)
    .where(
      and(
        eq(managedMessageMediaRefs.guildId, guildId),
        eq(managedMessageMediaRefs.ownerType, ownerType),
        eq(managedMessageMediaRefs.ownerId, ownerId),
      ),
    )
    .all();
  return rows.map(({ filename }) => filename);
}

function deleteOwnedMediaReferences(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  ownerType: "draft" | "message",
  ownerId: string,
) {
  return db
    .delete(managedMessageMediaRefs)
    .where(
      and(
        eq(managedMessageMediaRefs.guildId, guildId),
        eq(managedMessageMediaRefs.ownerType, ownerType),
        eq(managedMessageMediaRefs.ownerId, ownerId),
      ),
    );
}

function insertOwnedMediaReferences(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  ownerType: "draft" | "message",
  ownerId: string,
  filenames: string[],
) {
  return db
    .insert(managedMessageMediaRefs)
    .values(filenames.map((filename) => ({ guildId, filename, ownerType, ownerId })))
    .onConflictDoNothing();
}

async function orphanMediaAssets(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  candidates: string[],
  retained: string[],
): Promise<string[]> {
  const retainedSet = new Set(retained);
  const orphaned: string[] = [];
  for (const filename of new Set(candidates)) {
    if (retainedSet.has(filename)) continue;
    const marked = await markOrphanedMediaAsset(db, guildId, filename).run();
    if (marked.meta.changes > 0) orphaned.push(filename);
  }
  return orphaned;
}
