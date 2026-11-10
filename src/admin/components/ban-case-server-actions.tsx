import { useState } from "react";
import type { BanCase } from "../../types";
import type { Intent, Operation } from "../../ban-case-enforcement/model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { buildWorkspaceGuildPath } from "../lib/api";

interface Data {
  cases: BanCase[];
  targets: { id: string; name: string; ban: boolean; unban: boolean }[];
  operations: Operation[];
}
export function BanCaseServerActions({
  guildId,
  workspaceId,
}: {
  guildId: string;
  workspaceId: string;
}) {
  const [data, setData] = useState<Data>();
  const [caseId, setCaseId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [action, setAction] = useState<"ban" | "unban">("ban");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState<Intent>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function request<T = Data>(stage = "", body?: unknown) {
    const path = `/admin/api/ban-cases/server-actions${stage ? `/${stage}` : ""}`;
    const response = await fetch(
      buildWorkspaceGuildPath(path, workspaceId, guildId),
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...(body as object), guildId, workspaceId }),
          }
        : undefined,
    );
    if (!response.ok)
      throw new Error(
        "Server actions unavailable. Check staff access, target approval, expiry and unresolved work.",
      );
    return (await response.json()) as T;
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Server action failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3" aria-label="Ban Case server actions">
      <h2>Server actions</h2>
      <p>
        Explicit ban or unban requests are independent of Mark Completed. WARDOGS mutations are
        disabled until separately approved.
      </p>
      <Button disabled={busy} onClick={() => void run(async () => setData(await request()))}>
        Load cases and server actions
      </Button>
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <label>
            Case
            <select
              value={caseId}
              onChange={(e) => {
                setCaseId(e.target.value);
                setConfirmation(undefined);
              }}
            >
              <option value="">Choose a case</option>
              {data.cases.map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  {c.username} · {c.subject.id} · {c.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target
            <select
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setConfirmation(undefined);
              }}
            >
              <option value="">Choose one target</option>
              {data.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {!t.ban && !t.unban ? " (not ready)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Operation
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value as "ban" | "unban");
                setConfirmation(undefined);
              }}
            >
              <option value="ban" disabled={!data.targets.find((t) => t.id === targetId)?.ban}>
                Ban
              </option>
              <option value="unban" disabled={!data.targets.find((t) => t.id === targetId)?.unban}>
                Unban
              </option>
            </select>
          </label>
          <label>
            Required reason
            <Input
              value={reason}
              maxLength={500}
              onChange={(e) => {
                setReason(e.target.value);
                setConfirmation(undefined);
              }}
            />
          </label>
          <Button
            disabled={
              busy ||
              !caseId ||
              !reason.trim() ||
              !data.targets.find((t) => t.id === targetId)?.[action]
            }
            onClick={() =>
              void run(async () =>
                setConfirmation(
                  (
                    await request<{ confirmation: Intent }>("prepare", {
                      caseId,
                      targetId,
                      action,
                      reason,
                    })
                  ).confirmation,
                ),
              )
            }
          >
            Review server action
          </Button>
          {confirmation && (
            <div role="region" aria-label="Confirm server action">
              <p>
                Confirm {confirmation.action}: case {confirmation.caseId}, target{" "}
                {confirmation.targetLabel}, exact SteamID64 {confirmation.subject}.
              </p>
              <p>Reason: {confirmation.reason}</p>
              <p>
                This subject came from an external report. Ownership is not verified. Confirmation
                expires after five minutes.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await request<{ operation: Operation }>("confirm", {
                      id: confirmation.id,
                    });
                    setConfirmation(undefined);
                    setMessage(
                      `Request persisted: ${result.operation.state}. This is not verified server delivery.`,
                    );
                    setData(await request());
                  })
                }
              >
                Confirm {confirmation.action}
              </Button>
            </div>
          )}
          <ul>
            {data.operations.map((op) => (
              <li key={op.id}>
                {op.action} {op.subject} · {op.targetLabel}: {op.state} — {op.outcome}
                {op.state === "pending" && op.transmittedAtMs === null && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await request("cancel", { id: op.id });
                        setData(await request());
                      })
                    }
                  >
                    Cancel undispatched request
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
