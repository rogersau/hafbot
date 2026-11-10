import type { EventRecurrenceRecord } from "../../event-recurrence";

export interface EventRecurrenceLease {
  token: string;
  nowMs: number;
}

export interface EventRecurrenceStore {
  listByGuild(guildId: string): Promise<EventRecurrenceRecord[]>;
  read(guildId: string, seriesId: string): Promise<EventRecurrenceRecord | null>;
  readForEvent(guildId: string, eventId: string): Promise<EventRecurrenceRecord | null>;
  create(record: EventRecurrenceRecord): Promise<EventRecurrenceRecord>;
  listDue(nowMs: number, limit: number): Promise<EventRecurrenceRecord[]>;
  claim(record: EventRecurrenceRecord, lease: EventRecurrenceLease): Promise<boolean>;
  prepareOccurrence(
    record: EventRecurrenceRecord,
    startsAtMs: number,
    eventId: string,
    lease: EventRecurrenceLease,
  ): Promise<boolean>;
  linkOccurrence(
    guildId: string,
    seriesId: string,
    eventId: string,
    lease: EventRecurrenceLease,
  ): Promise<boolean>;
  markPublicationAttempted(
    record: EventRecurrenceRecord,
    lease: EventRecurrenceLease,
  ): Promise<boolean>;
  finish(
    record: EventRecurrenceRecord,
    nextStartsAtMs: number,
    completed: boolean,
    lease: EventRecurrenceLease,
  ): Promise<boolean>;
  fail(
    record: EventRecurrenceRecord,
    reason: string,
    lease: EventRecurrenceLease,
  ): Promise<boolean>;
  stop(guildId: string, seriesId: string, nowMs: number): Promise<EventRecurrenceRecord | null>;
  release(guildId: string, seriesId: string, token: string): Promise<void>;
}
