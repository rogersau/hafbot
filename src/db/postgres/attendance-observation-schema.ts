import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { bigInteger } from "./column-types";

export const attendanceObservationRuns = pgTable(
  "attendance_observation_runs",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    targetId: text("target_id").notNull(),
    generation: bigInteger("generation").notNull(),
    activeTarget: text("active_target").unique(),
    revision: bigInteger("revision").notNull(),
    lease: text("lease"),
    nextAtMs: bigInteger("next_at_ms").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    deleteAtMs: bigInteger("delete_at_ms").notNull(),
    duplicates: bigInteger("duplicates").notNull().default(0),
    late: bigInteger("late").notNull().default(0),
    data: text("data").notNull(),
  },
  (t) => [
    index("attendance_observation_due").on(t.activeTarget, t.nextAtMs),
    index("attendance_observation_guild").on(t.guildId),
  ],
);
export const attendanceObservationSamples = pgTable(
  "attendance_observation_samples",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    guildId: text("guild_id").notNull(),
    targetId: text("target_id").notNull(),
    generation: bigInteger("generation").notNull(),
    slot: bigInteger("slot").notNull(),
    claimToken: text("claim_token").notNull(),
    nextAllowedAtMs: bigInteger("next_allowed_at_ms").notNull(),
    deleteAtMs: bigInteger("delete_at_ms").notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    uniqueIndex("attendance_observation_slot").on(t.targetId, t.generation, t.slot),
    index("attendance_observation_samples_run").on(t.runId, t.slot),
    index("attendance_observation_samples_guild").on(t.guildId),
    index("attendance_observation_samples_expiry").on(t.deleteAtMs),
  ],
);
export const attendanceObservationReports = pgTable(
  "attendance_observation_reports",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    data: text("data").notNull(),
  },
  (t) => [index("attendance_observation_reports_guild").on(t.guildId)],
);
