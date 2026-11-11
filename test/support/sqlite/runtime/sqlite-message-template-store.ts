import { and, asc, desc, eq } from "drizzle-orm";
import { messageTemplates } from "../db/app-schema";
import type { ManagedMessageEmbed, MessageTemplate } from "../../../../src/types";
import { isRecord } from "../../../../src/unknown-parse";
import type { MessageTemplateStore } from "../../../../src/runtime/contracts/message-template-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type MessageTemplateRow = typeof messageTemplates.$inferSelect;
const storeCache = new WeakMap<D1Database, MessageTemplateStore>();

export function createSqliteMessageTemplateStore(database: D1Database): MessageTemplateStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);
  const store: MessageTemplateStore = {
    async listByGuild(guildId) {
      const rows = await db
        .select()
        .from(messageTemplates)
        .where(eq(messageTemplates.guildId, guildId))
        .orderBy(asc(messageTemplates.internalName), desc(messageTemplates.updatedAtMs))
        .all();
      return rows.map(mapRow);
    },
    async listTicketReplyTemplates(guildId) {
      const rows = await db
        .select()
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.guildId, guildId),
            eq(messageTemplates.availableForTicketReplies, true),
          ),
        )
        .orderBy(asc(messageTemplates.internalName))
        .all();
      return rows.map(mapRow);
    },
    async readById(guildId, id) {
      const row = await db
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.guildId, guildId), eq(messageTemplates.id, id)))
        .limit(1)
        .get();
      return row ? mapRow(row) : null;
    },
    async countByGuild(guildId) {
      return (
        await db
          .select({ id: messageTemplates.id })
          .from(messageTemplates)
          .where(eq(messageTemplates.guildId, guildId))
          .all()
      ).length;
    },
    async upsert(template) {
      const values = {
        id: template.id,
        guildId: template.guildId,
        internalName: template.internalName,
        embedsJson: JSON.stringify(template.embeds),
        availableForTicketReplies: template.availableForTicketReplies,
        createdAtMs: template.createdAtMs,
        updatedAtMs: template.updatedAtMs,
      };
      await db
        .insert(messageTemplates)
        .values(values)
        .onConflictDoUpdate({
          target: messageTemplates.id,
          set: {
            guildId: values.guildId,
            internalName: values.internalName,
            embedsJson: values.embedsJson,
            availableForTicketReplies: values.availableForTicketReplies,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },
    async delete(guildId, id) {
      await db
        .delete(messageTemplates)
        .where(and(eq(messageTemplates.guildId, guildId), eq(messageTemplates.id, id)))
        .run();
    },
  };
  storeCache.set(database, store);
  return store;
}

function mapRow(row: MessageTemplateRow): MessageTemplate {
  return {
    id: row.id,
    guildId: row.guildId,
    internalName: row.internalName,
    embeds: parseEmbeds(row.embedsJson),
    availableForTicketReplies: row.availableForTicketReplies,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
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
