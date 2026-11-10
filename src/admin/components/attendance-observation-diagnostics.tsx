import { useState, useEffect } from "react";
import type { PublicTarget } from "../../wardogs/model";
import type { redactedReport } from "../../server-levels/observations/model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
type Report = ReturnType<typeof redactedReport>;
type Data = {
  runs: { id: string; targetId: string; generation: number; report: Report }[];
  retainedReports: Report[];
};
export default function AttendanceObservationDiagnostics({
  guildId,
  workspaceId,
  targets,
}: {
  guildId: string;
  workspaceId: string;
  targets: PublicTarget[];
}) {
  const [data, setData] = useState<Data | null>(null);
  const [targetId, setTarget] = useState("");
  const [hours, setHours] = useState("1");
  const [capacity, setCapacity] = useState("");
  const [build, setBuild] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const generation = targets.find((t) => t.id === targetId)?.generation;
  // eslint-disable-next-line custom/no-use-effect -- Readiness follows the selected Guild target and generation; cancel stale requests.
  useEffect(() => {
    setReady(null);
    if (!targetId) return;
    const controller = new AbortController();
    void fetch(
      `/admin/api/wardogs/observations/readiness?${new URLSearchParams({ guildId, workspaceId, targetId })}`,
      { signal: controller.signal },
    )
      .then(async (result) => {
        if (!result.ok) throw new Error("Observation readiness is unavailable.");
        const state = (await result.json()) as { ready: boolean };
        if (!controller.signal.aborted) setReady(state.ready);
      })
      .catch(() => {
        if (!controller.signal.aborted) setReady(false);
      });
    return () => controller.abort();
  }, [guildId, workspaceId, targetId, generation]);
  async function refresh() {
    const result = await fetch(
      `/admin/api/wardogs/observations?${new URLSearchParams({ guildId, workspaceId })}`,
    );
    if (!result.ok) throw new Error("Observation details are unavailable.");
    setData((await result.json()) as Data);
  }
  async function action(path?: string, body?: object) {
    setBusy(true);
    setError("");
    try {
      if (path) {
        const result = await fetch(`/admin/api/wardogs/observations/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guildId, workspaceId, ...body }),
        });
        if (!result.ok) {
          const response = (await result.json()) as { error?: string };
          throw new Error(response.error ?? "The observation request could not be completed.");
        }
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Observation unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded border p-4">
      <h2 className="font-semibold">Observation only — no XP</h2>
      <p className="text-sm">
        Test WARDOGS attendance evidence for Server Levels. Samples cannot prove continuous
        attendance and never award XP, rewards or paid access. Player Count and CFTools are not
        required.
      </p>
      <p className="text-sm">
        Requires paid Server Levels eligibility, Steam Platform Link and approved network reads.
        Runs stop automatically within 24 hours. Private linked-account observations expire after
        seven days; retained reports contain aggregate evidence only.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const target = targets.find((t) => t.id === targetId);
          if (!target) return;
          void action("start", {
            targetId,
            generation: target.generation,
            durationHours: Number(hours),
            configuredCapacity: capacity ? Number(capacity) : null,
            confirmation: "OBSERVATION_ONLY_NO_XP",
            evidence: {
              sourceRevision: "cb899a1e4f5430d4e14f2e545877894b3cf50418",
              serverBuild: build || null,
              hostEvidence: "operator-read-approved",
            },
          });
        }}
      >
        <label>
          WARDOGS server
          <select
            className="w-full rounded border bg-background p-2"
            required
            value={targetId}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose a server</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Duration in hours (maximum 24)
          <Input
            type="number"
            min={1}
            max={24}
            required
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
        <label>
          Admin reference capacity (optional; never changed automatically)
          <Input
            type="number"
            min={1}
            max={10000}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
        </label>
        <label>
          Server build label (optional; no account IDs or secrets)
          <Input maxLength={100} value={build} onChange={(e) => setBuild(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{" "}
          I authorize this temporary observation test and understand that it awards no XP.
        </label>
        {targetId && ready !== null ? (
          <p role="status">
            {ready
              ? "Ready for a temporary observation run."
              : "Observation is unavailable. Check paid Server Levels, Steam linking, processing and current target read approval."}
          </p>
        ) : null}
        <Button disabled={busy || !consent || !targetId || ready !== true}>
          Start observation run
        </Button>
      </form>
      <Button variant="outline" disabled={busy} onClick={() => void action()}>
        Refresh observation reports
      </Button>
      {data?.runs.map((run) => (
        <div key={run.id} className="space-y-2 rounded border p-3">
          <h3>
            {targets.find((t) => t.id === run.targetId)?.name ?? "Previous server"} —{" "}
            {run.report.state}
          </h3>
          <p>Auto-stop: {new Date(run.report.expiresAtMs).toISOString()}</p>
          <ReportView report={run.report} />
          {run.report.state === "running" ? (
            <Button disabled={busy} onClick={() => void action("stop", { id: run.id })}>
              Stop observation now
            </Button>
          ) : null}
        </div>
      ))}
      {data?.retainedReports.map((report) => (
        <div key={report.reportId} className="rounded border p-3">
          <h3>Retained aggregate evidence</h3>
          <ReportView report={report} />
        </div>
      ))}
    </section>
  );
}
function ReportView({ report }: { report: Report }) {
  return (
    <div className="text-sm">
      <p>Decision: no XP integration. Queue: unknown. Session continuity: unknown.</p>
      <p>
        Completed samples: {report.totals.samples}; failed: {report.totals.failed}; missing slots:{" "}
        {report.totals.missingSlots}; discarded late results: {report.totals.lateResultsDiscarded};
        ignored duplicates: {report.totals.duplicatesIgnored}.
      </p>
      <p>
        Count disagreements: {report.totals.disagreements}; capacity mismatches:{" "}
        {report.totals.capacityMismatches}; possible match boundaries:{" "}
        {report.totals.possibleMatchBoundaries}.
      </p>
      <p>
        Apparent linked-account arrivals/departures: {report.totals.apparentArrivals}/
        {report.totals.apparentDepartures}. These are snapshot changes, not join/leave events.
      </p>
      <p>
        Read attempts (including local throttling): {report.totals.requestCount}; total request
        time: {report.totals.requestMs} ms. Billing cost was not measured.
      </p>
    </div>
  );
}
