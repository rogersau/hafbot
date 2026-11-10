import {
  eventRecurrenceFrequencySchema,
  eventRecurrenceIntervalMs,
  eventRecurrenceSummary,
  type EventRecurrenceFrequency,
  type EventRecurrenceRecord,
} from "../event-recurrence";
import type { EventRecord } from "../types";
import type { EventRecurrenceStore } from "../runtime/contracts/event-recurrence-store";
import type { CreateEventInput } from "./events-service";

export class EventRecurrenceError extends Error {}

export interface EventRecurrenceHost {
  readEvent(guildId: string, eventId: string): Promise<EventRecord | null>;
  cleanupPreviousAccess(event: EventRecord): Promise<void>;
  createEvent(input: CreateEventInput, id: string): Promise<EventRecord>;
  publishEvent(input: {
    guildId: string;
    eventId: string;
    actorUserId: string;
  }): Promise<EventRecord>;
  cancelEvent(input: {
    guildId: string;
    eventId: string;
    actorUserId: string;
  }): Promise<EventRecord>;
  isPaidPlan(guildId: string): Promise<boolean>;
}

const reviewPublication =
  "Automatic publication needs staff review. Inspect the generated Event and Discord channel, then start a new series from a reviewed published Event.";
const reviewCleanup =
  "Previous Event access cleanup could not be confirmed. Inspect its signup roles and thread membership before starting a new series from a reviewed published Event.";

export class EventRecurrenceService {
  constructor(
    private readonly store: EventRecurrenceStore,
    private readonly host: EventRecurrenceHost,
    private readonly clock: () => number = Date.now,
  ) {}

  async list(guildId: string) {
    return (await this.store.listByGuild(guildId)).map(eventRecurrenceSummary);
  }

