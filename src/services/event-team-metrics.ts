import type {
  EventRecord,
  EventSignup,
  EventTeamDeliveryOutboxRecord,
  EventTeamMembership,
} from "../types";
import type { EventTeamReadiness } from "./events-service";

export interface EventTeamOperationalEntry {
  event: EventRecord;
  signups: EventSignup[];
  memberships: EventTeamMembership[];
  readiness: EventTeamReadiness[];
  deliveries: EventTeamDeliveryOutboxRecord[];
  integrityWarnings: string[];
}

/** Content-free aggregate counters suitable for operational telemetry. */
export function summarizeEventTeamOperations(entries: EventTeamOperationalEntry[]) {
  const teamEvents = entries.filter((entry) => entry.event.participationMode === "team");
  const assigned = new Set(
    teamEvents.flatMap((entry) =>
      entry.memberships
        .filter((membership) => membership.leftAtMs === null)
        .map(
          (membership) =>
            `${membership.guildId}:${membership.eventId}:${membership.userId}:${membership.groupId}`,
        ),
    ),
  );
  const unassigned = teamEvents.flatMap((entry) =>
    entry.signups.filter(
      (signup) =>
        !assigned.has(`${signup.guildId}:${signup.eventId}:${signup.userId}:${signup.groupId}`),
    ),
  );
  return {
    teamEventCount: teamEvents.length,
    readyTeamCount: teamEvents.reduce(
      (count, entry) => count + entry.readiness.filter((item) => item.ready).length,
      0,
    ),
    incompleteTeamCount: teamEvents.reduce(
      (count, entry) => count + entry.readiness.filter((item) => !item.ready).length,
      0,
    ),
    unassignedConfirmedCount: unassigned.filter((signup) => signup.status === "confirmed").length,
    unassignedWaitlistedCount: unassigned.filter((signup) => signup.status === "waitlisted").length,
    deliveryFailureCount: teamEvents.reduce(
      (count, entry) =>
        count + entry.deliveries.filter((delivery) => delivery.status === "failed").length,
      0,
    ),
    integrityWarningCount: teamEvents.reduce(
      (count, entry) => count + entry.integrityWarnings.length,
      0,
    ),
  };
}
