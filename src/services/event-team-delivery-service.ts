import { buildEventMessage, type EventTeamMessageAggregate } from "../events";
import { DiscordApiError } from "../discord/client";
import type { CreateChannelMessageInput } from "../discord/messages";
import type {
  EventRecord,
  EventSignup,
  EventTeam,
  EventTeamDeliveryOutboxRecord,
  EventTeamMembership,
} from "../types";
import { isRecord } from "../unknown-parse";

/** The durable operations required by the delivery worker.
 *
 * `claimEventTeamDelivery` must be an atomic compare-and-set. It should return
 * the claimed record (normally with `status: "processing"`) or `null` when a
 * different worker already owns it, it is no longer due, or it is delivered.
 */
export interface EventTeamDeliveryStore {
  listDueEventTeamDeliveries(input: {
    nowMs: number;
    limit: number;
  }): Promise<EventTeamDeliveryOutboxRecord[]>;
  claimEventTeamDelivery(input: {
    record: EventTeamDeliveryOutboxRecord;
    nowMs: number;
    leaseMs: number;
  }): Promise<EventTeamDeliveryOutboxRecord | null>;
  updateEventTeamDelivery(
    record: EventTeamDeliveryOutboxRecord,
    expected?: EventTeamDeliveryOutboxRecord,
  ): Promise<void>;
  readEvent(guildId: string, eventId: string): Promise<EventRecord | null>;
  listSignups(guildId: string, eventId: string): Promise<EventSignup[]>;
  listEventTeams(guildId: string, eventId: string): Promise<EventTeam[]>;
  listActiveEventTeamMemberships(guildId: string, eventId: string): Promise<EventTeamMembership[]>;
}

export interface EventTeamDeliveryDiscord {
  sendUserDm(userId: string, body: CreateChannelMessageInput): Promise<unknown>;
  editChannelMessage(
    channelId: string,
    messageId: string,
    body: CreateChannelMessageInput,
  ): Promise<unknown>;
}

export interface EventTeamDeliveryServiceOptions {
  store: EventTeamDeliveryStore;
  discord: EventTeamDeliveryDiscord;
  leaseMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Content-free aggregate telemetry. Observer failures never interrupt delivery. */
  observeMetrics?: (metrics: EventTeamDeliveryProcessResult) => void | Promise<void>;
}

export interface EventTeamDeliveryProcessResult {
  listed: number;
  claimed: number;
  skipped: number;
  delivered: number;
  retried: number;
  failed: number;
}

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 30_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30 * 60_000;

