import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { adminFeedback } from "../db/app-schema";
import { createD1DrizzleDatabase } from "./drizzle-db";
import type { AdminFeedbackStore } from "./contracts/admin-feedback-store";

const cache = new WeakMap<D1Database, AdminFeedbackStore>();

export function createCloudflareAdminFeedbackStore(database: D1Database): AdminFeedbackStore {
  const cached = cache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);
  const store: AdminFeedbackStore = {
    async countRecentByReporter(reporterUserId, sinceMs) {
      const rows = await db
        .select({ id: adminFeedback.id })
        .from(adminFeedback)
        .where(
          and(
            eq(adminFeedback.reporterUserId, reporterUserId),
            gte(adminFeedback.createdAtMs, sinceMs),
          ),
        )
        .all();
      return rows.length;
    },
    async readOldestRecentCreatedAtMs(reporterUserId, sinceMs) {
      const rows = await db
        .select({ createdAtMs: adminFeedback.createdAtMs })
        .from(adminFeedback)
        .where(
          and(
            eq(adminFeedback.reporterUserId, reporterUserId),
            gte(adminFeedback.createdAtMs, sinceMs),
          ),
        )
        .orderBy(asc(adminFeedback.createdAtMs))
        .limit(1)
        .all();
      return rows[0]?.createdAtMs ?? null;
    },
    async insert(record) {
      await db.insert(adminFeedback).values(record).run();
    },
    async updateNotification(id, state, errorCode = null) {
      await db
        .update(adminFeedback)
        .set({ notificationState: state, notificationErrorCode: errorCode })
        .where(eq(adminFeedback.id, id))
        .run();
    },
    async purgeExpired(beforeMs, limit) {
      const rows = await db
        .select({ id: adminFeedback.id })
        .from(adminFeedback)
        .where(lt(adminFeedback.createdAtMs, beforeMs))
        .orderBy(asc(adminFeedback.createdAtMs))
        .limit(limit)
        .all();
      if (!rows.length) return 0;
      await db
        .delete(adminFeedback)
        .where(
          inArray(
            adminFeedback.id,
            rows.map((row) => row.id),
          ),
        )
        .run();
      return rows.length;
    },
  };
  cache.set(database, store);
  return store;
}
