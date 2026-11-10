import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import type { EventRecord } from "../src/types";
import type { EventRecurrenceSummary } from "../src/event-recurrence";
import { withAdminDom } from "./support/admin-dom";
import { changeValue } from "./support/admin-dom-events";

function event(): EventRecord {
  const start = Date.now() + 86_400_000;
  return {
    guildId: "100",
    id: "event-1",
    templateId: null,
    title: "Weekly scrim",
    description: "Bring friends",
    status: "scheduled",
    channelId: "200",
    messageId: "500",
    threadId: null,
    startsAtMs: start,
    endsAtMs: start + 3_600_000,
    signupCutoffAtMs: start,
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: false,
    waitlistedMembersJoinThread: false,
    groups: [],
    reminders: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    publishedAtMs: 1,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
  };
}

test("recurrence controls submit the saved Event with cadence and Guild/workspace scope", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { EventRecurrenceControls } =
      await import("../src/admin/components/event-recurrence-controls");
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let refreshed = 0;
    globalThis.fetch = async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        series: {
          id: "series-1",
          sourceEventId: "event-1",
          title: "Weekly scrim",
          frequency: "daily",
          untilAtMs: null,
          nextStartsAtMs: 1000,
          nextPublishesAtMs: 500,
          status: "active",
          pendingEventId: null,
          lastEventId: "event-1",
          failureReason: null,
        },
      });
    };
    await render(
      <EventRecurrenceControls
        guildId="100"
        workspaceId="workspace-1"
        event={event()}
        series={[]}
        onChanged={async () => {
          refreshed++;
        }}
      />,
    );
    const frequency = container.querySelector("#event-recurrence-frequency")!;
    await act(async () => changeValue(frequency, "daily"));
    await click("Start repeating");
    assert.deepEqual(calls, [
      {
        path: "/admin/api/events/recurrences",
        body: {
          guildId: "100",
          workspaceId: "workspace-1",
          eventId: "event-1",
          frequency: "daily",
          untilAtMs: null,
        },
      },
    ]);
    assert.equal(refreshed, 1);
    assert.match(container.textContent ?? "", /fixed UTC time/);
    assert.match(container.textContent ?? "", /preceding occurrence ends/);
  });
});

test("stopping a series requires the concrete stop confirmation and preserves Event actions", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    const { EventRecurrenceControls } =
      await import("../src/admin/components/event-recurrence-controls");
    const source = event();
    const series: EventRecurrenceSummary = {
      id: "series-1",
      sourceEventId: source.id,
      title: source.title,
      frequency: "weekly",
      untilAtMs: null,
      nextStartsAtMs: source.startsAtMs + 7 * 86_400_000,
      nextPublishesAtMs: source.endsAtMs!,
      status: "active",
      pendingEventId: null,
      lastEventId: source.id,
      failureReason: null,
    };
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      paths.push(String(input));
      assert.equal(JSON.parse(String(init?.body)).seriesId, series.id);
      return Response.json({ series: { ...series, status: "stopped" } });
    };
    await render(
      <EventRecurrenceControls
        guildId="100"
        workspaceId="workspace-1"
        event={source}
        series={[series]}
        onChanged={async () => {}}
      />,
    );
    await click("Stop series");
    assert.equal(paths.length, 0);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog, "Stopping a series must open the confirmation dialog.");
    assert.match(dialog?.textContent ?? "", /Events already created, their signups/);
    const confirm = [...dialog!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Stop series",
    )!;
    await act(async () => confirm.click());
    assert.deepEqual(paths, ["/admin/api/events/recurrences/stop"]);
    assert.equal(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Start repeating",
      )?.disabled,
      true,
    );
  });
});