/** Delivers Event Team projections without making delivery part of domain writes. */
export class EventTeamDeliveryService {
  private readonly leaseMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(private readonly options: EventTeamDeliveryServiceOptions) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  }

  async processDue(nowMs = Date.now(), limit = 100): Promise<EventTeamDeliveryProcessResult> {
    const due = await this.options.store.listDueEventTeamDeliveries({
      nowMs,
      limit: Math.max(1, Math.min(limit, 500)),
    });
    const result: EventTeamDeliveryProcessResult = {
      listed: due.length,
      claimed: 0,
      skipped: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
    };

    for (const record of due) {
      const claimed = await this.options.store.claimEventTeamDelivery({
        record,
        nowMs,
        leaseMs: this.leaseMs,
      });
      if (!claimed || claimed.status === "delivered" || claimed.deliveredAtMs !== null) {
        result.skipped += 1;
        continue;
      }
      result.claimed += 1;
      const outcome = await this.deliver(claimed, nowMs);
      if (outcome === "delivered") result.delivered += 1;
      else if (outcome === "retried") result.retried += 1;
      else result.failed += 1;
    }
    try {
      await this.options.observeMetrics?.({ ...result });
    } catch {
      // Operational telemetry is intentionally best effort.
    }
    return result;
  }

  private async deliver(
    record: EventTeamDeliveryOutboxRecord,
    nowMs: number,
  ): Promise<"delivered" | "retried" | "failed"> {
    try {
      if (record.kind === "notification") await this.deliverNotification(record);
      else await this.deliverCanonicalRefresh(record);

      await this.options.store.updateEventTeamDelivery(
        {
          ...record,
          status: "delivered",
          attemptCount: record.attemptCount + 1,
          lastError: null,
          terminalFailureReason: null,
          updatedAtMs: nowMs,
          deliveredAtMs: nowMs,
        },
        record,
      );
      return "delivered";
    } catch (error) {
      const attemptCount = record.attemptCount + 1;
      const diagnosis = diagnoseDeliveryError(error);
      const terminal = diagnosis.terminal || attemptCount >= Math.max(1, record.maxAttempts);
      const next = terminal
        ? {
            ...record,
            status: "failed" as const,
            attemptCount,
            lastError: diagnosis.message,
            terminalFailureReason: diagnosis.reason,
            nextAttemptAtMs: nowMs,
            updatedAtMs: nowMs,
            deliveredAtMs: null,
          }
        : {
            ...record,
            status: "pending" as const,
            attemptCount,
            lastError: diagnosis.message,
            terminalFailureReason: null,
            nextAttemptAtMs: nowMs + this.retryDelayMs(attemptCount),
            updatedAtMs: nowMs,
            deliveredAtMs: null,
          };
      await this.options.store.updateEventTeamDelivery(next, record);
      return terminal ? "failed" : "retried";
    }
  }

  private async deliverNotification(record: EventTeamDeliveryOutboxRecord): Promise<void> {
    const payload = asRecord(record.payload);
    const recipient = readString(
      payload?.recipientUserId ?? payload?.userId ?? payload?.targetUserId,
    );
    if (!recipient) {
      // A malformed notification is diagnosed and stopped rather than retried forever.
      throw new EventTeamDeliveryTerminalError("notification_recipient_missing");
    }
    await this.options.discord.sendUserDm(recipient, {
      content:
        "You have an update about an Event Team. Open the Event Team controls in Discord to review it.",
      allowed_mentions: { parse: [] },
    });
  }

  private async deliverCanonicalRefresh(record: EventTeamDeliveryOutboxRecord): Promise<void> {
    const event = await this.options.store.readEvent(record.guildId, record.eventId);
    if (!event) throw new EventTeamDeliveryTerminalError("event_not_found");
    if (!event.messageId) return;

    const [signups, teams, memberships] = await Promise.all([
      this.options.store.listSignups(record.guildId, record.eventId),
      this.options.store.listEventTeams(record.guildId, record.eventId),
      this.options.store.listActiveEventTeamMemberships(record.guildId, record.eventId),
    ]);
    const aggregate = buildTeamAggregate(event, signups, teams, memberships);
    await this.options.discord.editChannelMessage(
      event.channelId,
      event.messageId,
      buildEventMessage(event, signups, aggregate),
    );
  }

  private retryDelayMs(attemptCount: number): number {
    return Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** Math.max(0, attemptCount - 1),
    );
  }
}

export class EventTeamDeliveryTerminalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EventTeamDeliveryTerminalError";
  }
}

function buildTeamAggregate(
  event: EventRecord,
  signups: EventSignup[],
  teams: EventTeam[],
  memberships: EventTeamMembership[],
): EventTeamMessageAggregate {
  const activeTeams = teams.filter((team) => team.status === "active");
  const activeMemberships = memberships.filter((membership) => membership.leftAtMs === null);
  const assigned = new Set(
    activeMemberships.map((membership) => `${membership.userId}:${membership.groupId}`),
  );
  const eligibleSignups = signups.filter(
    (signup) => signup.status === "confirmed" || signup.status === "waitlisted",
  );
  const required = event.requiredTeamSize ?? 0;
  const readyTeamCount =
    required > 0
      ? activeTeams.filter((team) => {
          const roster = activeMemberships.filter((membership) => membership.teamId === team.id);
          return (
            roster.length === required &&
            roster.every((membership) =>
              signups.some(
                (signup) =>
                  signup.userId === membership.userId &&
                  signup.groupId === team.groupId &&
                  signup.status === "confirmed",
              ),
            )
          );
        }).length
      : 0;
  return {
    teamCount: activeTeams.length,
    readyTeamCount,
    incompleteTeamCount: Math.max(0, activeTeams.length - readyTeamCount),
    unassignedCount: eligibleSignups.filter(
      (signup) => !assigned.has(`${signup.userId}:${signup.groupId}`),
    ).length,
    assignedCount: activeMemberships.length,
    capacity: activeTeams.length * required,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function diagnoseDeliveryError(error: unknown): {
  terminal: boolean;
  reason: string;
  message: string;
} {
  if (error instanceof EventTeamDeliveryTerminalError) {
    return { terminal: true, reason: error.reason, message: error.message };
  }
  if (isDiscordForbidden(error)) {
    return { terminal: true, reason: "discord_forbidden", message: errorMessage(error) };
  }
  return { terminal: false, reason: "", message: errorMessage(error) };
}

function isDiscordForbidden(error: unknown): boolean {
  if (error instanceof DiscordApiError) return error.status === 403;
  if (!isRecord(error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 403) return true;
  const text = errorMessage(error).toLocaleLowerCase();
  return text.includes("dm forbidden") || text.includes("cannot send messages to this user");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
