import { useEffect, useState } from "react";
import type { Assignment, Fulfillment } from "../../commerce/game-access/model";
import { SettingsBlock, SectionHeader } from "./admin-form-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export default function AdminCommerceGameAccess({
  guildId,
  workspaceId,
  offerings,
}: {
  guildId: string;
  workspaceId: string;
  offerings: { id: string; name: string }[];
}) {
  const [data, setData] = useState<{
    targets: { id: string; name: string }[];
    configurations: Fulfillment[];
    assignments: Assignment[];
    readiness: { offeringId: string; blockers: string[] }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [offeringId, setOffering] = useState("");
  const [targetId, setTarget] = useState("");
  const [ceiling, setCeiling] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  // Reload the remote Guild view and cancel requests when its scope changes.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void fetch(`/admin/api/commerce/game-access?${new URLSearchParams({ guildId, workspaceId })}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<{
          targets: { id: string; name: string }[];
          configurations: Fulfillment[];
          assignments: Assignment[];
          readiness: { offeringId: string; blockers: string[] }[];
        }>;
      })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Reserved-access details are unavailable.");
      });
    return () => controller.abort();
  }, [guildId, workspaceId, version]);
  async function save(action: string, body: object) {
    setBusy(true);
    setError("");
    try {
      const result = await fetch(`/admin/api/commerce/game-access/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, workspaceId, ...body }),
      });
      if (!result.ok) throw new Error();
      setVersion((v) => v + 1);
    } catch {
      setError(
        "The change could not be applied. Check your seller permissions, target approval, and any unresolved operation.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsBlock>
      <SectionHeader
        title="WARDOGS reserved access"
        description="Preparation only: new sales and grants are disabled pending provider validation. Payment, Discord roles and game delivery have separate outcomes."
      />
      <p className="text-sm">
        A server reservation does not guarantee admission or queue priority. Existing external
        entries are never taken over. Do not repurpose HAF-managed entries independently.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {data ? (
        <>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save("configure", {
                offeringId,
                targetId,
                allocationCeiling: Number(ceiling),
                acceptingSales: false,
              });
            }}
          >
            <label>
              Recurring offering
              <select
                className="w-full rounded border bg-background p-2"
                value={offeringId}
                onChange={(e) => setOffering(e.target.value)}
                required
              >
                <option value="">Choose an offering</option>
                {offerings.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              WARDOGS server
              <select
                className="w-full rounded border bg-background p-2"
                value={targetId}
                onChange={(e) => setTarget(e.target.value)}
                required
              >
                <option value="">Choose a server</option>
                {data.targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              HAF allocation ceiling
              <Input
                type="number"
                min={1}
                max={2000}
                value={ceiling}
                onChange={(e) => setCeiling(e.target.value)}
                required
              />
            </label>
            <Button type="submit" disabled={busy}>
              Save disabled benefit
            </Button>
          </form>
          {data.configurations.map((c) => (
            <p key={c.offeringId} className="text-sm">
              {offerings.find((o) => o.id === c.offeringId)?.name ?? "Archived offering"}: reserved
              access on{" "}
              {data.targets.find((t) => t.id === c.targetId)?.name ?? "Unavailable server"}. Ceiling{" "}
              {c.allocationCeiling}.{" "}
              {(
                data.readiness?.find((r) => r.offeringId === c.offeringId)?.blockers ?? [
                  "provider_validation_required",
                ]
              )
                .map((reason) => reason.replaceAll("_", " "))
                .join("; ")}
              .
            </p>
          ))}
          <label>
            Repair or handoff reason
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              maxLength={500}
            />
          </label>
          {data.assignments.map((a) => (
            <div key={a.id} className="space-y-2 rounded border p-3 text-sm">
              <p>
                Member {a.userId} · Steam {a.subject} · <strong>{a.state}</strong>
              </p>
              <p>
                Eligible subscriptions: {a.entitlementIds.length}. Desired game access:{" "}
                {a.desired ? "yes" : "no"}.
              </p>
              <p>
                {a.reason.replaceAll("_", " ")} · attempts {a.attempts}/5
              </p>
              {a.obligation ? (
                <p>
                  Cleanup remains outstanding. If disconnected, remove this exact Steam entry on the
                  original server after resolving any possible late operation.
                </p>
              ) : null}
              <Button
                disabled={busy || reason.trim().length < 10 || Boolean(a.transmitted)}
                onClick={() => void save("repair", { id: a.id, reason })}
              >
                Reconcile current eligibility
              </Button>
              {a.obligation && !a.desired ? (
                <Button
                  variant="outline"
                  disabled={busy || reason.trim().length < 10 || Boolean(a.transmitted)}
                  onClick={() => void save("repair", { id: a.id, reason, handoff: true })}
                >
                  Hand cleanup to server administrator
                </Button>
              ) : null}
            </div>
          ))}
          {!data.assignments.length ? (
            <p className="text-sm">No reserved-access assignments.</p>
          ) : null}
        </>
      ) : (
        <p className="text-sm">Loading reserved access…</p>
      )}
    </SettingsBlock>
  );
}
