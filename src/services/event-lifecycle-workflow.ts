import type { EventRecord, EventStatus } from "../types";

export type EventLifecycleAction = "publish" | "start" | "end" | "cancel" | "archive";
const transitions: Record<EventStatus, Partial<Record<EventLifecycleAction, EventStatus>>> = {
  draft: { publish: "scheduled", cancel: "cancelled" },
  scheduled: { publish: "scheduled", start: "live", end: "ended", cancel: "cancelled" },
  live: { end: "ended", cancel: "cancelled" },
  ended: { archive: "archived" },
  cancelled: { cancel: "cancelled", archive: "archived" },
  archived: {},
};

export function eventLifecycleTarget(
  status: EventStatus,
  action: EventLifecycleAction,
): EventStatus | null {
  return transitions[status][action] ?? null;
}

/** A missed start and end becomes ended directly; it must not briefly reopen signup. */
export function dueEventLifecycleAction(
  event: Pick<EventRecord, "status" | "startsAtMs" | "endsAtMs">,
  nowMs: number,
): "start" | "end" | null {
  if (event.status !== "scheduled" && event.status !== "live") return null;
  if (event.endsAtMs !== null && event.endsAtMs <= nowMs) return "end";
  return event.status === "scheduled" && event.startsAtMs <= nowMs ? "start" : null;
}

export function eventCanBeEdited(status: EventStatus): boolean {
  return status === "draft" || status === "scheduled" || status === "live";
}