  async start(input: {
    guildId: string;
    eventId: string;
    frequency: EventRecurrenceFrequency;
    untilAtMs: number | null;
    actorUserId: string;
  }) {
    if (!(await this.host.isPaidPlan(input.guildId)))
      throw new EventRecurrenceError("Events requires a paid plan.");
    const frequency = eventRecurrenceFrequencySchema.parse(input.frequency);
    const source = await this.host.readEvent(input.guildId, input.eventId);
    if (!source?.messageId || !["scheduled", "live"].includes(source.status))
      throw new EventRecurrenceError("Publish an upcoming or live Event before starting a series.");
    const interval = eventRecurrenceIntervalMs(frequency);
    if (
      source.endsAtMs === null ||
      source.endsAtMs <= source.startsAtMs ||
      source.endsAtMs >= source.startsAtMs + interval
    )
      throw new EventRecurrenceError(
        "A recurring Event needs an end time after its start and within the selected daily or weekly interval.",
      );
    const nextStartsAtMs = source.startsAtMs + interval;
    if (
      input.untilAtMs !== null &&
      (!Number.isSafeInteger(input.untilAtMs) ||
        input.untilAtMs < futureOccurrence(nextStartsAtMs, interval, this.clock()) ||
        input.untilAtMs > 8_640_000_000_000_000)
    )
      throw new EventRecurrenceError(
        "The final start time must allow at least one future occurrence.",
      );
    const existing = await this.store.readForEvent(input.guildId, input.eventId);
    if (existing) {
      if (
        existing.sourceEventId === input.eventId &&
        existing.status === "active" &&
        existing.frequency === frequency &&
        existing.untilAtMs === input.untilAtMs
      )
        return eventRecurrenceSummary(existing);
      throw new EventRecurrenceError(
        "This Event already belongs to a series. Manage that series or start from a new Event.",
      );
    }
    const now = this.clock();
    const record: EventRecurrenceRecord = {
      id: crypto.randomUUID(),
      guildId: input.guildId,
      sourceEventId: source.id,
      title: source.title,
      snapshot: structuredClone(source),
      frequency,
      untilAtMs: input.untilAtMs,
      nextStartsAtMs,
      nextPublishesAtMs: source.endsAtMs,
      status: "active",
      pendingEventId: null,
      publicationAttemptedAtMs: null,
      lastEventId: source.id,
      failureReason: null,
      createdByUserId: input.actorUserId,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const saved = await this.store.create(record);
    if (
      saved.frequency !== frequency ||
      saved.untilAtMs !== input.untilAtMs ||
      saved.status !== "active"
    )
      throw new EventRecurrenceError(
        "A different series was saved for this Event. Reload the page.",
      );
    return eventRecurrenceSummary(saved);
  }

  async stop(guildId: string, seriesId: string) {
    const result = await this.store.stop(guildId, seriesId, this.clock());
    if (!result)
      throw new EventRecurrenceError(
        "The series is missing or an occurrence is being published. Refresh and try again shortly.",
      );
    return eventRecurrenceSummary(result);
  }

  async processDue(nowMs: number): Promise<number> {
    let published = 0;
    for (const candidate of await this.store.listDue(nowMs, 50)) {
      if (!(await this.host.isPaidPlan(candidate.guildId))) continue;
      const token = crypto.randomUUID();
      const lease = () => ({ token, nowMs: this.clock() });
      if (!(await this.store.claim(candidate, lease()))) continue;
      let record = (await this.store.read(candidate.guildId, candidate.id))!;
      try {
        const interval = eventRecurrenceIntervalMs(record.frequency);
        if (!record.pendingEventId) {
          const previous = await this.host.readEvent(record.guildId, record.lastEventId);
          if (!previous || !["ended", "cancelled", "archived"].includes(previous.status)) continue;
          try {
            await this.host.cleanupPreviousAccess(previous);
          } catch {
            this.requireWrite(await this.store.fail(record, reviewCleanup, lease()));
            continue;
          }
        }
        if (!record.pendingEventId) {
          const startsAtMs = futureOccurrence(record.nextStartsAtMs, interval, nowMs);
          if (record.untilAtMs !== null && startsAtMs > record.untilAtMs) {
            this.requireWrite(await this.store.finish(record, startsAtMs, true, lease()));
            continue;
          }
          const id = await occurrenceId(record.id, startsAtMs);
          this.requireWrite(await this.store.prepareOccurrence(record, startsAtMs, id, lease()));
          record = {
            ...record,
            nextStartsAtMs: startsAtMs,
            pendingEventId: id,
            publicationAttemptedAtMs: null,
          };
        }
        let event = await this.host.readEvent(record.guildId, record.pendingEventId!);
        if (record.publicationAttemptedAtMs !== null) {
          if (!event?.messageId || (event.threadEnabled && !event.threadId)) {
            this.requireWrite(await this.store.fail(record, reviewPublication, lease()));
            continue;
          }
          this.requireWrite(
            await this.store.finish(
              record,
              record.nextStartsAtMs + interval,
              record.untilAtMs !== null && record.nextStartsAtMs + interval > record.untilAtMs,
              lease(),
            ),
          );
          continue;
        }
        if (!event)
          event = await this.host.createEvent(occurrenceInput(record), record.pendingEventId!);
        this.requireWrite(
          await this.store.linkOccurrence(record.guildId, record.id, event.id, lease()),
        );
        if (!event.messageId && (event.status !== "draft" || event.startsAtMs <= nowMs)) {
          if (event.status === "draft")
            await this.host.cancelEvent({
              guildId: record.guildId,
              eventId: event.id,
              actorUserId: record.createdByUserId,
            });
          const next = futureOccurrence(record.nextStartsAtMs + interval, interval, nowMs);
          this.requireWrite(
            await this.store.finish(
              record,
              next,
              record.untilAtMs !== null && next > record.untilAtMs,
              lease(),
            ),
          );
          continue;
        }
        if (!(await this.host.isPaidPlan(record.guildId))) continue;
        if (!event.messageId) {
          this.requireWrite(await this.store.markPublicationAttempted(record, lease()));
          record = { ...record, publicationAttemptedAtMs: this.clock() };
          event = await this.host.publishEvent({
            guildId: record.guildId,
            eventId: event.id,
            actorUserId: record.createdByUserId,
          });
          published += 1;
        }
        if (event.threadEnabled && !event.threadId)
          throw new EventRecurrenceError(reviewPublication);
        const next = record.nextStartsAtMs + interval;
        this.requireWrite(
          await this.store.finish(
            record,
            next,
            record.untilAtMs !== null && next > record.untilAtMs,
            lease(),
          ),
        );
      } catch {
        await this.store.fail(record, reviewPublication, lease());
      } finally {
        await this.store.release(candidate.guildId, candidate.id, token);
      }
    }
    return published;
  }

  private requireWrite(ok: boolean) {
    if (!ok) throw new EventRecurrenceError("The Event series update lease expired.");
  }
}

function futureOccurrence(startsAtMs: number, interval: number, nowMs: number): number {
  return startsAtMs > nowMs
    ? startsAtMs
    : startsAtMs + (Math.floor((nowMs - startsAtMs) / interval) + 1) * interval;
}

async function occurrenceId(seriesId: string, startsAtMs: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${seriesId}:${startsAtMs}`),
  );
  return `event-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24)}`;
}

function occurrenceInput(series: EventRecurrenceRecord): CreateEventInput {
  const source = series.snapshot;
  const delta = series.nextStartsAtMs - source.startsAtMs;
  return {
    guildId: series.guildId,
    templateId: source.templateId,
    title: source.title,
    description: source.description,
    channelId: source.channelId,
    startsAtMs: series.nextStartsAtMs,
    endsAtMs: source.endsAtMs === null ? null : source.endsAtMs + delta,
    signupCutoffAtMs: source.signupCutoffAtMs + delta,
    signupMode: source.signupMode,
    participationMode: source.participationMode,
    requiredTeamSize: source.requiredTeamSize,
    threadEnabled: source.threadEnabled,
    waitlistedMembersJoinThread: source.waitlistedMembersJoinThread,
    groups: structuredClone(source.groups),
    reminders: source.reminders.map((reminder) => ({
      ...structuredClone(reminder),
      sentAtMs: null,
    })),
  };
}
