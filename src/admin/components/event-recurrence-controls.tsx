import { useState } from "react";
import type { EventRecord } from "../../types";
import type { EventRecurrenceFrequency, EventRecurrenceSummary } from "../../event-recurrence";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { eventsClient } from "../generated/admin-client/events";

export function EventRecurrenceControls({
  guildId,
  workspaceId,
  event,
  series,
  disabled,
  onChanged,
}: {
  guildId: string;
  workspaceId: string;
  event: EventRecord | null;
  series: EventRecurrenceSummary[];
  disabled?: boolean;
  onChanged(): Promise<void>;
}) {
  const [frequency, setFrequency] = useState<EventRecurrenceFrequency>("weekly");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialog, confirm } = useConfirmDialog();
  const existing = series.find(
    (item) =>
      item.sourceEventId === event?.id ||
      item.lastEventId === event?.id ||
      item.pendingEventId === event?.id,
  );
  const canStart =
    event?.messageId &&
    (event.status === "scheduled" || event.status === "live") &&
    event.endsAtMs !== null &&
    !existing;

  async function mutate(operation: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recurring Events could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const untilAtMs = until ? new Date(until).getTime() : null;
    if (untilAtMs !== null && !Number.isFinite(untilAtMs)) {
      setError("Choose a valid final start date and time.");
      return;
    }
    if (!event) return;
    await mutate(() =>
      eventsClient.startRecurrence({
        guildId,
        ...(workspaceId ? { workspaceId } : {}),
        eventId: event.id,
        frequency,
        untilAtMs,
      }),
    );
  }

  return (
    <SettingsBlock>
      {dialog}
      <SectionHeader
        title="Recurring Events"
        description="Publish the next daily or weekly occurrence after the preceding occurrence ends and its access is cleaned up. Every occurrence has fresh signups, teams, and reminder history."
      />
      <p className="text-sm text-muted-foreground">
        The series copies the saved Event by value and repeats at a fixed UTC time. Local times can
        shift with daylight saving. Changes to an individual Event or template do not change the
        series.
      </p>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <FormField label="Repeat" htmlFor="event-recurrence-frequency">
          <select
            id="event-recurrence-frequency"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={frequency}
            disabled={disabled || busy || Boolean(existing)}
            onChange={(change) => setFrequency(change.target.value as EventRecurrenceFrequency)}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>
        </FormField>
        <FormField
          label="Final start time (optional)"
          htmlFor="event-recurrence-until"
          hint="The final occurrence may start at this time or earlier. Leave empty to continue until stopped."
        >
          <Input
            id="event-recurrence-until"
            type="datetime-local"
            value={until}
            disabled={disabled || busy || Boolean(existing)}
            onChange={(change) => setUntil(change.target.value)}
          />
        </FormField>
        <Button type="button" disabled={disabled || busy || !canStart} onClick={() => void start()}>
          Start repeating
        </Button>
      </div>
      {!canStart && !existing ? (
        <p className="text-sm text-muted-foreground">
          Select and publish an Event with an end time first. Its duration must fit within the
          selected repeat interval.
        </p>
      ) : null}
      {disabled ? (
        <p className="text-sm text-muted-foreground">
          Save or discard Event changes before setting up recurrence.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {series.length ? (
        <ul className="space-y-3" aria-label="Event series">
          {series.map((item) => (
            <li key={item.id} className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>
                  <strong>{item.title}</strong> · {item.frequency === "daily" ? "Daily" : "Weekly"}{" "}
                  · {item.status === "failed" ? "Needs review" : item.status}
                </p>
                {item.status === "active" || item.status === "failed" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || disabled}
                    onClick={() =>
                      void (async () => {
                        if (
                          await confirm({
                            title: `Stop the ${item.title} series?`,
                            description:
                              "Future occurrences will stop. Events already created, their signups, and their lifecycle remain unchanged.",
                            confirmLabel: "Stop series",
                          })
                        )
                          await mutate(() =>
                            eventsClient.stopRecurrence({
                              guildId,
                              ...(workspaceId ? { workspaceId } : {}),
                              seriesId: item.id,
                            }),
                          );
                      })()
                    }
                  >
                    Stop series
                  </Button>
                ) : null}
              </div>
              {item.status === "active" ? (
                <p className="text-sm text-muted-foreground">
                  Next start: {new Date(item.nextStartsAtMs).toLocaleString()}
                  {item.untilAtMs === null
                    ? " · Continues until stopped"
                    : ` · Final start on or before ${new Date(item.untilAtMs).toLocaleString()}`}
                </p>
              ) : null}
              {item.failureReason ? (
                <p role="status" className="text-sm text-destructive">
                  {item.failureReason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsBlock>
  );
}
