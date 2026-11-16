import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { adminFeedback } from "../../db/postgres/app-schema";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { AdminFeedbackStore } from "../contracts/admin-feedback-store";

export function createPostgresAdminFeedbackStore(
  database: PostgresDatabaseCapability,
): AdminFeedbackStore {
  const db = database.drizzle;
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
        .execute();
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
        .execute();
      return rows[0]?.createdAtMs ?? null;
    },
    async insert(record) {
      await db.insert(adminFeedback).values(record).execute();
    },
    async updateNotification(id, state, errorCode = null) {
      await db
        .update(adminFeedback)
        .set({ notificationState: state, notificationErrorCode: errorCode })
        .where(eq(adminFeedback.id, id))
        .execute();
    },
    async purgeExpired(beforeMs, limit) {
      const rows = await db
        .select({ id: adminFeedback.id })
        .from(adminFeedback)
        .where(lt(adminFeedback.createdAtMs, beforeMs))
        .orderBy(asc(adminFeedback.createdAtMs))
        .limit(limit)
        .execute();
      if (!rows.length) return 0;
      await db
        .delete(adminFeedback)
        .where(
          inArray(
            adminFeedback.id,
            rows.map((row) => row.id),
          ),
        )
        .execute();
      return rows.length;
    },
  };
  return store;
}
