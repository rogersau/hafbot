import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
export const commerceGameFulfillments = sqliteTable("commerce_game_fulfillments", {
  offeringId: text("offering_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  targetId: text("target_id").notNull(),
  physicalTarget: text("physical_target").notNull(),
  origin: text("origin").notNull(),
  data: text("data").notNull(),
});
export const commerceGameSelections = sqliteTable(
  "commerce_game_selections",
  {
    checkoutId: text("checkout_id").primaryKey(),
    offeringId: text("offering_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    data: text("data").notNull(),
  },
  (t) => [index("commerce_game_selection_assignment").on(t.assignmentId)],
);
export const commerceGameAssignments = sqliteTable(
  "commerce_game_assignments",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    physicalTarget: text("physical_target").notNull(),
    subject: text("subject").notNull(),
    slot: integer("slot"),
    generation: integer("generation").notNull(),
    revision: integer("revision").notNull(),
    nextAtMs: integer("next_at_ms").notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    uniqueIndex("commerce_game_subject").on(t.physicalTarget, t.subject),
    uniqueIndex("commerce_game_slot").on(t.physicalTarget, t.slot),
    index("commerce_game_due").on(t.nextAtMs),
    index("commerce_game_guild").on(t.guildId),
  ],
);
export const commerceGameAudit = sqliteTable(
  "commerce_game_audit",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    data: text("data").notNull(),
  },
  (t) => [index("commerce_game_audit_guild").on(t.guildId, t.createdAtMs)],
);
