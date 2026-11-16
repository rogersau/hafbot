import { and, desc, eq } from "drizzle-orm";
import { banCases, banCaseConfigs, banCaseSources } from "../db/app-schema";
import type {
  BanCase,
  BanCaseConfig,
  BanCaseSource,
  BanCaseStatus,
  SubjectIdentifierPlatform,
} from "../../../../src/types";
import type { BanCaseStore } from "../../../../src/runtime/contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type BanCaseConfigRow = typeof banCaseConfigs.$inferSelect;
type BanCaseConfigInsert = typeof banCaseConfigs.$inferInsert;
type BanCaseSourceRow = typeof banCaseSources.$inferSelect;
type BanCaseSourceInsert = typeof banCaseSources.$inferInsert;
type BanCaseRow = typeof banCases.$inferSelect;
type BanCaseInsert = typeof banCases.$inferInsert;

const banCaseStoreCache = new WeakMap<D1Database, BanCaseStore>();

export function createSqliteBanCaseStore(database: D1Database): BanCaseStore {
  const cached = banCaseStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: BanCaseStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(banCaseConfigs)
        .where(eq(banCaseConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? configRowToConfig(row) : null;
    },

    async upsertConfig(config) {
      await db
        .insert(banCaseConfigs)
        .values(configToRow(config))
        .onConflictDoUpdate({
          target: [banCaseConfigs.guildId],
          set: {
            enabled: config.enabled,
            forumChannelId: config.forumChannelId,
            modRoleIdsJson: JSON.stringify(config.modRoleIds),
            updatedAtMs: config.updatedAtMs,
          },
        })
        .run();
    },

    async readBanCaseSourceByPublicId(publicId) {
      const row = await db
        .select()
        .from(banCaseSources)
        .where(eq(banCaseSources.publicId, publicId))
        .limit(1)
        .get();
      return row ? sourceRowToSource(row) : null;
    },

    async listBanCaseSources(guildId) {
      const rows = await db
        .select()
        .from(banCaseSources)
        .where(eq(banCaseSources.guildId, guildId))
        .orderBy(desc(banCaseSources.updatedAtMs))
        .all();
      return rows.map(sourceRowToSource);
    },

    async upsertBanCaseSource(source) {
      await db
        .insert(banCaseSources)
        .values(sourceToRow(source))
        .onConflictDoUpdate({
          target: [banCaseSources.guildId, banCaseSources.sourceId],
          set: {
            name: source.name,
            enabled: source.enabled,
            platform: source.platform,
            pattern: source.pattern,
            flags: source.flags,
            subjectIdGroup: source.subjectIdGroup,
            nameGroup: source.nameGroup,
            reasonGroup: source.reasonGroup,
            updatedAtMs: source.updatedAtMs,
          },
        })
        .run();
    },

    async deleteBanCaseSource(body) {
      await db
        .delete(banCaseSources)
        .where(
          and(eq(banCaseSources.guildId, body.guildId), eq(banCaseSources.sourceId, body.sourceId)),
        )
        .run();
    },

    async createBanCase(banCase) {
      await db.insert(banCases).values(banCaseToRow(banCase)).run();
    },

    async readBanCase(guildId, caseId) {
      const row = await db
        .select()
        .from(banCases)
        .where(and(eq(banCases.guildId, guildId), eq(banCases.caseId, caseId)))
        .limit(1)
        .get();
      return row ? banCaseRowToBanCase(row) : null;
    },

    async readBanCaseBySubject(guildId, platform, id) {
      const row = await db
        .select()
        .from(banCases)
        .where(
          and(
            eq(banCases.guildId, guildId),
            eq(banCases.subjectPlatform, platform),
            eq(banCases.subjectId, id),
          ),
        )
        .limit(1)
        .get();
      return row ? banCaseRowToBanCase(row) : null;
    },

    async listBanCases(guildId) {
      const rows = await db
        .select()
        .from(banCases)
        .where(eq(banCases.guildId, guildId))
        .orderBy(desc(banCases.updatedAtMs))
        .all();
      return rows.map(banCaseRowToBanCase);
    },

    async updateBanCaseStatus(guildId, caseId, status, updatedAtMs) {
      const updated = await db
        .update(banCases)
        .set({ status, updatedAtMs })
        .where(and(eq(banCases.guildId, guildId), eq(banCases.caseId, caseId)))
        .returning()
        .get();
      return updated ? banCaseRowToBanCase(updated) : null;
    },

    async updateBanCaseThread(guildId, caseId, thread, updatedAtMs) {
      await db
        .update(banCases)
        .set({
          threadChannelId: thread.threadChannelId,
          threadMessageId: thread.threadMessageId,
          publicId: thread.publicId,
          updatedAtMs,
        })
        .where(and(eq(banCases.guildId, guildId), eq(banCases.caseId, caseId)))
        .run();
    },
  };

  banCaseStoreCache.set(database, store);
  return store;
}

function configRowToConfig(row: BanCaseConfigRow): BanCaseConfig {
  return {
    guildId: row.guildId,
    enabled: row.enabled,
    forumChannelId: row.forumChannelId,
    modRoleIds: JSON.parse(row.modRoleIdsJson) as string[],
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: BanCaseConfig): BanCaseConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled,
    forumChannelId: config.forumChannelId,
    modRoleIdsJson: JSON.stringify(config.modRoleIds),
    updatedAtMs: config.updatedAtMs,
  };
}

function sourceRowToSource(row: BanCaseSourceRow): BanCaseSource {
  return {
    guildId: row.guildId,
    sourceId: row.sourceId,
    publicId: row.publicId,
    name: row.name,
    enabled: row.enabled,
    platform: row.platform as BanCaseSource["platform"],
    pattern: row.pattern,
    flags: row.flags,
    subjectIdGroup: row.subjectIdGroup,
    nameGroup: row.nameGroup,
    reasonGroup: row.reasonGroup,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function sourceToRow(source: BanCaseSource): BanCaseSourceInsert {
  return {
    guildId: source.guildId,
    sourceId: source.sourceId,
    publicId: source.publicId,
    name: source.name,
    enabled: source.enabled,
    platform: source.platform,
    pattern: source.pattern,
    flags: source.flags,
    subjectIdGroup: source.subjectIdGroup,
    nameGroup: source.nameGroup,
    reasonGroup: source.reasonGroup,
    createdAtMs: source.createdAtMs,
    updatedAtMs: source.updatedAtMs,
  };
}

function banCaseRowToBanCase(row: BanCaseRow): BanCase {
  return {
    guildId: row.guildId,
    caseId: row.caseId,
    sourceId: row.sourceId,
    publicId: row.publicId,
    subject: {
      platform: row.subjectPlatform as SubjectIdentifierPlatform,
      id: row.subjectId,
    },
    username: row.username,
    status: row.status as BanCaseStatus,
    threadChannelId: row.threadChannelId,
    threadMessageId: row.threadMessageId,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function banCaseToRow(banCase: BanCase): BanCaseInsert {
  return {
    guildId: banCase.guildId,
    caseId: banCase.caseId,
    sourceId: banCase.sourceId,
    publicId: banCase.publicId,
    subjectPlatform: banCase.subject.platform,
    subjectId: banCase.subject.id,
    username: banCase.username,
    status: banCase.status,
    threadChannelId: banCase.threadChannelId,
    threadMessageId: banCase.threadMessageId,
    createdAtMs: banCase.createdAtMs,
    updatedAtMs: banCase.updatedAtMs,
  };
}
