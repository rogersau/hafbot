import { z } from "zod";
import type { EventRecord } from "./types";

export const EVENT_RECURRENCE_DAY_MS = 24 * 60 * 60 * 1000;
export const eventRecurrenceFrequencySchema = z.enum(["daily", "weekly"]);
export type EventRecurrenceFrequency = z.infer<typeof eventRecurrenceFrequencySchema>;
export const eventRecurrenceSummarySchema = z.object({
  id: z.string(),
  sourceEventId: z.string(),
  title: z.string(),
  frequency: eventRecurrenceFrequencySchema,
  untilAtMs: z.number().nullable(),
  nextStartsAtMs: z.number(),
  nextPublishesAtMs: z.number(),
  status: z.enum(["active", "stopped", "completed", "failed"]),
  pendingEventId: z.string().nullable(),
  lastEventId: z.string(),
  failureReason: z.string().nullable(),
});
export type EventRecurrenceSummary = z.infer<typeof eventRecurrenceSummarySchema>;

export interface EventRecurrenceRecord extends EventRecurrenceSummary {
  guildId: string;
  snapshot: EventRecord;
  createdByUserId: string;
  createdAtMs: number;
  updatedAtMs: number;
  publicationAttemptedAtMs: number | null;
}

export function eventRecurrenceIntervalMs(frequency: EventRecurrenceFrequency): number {
  return EVENT_RECURRENCE_DAY_MS * (frequency === "daily" ? 1 : 7);
}

export function eventRecurrenceSummary(record: EventRecurrenceRecord): EventRecurrenceSummary {
  return eventRecurrenceSummarySchema.parse(record);
}
