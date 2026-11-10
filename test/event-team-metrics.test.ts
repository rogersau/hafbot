import assert from "node:assert/strict";
import test from "node:test";

import { summarizeEventTeamOperations } from "../src/services/event-team-metrics";
import type { EventRecord } from "../src/types";

test("Event Team operational metrics contain aggregate counters and no content identifiers", () => {
  const event = {
    guildId: "private-guild",
    id: "private-event",
    participationMode: "team",
  } as EventRecord;
  const result = summarizeEventTeamOperations([
    {
      event,
      signups: [
        {
          guildId: event.guildId,
          eventId: event.id,
          userId: "private-user",
          groupId: "private-group",
          status: "waitlisted",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
      memberships: [],
      readiness: [
        {
          teamId: "private-team",
          rosterCount: 1,
          confirmedCount: 0,
          openPlaces: 1,
          ready: false,
          reasons: ["member_waitlisted"],
        },
      ],
      deliveries: [
        {
          guildId: event.guildId,
          eventId: event.id,
          id: "private-delivery",
          kind: "notification",
          dedupeKey: "private-dedupe",
          payload: { content: "private-content" },
          status: "failed",
          attemptCount: 5,
          maxAttempts: 5,
          lastError: "private-error",
          terminalFailureReason: "discord_forbidden",
          nextAttemptAtMs: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          deliveredAtMs: null,
        },
      ],
      integrityWarnings: ["private-warning"],
    },
  ]);

  assert.deepEqual(result, {
    teamEventCount: 1,
    readyTeamCount: 0,
    incompleteTeamCount: 1,
    unassignedConfirmedCount: 0,
    unassignedWaitlistedCount: 1,
    deliveryFailureCount: 1,
    integrityWarningCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
