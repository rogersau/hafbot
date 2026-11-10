import { useState, lazy, Suspense } from "react";
const AttendanceObservationDiagnostics = lazy(() => import("./attendance-observation-diagnostics"));
import type { PublicTarget } from "../../wardogs/model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AdminPageHeader } from "./admin-page-header";
export interface WardogsLoaderData {
  targets: PublicTarget[];
  origins: { id: string }[];
  networkEnabled: boolean;
  credentialEncryptionAvailable: boolean;
  maxTargets: number;
}
export function AdminWardogsPage({
  selectedGuildId,
  selectedWorkspaceId,
  initialData,
}: {
  selectedGuildId: string;
  selectedWorkspaceId: string;
  initialData?: WardogsLoaderData;
}) {
  const [data, setData] = useState(initialData);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function mutate(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/admin/api/wardogs/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guildId: selectedGuildId,
          workspaceId: selectedWorkspaceId,
          ...body,
        }),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error ?? "WARDOGS setup failed.");
      }
      const query = new URLSearchParams({
        guildId: selectedGuildId,
        workspaceId: selectedWorkspaceId,
      });
      const refreshed = await fetch(`/admin/api/wardogs?${query}`);
      if (!refreshed.ok) throw new Error("Could not refresh WARDOGS targets.");
      setData((await refreshed.json()) as WardogsLoaderData);
      setMessage("Saved. Changes require approval for the new target generation.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "WARDOGS setup failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="space-y-6">
      <AdminPageHeader
        title="WARDOGS targets"
        readinessFeature="wardogs"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      <p>
        Preparation only. The candidate WDRCON protocol has not been certified for production.
        Read-only access may hold a full-power administrator password. Server actions require
        separate operator approval and target opt-in.
      </p>
      <p>
        {data?.networkEnabled
          ? "Operator network switch is on. Each target generation still requires approval."
          : "Network access is disabled by the HAF operator."}
      </p>
      <p>Disconnect stops HAF access. Rotate or revoke the password at your host as well.</p>
      <p role="status">{message}</p>
      <Suspense fallback={null}>
        <AttendanceObservationDiagnostics
          key={`${selectedGuildId}:${selectedWorkspaceId}`}
          guildId={selectedGuildId}
          workspaceId={selectedWorkspaceId}
          targets={data?.targets ?? []}
        />
      </Suspense>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate("targets", { name, originRef: null });
        }}
      >
        <Input
          aria-label="Target name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          required
        />
        <Button disabled={busy || !data || data.targets.length >= data.maxTargets}>
          Add target
        </Button>
      </form>
      {data?.targets.map((target) => (
        <TargetForm
          key={`${target.id}:${target.generation}`}
          target={target}
          data={data}
          busy={busy}
          mutate={mutate}
        />
      ))}
    </main>
  );
}
function TargetForm({
  target,
  data,
  busy,
  mutate,
}: {
  target: PublicTarget;
  data: WardogsLoaderData;
  busy: boolean;
  mutate: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [name, setName] = useState(target.name);
  const [originRef, setOriginRef] = useState(target.originRef ?? "");
  const [roster, setRoster] = useState(false);
  const identity = { targetId: target.id, generation: target.generation };
  return (
    <section className="space-y-3 rounded border p-4">
      <h2 className="font-semibold">{target.name}</h2>
      <p>
        Generation {target.generation} ·{" "}
        {target.credentialConfigured ? "Password configured" : "No password configured"} ·{" "}
        {target.verifiedGeneration === target.generation && !target.stale
          ? "Read shapes verified"
          : "Unverified"}
      </p>
      {target.lastSuccessAtMs !== null && (
        <p>
          Last successful read: {new Date(target.lastSuccessAtMs).toISOString()} (
          {target.stale ? "stale" : "recorded observation"})
        </p>
      )}
      {target.diagnostic && <p>Diagnostic: {target.diagnostic.replaceAll("_", " ")}</p>}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const password = secret;
          setSecret("");
          void mutate("change", {
            ...identity,
            name,
            originRef: originRef || null,
            ...(password ? { secret: password } : {}),
          });
        }}
      >
        <Input
          aria-label="Target name"
          value={name}
          maxLength={100}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <label>
          Approved endpoint{" "}
          <select value={originRef} onChange={(event) => setOriginRef(event.target.value)}>
            <option value="">Not selected</option>
            {data.origins.map((origin) => (
              <option key={origin.id} value={origin.id}>
                {origin.id}
              </option>
            ))}
          </select>
        </label>
        <Input
          aria-label="New RCON password"
          type="password"
          autoComplete="new-password"
          value={secret}
          maxLength={1024}
          disabled={!data.credentialEncryptionAvailable}
          onChange={(event) => setSecret(event.target.value)}
        />
        <Button disabled={busy}>Save target / replace password</Button>
      </form>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy}
          onClick={() => void mutate("change", { ...identity, enabled: !target.enabled })}
        >
          {target.enabled ? "Disable target" : "Opt in to network reads"}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void mutate("change", { ...identity, banCasesEnabled: !target.banCasesEnabled })
          }
        >
          {target.banCasesEnabled
            ? "Disable Ban Case server actions"
            : "Opt in to Ban Case server actions"}
        </Button>
        <label>
          <input
            type="checkbox"
            checked={roster}
            onChange={(event) => setRoster(event.target.checked)}
          />{" "}
          Include roster for an attendance consumer
        </label>
        <Button
          disabled={busy || !data.networkEnabled || !target.enabled || !target.credentialConfigured}
          onClick={() => void mutate("test", { ...identity, roster })}
        >
          Test read access
        </Button>
        <Button
          disabled={busy || target.disconnected}
          onClick={() => void mutate("change", { ...identity, disconnect: true })}
        >
          Disconnect
        </Button>
      </div>
    </section>
  );
}
