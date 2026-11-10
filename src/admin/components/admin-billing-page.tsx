import { useCallback, useEffect, useRef, useState } from "react";
import { AdminPageHeader } from "./admin-page-header";
import { AdminErrorNotice } from "./admin-error-notice";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { CheckIcon } from "./ui/icons";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { useToast } from "./toast";
import { billingClient } from "../generated/admin-client/billing";
import { reportDashboardMilestone } from "../lib/product-analytics";

type CatalogEntry = {
  priceId: string;
  plan: "premium" | "premium_plus";
  frequency: "monthly" | "yearly";
};
type DisplayPrice = {
  plan: "premium" | "premium_plus";
  frequency: "monthly" | "yearly";
  unitAmount: number;
  currency: string;
  formattedAmount: string;
};
type BillingData = {
  subscription: Subscription | null;
  catalog: CatalogEntry[];
  prices: DisplayPrice[];
};
type Subscription = {
  priceId: string | null;
  plan: "free" | "premium" | "premium_plus";
  frequency: "monthly" | "yearly" | null;
  status: string;
  currentPeriodEndMs: number | null;
  cancelAtPeriodEnd: boolean;
  quarantineReason: string | null;
};
type AssignmentData = {
  assignments: Array<{ guildId: string }>;
  eligibleGuilds: Array<{
    guildId: string;
    name: string;
    effectivePlan: "free" | "premium" | "premium_plus";
  }>;
  capacity: number;
};
type HistoryEvent = { id: string; summaryJson: string; createdAtMs: number };

export function AdminBillingPage() {
  const requestedPlan = readRequestedPlan();
  const [data, setData] = useState<BillingData | null>(null);
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(false);
  const [pendingPrice, setPendingPrice] = useState<string | null>(null);
  const [portalPending, setPortalPending] = useState(false);
  const [changeTarget, setChangeTarget] = useState<CatalogEntry | null>(null);
  const [frequency, setFrequency] = useState<"monthly" | "yearly">("yearly");
  const [assignmentData, setAssignmentData] = useState<AssignmentData | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [assignmentPending, setAssignmentPending] = useState<{
    action: "assign" | "unassign" | "move";
    guildId: string;
    fromGuildId?: string;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    guildId: string;
    name: string;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    guildId: string;
    name: string;
  } | null>(null);
  const [moveSource, setMoveSource] = useState<string>("");
  const toast = useToast();
  const loadAttemptRef = useRef<Promise<void> | null>(null);

  const loadBilling = useCallback(async () => {
    if (loadAttemptRef.current) return loadAttemptRef.current;

    setLoadError(null);
    setLoadStatus("loading");
    setAssignmentData(null);
    setHistory([]);

    const attempt = (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const requestedFrequency = params.get("frequency");
        if (requestedFrequency === "monthly" || requestedFrequency === "yearly") {
          setFrequency(requestedFrequency);
        }
        const sessionId = params.get("checkout") === "success" ? params.get("session_id") : null;
        const value = sessionId
          ? await billingClient
              .sync({ checkoutSessionId: sessionId })
              .then(async ({ subscription }) => {
                const summary = await billingClient.get({});
                return { ...summary, subscription };
              })
          : await billingClient.get({});

        setData(value);
        if (value.subscription && value.subscription.plan !== "free") {
          if (value.subscription.frequency && !requestedPlan)
            setFrequency(value.subscription.frequency);
          void billingClient
            .assignments({})
            .then(setAssignmentData)
            .catch(() => undefined);
        }
        void billingClient
          .history({})
          .then((result) => setHistory(result.events))
          .catch(() => undefined);
        setLoadStatus("loaded");
      } catch (cause: unknown) {
        setData(null);
        setLoadError(cause);
        setLoadStatus("error");
      } finally {
        setHasAttemptedLoad(true);
        loadAttemptRef.current = null;
      }
    })();

    loadAttemptRef.current = attempt;
    return attempt;
  }, [requestedPlan]);

  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    if (assignmentData && window.location.hash === "#assignments") {
      document
        .getElementById("assignments")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [assignmentData]);

  async function checkout(priceId: string) {
    setPendingPrice(priceId);
    try {
      const search = new URLSearchParams(window.location.search);
      void reportDashboardMilestone({
        guildId: search.get("guildId") ?? "",
        workspaceId: search.get("workspaceId") ?? undefined,
        action: "upgrade_started",
      }).catch(() => undefined);
      const result = await billingClient.checkout({ priceId, intentId: crypto.randomUUID() });
      window.location.assign(result.url);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Checkout could not be started.");
      setPendingPrice(null);
    }
  }

  async function mutateAssignment(
    action: "assign" | "unassign" | "move",
    guildId: string,
    fromGuildId?: string,
  ) {
    if (assignmentPending) return;
    setAssignmentPending({ action, guildId, fromGuildId });
    try {
      const next = await billingClient.mutateAssignments({ action, guildId, fromGuildId });
      setAssignmentData(next);
      const source = fromGuildId ? assignmentName(fromGuildId, assignmentData) : null;
      const target = assignmentName(guildId, assignmentData) ?? guildId;
      toast.success(buildAssignmentAnnouncement(action, target, source ?? fromGuildId));
      setRemoveTarget(null);
      setMoveTarget(null);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Guild Assignment could not be changed.",
      );
    } finally {
      setAssignmentPending(null);
    }
  }

  async function requestRemove(guildId: string, name: string) {
    if (assignmentPending) return;
    setRemoveTarget({ guildId, name });
  }

  function requestMove(guildId: string, name: string, sourceGuildIds: string[]) {
    if (assignmentPending) return;
    setMoveTarget({ guildId, name });
    setMoveSource(sourceGuildIds.length === 1 ? sourceGuildIds[0]! : "");
  }

  async function openPortal() {
    setPortalPending(true);
    try {
      const result = await billingClient.portal({ intentId: crypto.randomUUID() });
      window.location.assign(result.url);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Billing Portal could not be opened.");
      setPortalPending(false);
    }
  }

  async function changePrice(target: CatalogEntry) {
    setPendingPrice(target.priceId);
    try {
      const result = await billingClient.changePrice({
        priceId: target.priceId,
        intentId: crypto.randomUUID(),
      });
      window.location.assign(result.url);
    } catch (cause) {
      toast.error(friendlyBillingError(cause));
      setPendingPrice(null);
      setChangeTarget(null);
    }
  }

  return (
    <section className="admin-feature-page admin-page-system space-y-6">
      <AdminPageHeader title="Billing" />
      {loadStatus === "error" && loadError ? (
        <div className="space-y-3">
          <AdminErrorNotice error={loadError} />
          <Button
            type="button"
            loading={false}
            loadingLabel="Retrying Billing…"
            disabled={false}
            onClick={() => void loadBilling()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {loadStatus === "loading" && !hasAttemptedLoad ? (
        <p className="text-sm text-muted-foreground">Loading Billing…</p>
      ) : null}
      {loadStatus === "loading" && hasAttemptedLoad ? (
        <Button
          type="button"
          loading
          loadingLabel="Retrying Billing…"
          disabled
          onClick={() => void loadBilling()}
        >
          Retry
        </Button>
      ) : null}
      {loadStatus === "loaded" && data ? (
        <>
          <Card className="overflow-hidden">
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1.5">
                <p className="font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Current plan
                </p>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-2xl font-semibold">
                    {formatPlan(data.subscription?.plan ?? "free")}
                  </h2>
                  {data.subscription && data.subscription.plan !== "free" ? (
                    <Badge>{data.subscription.status}</Badge>
                  ) : null}
                </div>
                {!data.subscription || data.subscription.plan === "free" ? (
                  <p className="text-sm text-muted-foreground">
                    Core community tools are active. Upgrade when you need more capacity and
                    automation.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2 sm:text-right">
                {data.subscription?.frequency ? (
                  <p className="text-sm capitalize">Billed {data.subscription.frequency}</p>
                ) : null}
                {data.subscription?.currentPeriodEndMs ? (
                  <p className="text-sm">
                    {data.subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"}:{" "}
                    {new Date(data.subscription.currentPeriodEndMs).toLocaleDateString()}
                  </p>
                ) : null}
                {data.subscription?.quarantineReason ? (
                  <p className="text-sm text-destructive">
                    Billing needs support attention before changes can be made.
                  </p>
                ) : null}
                {data.subscription && data.subscription.plan !== "free" ? (
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <Button
                      loading={portalPending}
                      loadingLabel="Opening Stripe…"
                      onClick={() => void openPortal()}
                    >
                      Manage billing in Stripe
                    </Button>
                    <p className="w-full text-xs text-muted-foreground">
                      Payment methods, invoices and cancellation
                    </p>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
          {!data.subscription || data.subscription.plan === "free" ? (
            <section className="space-y-5" aria-labelledby="choose-plan-title">
              {requestedPlan ? (
                <div className="rounded-lg border border-primary/35 bg-primary/5 p-4 text-sm">
                  <p className="font-semibold">
                    Your {formatPlan(requestedPlan)} selection is ready
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Review the plan below, then choose it to continue to secure Stripe checkout.
                  </p>
                </div>
              ) : null}
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 id="choose-plan-title" className="font-display text-xl font-semibold">
                    Choose the plan that fits your community
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Upgrade, cancel, or change billing frequency whenever you need to.
                  </p>
                </div>
                <FrequencySelector value={frequency} onChange={setFrequency} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {(["premium", "premium_plus"] as const).map((plan) => (
                  <PlanCard
                    key={plan}
                    plan={plan}
                    frequency={frequency}
                    catalog={data.catalog}
                    prices={data.prices ?? []}
                    pendingPrice={pendingPrice}
                    requested={requestedPlan === plan}
                    mode="checkout"
                    onSelect={(entry) => void checkout(entry.priceId)}
                  />
                ))}
              </div>
              <p className="text-center text-xs text-muted-foreground">
                Prices are in AUD. Payments, invoices, and card details are handled securely by
                Stripe.
              </p>
            </section>
          ) : null}
          {assignmentData ? (
            <div id="assignments">
              <GuildAssignmentsCard
                data={assignmentData}
                pending={assignmentPending}
                onAssign={(guildId) => void mutateAssignment("assign", guildId)}
                onRemove={requestRemove}
                onMove={requestMove}
              />
            </div>
          ) : null}
          {data.subscription && data.subscription.plan !== "free" ? (
            <details
              open={requestedPlan ? true : undefined}
              className="group rounded-lg border bg-card text-card-foreground shadow-xs"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 marker:hidden">
                <div className="space-y-1">
                  <h2 className="font-display text-lg font-semibold">Change subscription</h2>
                  <p className="text-sm text-muted-foreground">
                    Compare plans or change your billing frequency.
                  </p>
                </div>
                <span className="text-sm font-semibold text-primary group-open:hidden">
                  Show options
                </span>
                <span className="hidden text-sm font-semibold text-primary group-open:inline">
                  Hide options
                </span>
              </summary>
              <div className="space-y-5 border-t p-5">
                {data.catalog.length === 0 ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Current plan prices are unavailable. Use Manage billing to review invoices, or
                    contact support to check the subscription.
                  </p>
                ) : null}
                {data.catalog.length > 0 ? (
                  <div className="flex justify-end">
                    <FrequencySelector value={frequency} onChange={setFrequency} />
                  </div>
                ) : null}
                {data.catalog.length > 0 ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    {(["premium", "premium_plus"] as const).map((plan) => (
                      <PlanCard
                        key={plan}
                        plan={plan}
                        frequency={frequency}
                        catalog={data.catalog}
                        prices={data.prices ?? []}
                        pendingPrice={pendingPrice}
                        requested={requestedPlan === plan}
                        mode="change"
                        currentSubscription={data.subscription ?? undefined}
                        onSelect={setChangeTarget}
                      />
                    ))}
                  </div>
                ) : null}
                <p className="text-center text-xs text-muted-foreground">
                  Confirmed changes are applied through Stripe, then Stripe opens so you can review
                  billing and invoices.
                </p>
              </div>
            </details>
          ) : null}
          {history.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent billing activity</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {history.map((event) => {
                  const presentation = presentBillingHistory(event);
                  return (
                    <div key={event.id} className="border-b pb-3 text-sm last:border-b-0">
                      <p className="font-medium">{presentation.title}</p>
                      <p className="text-muted-foreground">{presentation.detail}</p>
                      {presentation.requiredAction ? (
                        <p>
                          {presentation.requiredAction} ·{" "}
                          <a className="underline" href={presentation.billingPath}>
                            Review billing
                          </a>
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog
        open={Boolean(changeTarget)}
        onOpenChange={(open) => {
          if (!open && pendingPrice === null) setChangeTarget(null);
        }}
        title="Review subscription change"
        description={
          changeTarget && data?.subscription
            ? `${formatPlan(data.subscription.plan)} · ${data.subscription.frequency} → ${formatPlan(changeTarget.plan)} · ${changeTarget.frequency}`
            : undefined
        }
        cancelLabel="Keep current plan"
        confirmLabel="Confirm & continue to Stripe"
        loading={Boolean(changeTarget && pendingPrice === changeTarget.priceId)}
        onConfirm={() => {
          if (changeTarget) void changePrice(changeTarget);
        }}
      >
        {changeTarget && data?.subscription ? (
          <ChangeReview
            current={data.subscription}
            target={changeTarget}
            prices={data.prices ?? []}
          />
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open && !assignmentPending) setRemoveTarget(null);
        }}
        title="Remove paid access?"
        description={
          removeTarget && data?.subscription
            ? `${removeTarget.name} will lose ${formatPlan(data.subscription.plan)} access.`
            : undefined
        }
        cancelLabel="Keep access"
        confirmLabel="Remove access"
        variant="destructive"
        loading={assignmentPending?.action === "unassign"}
        onConfirm={() => {
          if (removeTarget) void mutateAssignment("unassign", removeTarget.guildId);
        }}
      >
        <p>
          This takes effect immediately. Paid-only configuration may become inactive, but it is not
          deleted and can be used again if access is restored.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(moveTarget)}
        onOpenChange={(open) => {
          if (!open && !assignmentPending) setMoveTarget(null);
        }}
        title="Move paid access"
        description={
          moveTarget
            ? `Move paid access from ${assignmentName(moveSource, assignmentData) ?? "the selected Guild"} to ${moveTarget.name}.`
            : undefined
        }
        cancelLabel="Keep current assignments"
        confirmLabel="Move access"
        loading={assignmentPending?.action === "move"}
        disabled={!moveSource}
        onConfirm={() => {
          if (moveTarget && moveSource)
            void mutateAssignment("move", moveTarget.guildId, moveSource);
        }}
      >
        {assignmentData && requiresExplicitMoveSource(assignmentData.assignments.length) ? (
          <label className="block space-y-2">
            <span className="font-medium">Guild losing access</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-3"
              value={moveSource}
              onChange={(event) => setMoveSource(event.target.value)}
              disabled={Boolean(assignmentPending)}
            >
              <option value="">Choose a source Guild</option>
              {assignmentData.assignments.map((assignment) => (
                <option key={assignment.guildId} value={assignment.guildId}>
                  {assignmentName(assignment.guildId, assignmentData) ?? assignment.guildId}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="mt-3">
          The source Guild&apos;s paid-only configuration may become inactive, but it will not be
          deleted. This change takes effect immediately.
        </p>
      </ConfirmDialog>
    </section>
  );
}

function formatPlan(plan: Subscription["plan"]): string {
  if (plan === "premium_plus") return "Premium Plus";
  return plan === "premium" ? "Premium" : "Free";
}

export function presentBillingHistory(event: HistoryEvent): {
  title: string;
  detail: string;
  requiredAction: string | null;
  billingPath: string;
} {
  let summary: {
    summary?: string;
    resultingAccess?: string;
    requiredAction?: string | null;
    billingPath?: string;
  } = {};
  try {
    summary = JSON.parse(event.summaryJson) as typeof summary;
  } catch {
    // An older malformed summary remains auditable without breaking the customer page.
  }
  const kind = summary.summary?.trim().toLowerCase().replaceAll("_", " ") ?? "";
  const plan = formatHistoryPlan(summary.resultingAccess);
  const date = new Date(event.createdAtMs).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const copy =
    kind === "subscription started"
      ? {
          title: `${plan} subscription started`,
          detail: `${plan} access began on ${date}.`,
        }
      : kind === "subscription plan changed"
        ? {
            title: `Plan changed to ${plan}`,
            detail: `${plan} access became active on ${date}.`,
          }
        : kind === "subscription renewed"
          ? {
              title: `${plan} subscription renewed`,
              detail: `Your plan renewed on ${date}.`,
            }
          : kind === "subscription recovered"
            ? {
                title: "Payment recovered",
                detail: `${plan} access was restored on ${date}.`,
              }
            : kind === "payment recovery required"
              ? {
                  title: "Payment needs attention",
                  detail: `${plan} access remains available while Stripe retries the payment.`,
                }
              : kind === "subscription cancelled"
                ? {
                    title: "Subscription ended",
                    detail: `Your paid access ended on ${date}.`,
                  }
                : kind === "subscription quarantined"
                  ? {
                      title: "Billing review needed",
                      detail: `Billing changes were paused on ${date} while support reviews the subscription.`,
                    }
                  : {
                      title: "Subscription updated",
                      detail: `Your billing was updated on ${date}.`,
                    };
  return {
    ...copy,
    requiredAction: summary.requiredAction ?? null,
    billingPath: summary.billingPath ?? "/admin/billing",
  };
}

function formatHistoryPlan(value: string | undefined): string {
  if (value === "premium_plus") return "Premium Plus";
  if (value === "premium") return "Premium";
  return "Free";
}

function GuildAssignmentsCard({
  data,
  pending,
  onAssign,
  onRemove,
  onMove,
}: {
  data: AssignmentData;
  pending: { action: "assign" | "unassign" | "move"; guildId: string; fromGuildId?: string } | null;
  onAssign(guildId: string): void;
  onRemove(guildId: string, name: string): void;
  onMove(guildId: string, name: string, sourceGuildIds: string[]): void;
}) {
  const full = data.assignments.length >= data.capacity;
  const sourceGuildIds = data.assignments.map((assignment) => assignment.guildId);
  return (
    <Card className="border-primary/40">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-xl">Guild Assignments</CardTitle>
          <p className="text-sm text-muted-foreground">
            Choose which Discord servers receive your paid features.
          </p>
        </div>
        <Badge>{formatAssignmentCapacity(data.assignments.length, data.capacity)}</Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.eligibleGuilds.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No eligible Discord servers were found for this account.
          </p>
        ) : null}
        {data.eligibleGuilds.map((guild) => {
          const assigned = data.assignments.some((row) => row.guildId === guild.guildId);
          const assignedElsewhere = !assigned && guild.effectivePlan !== "free";
          return (
            <div
              key={guild.guildId}
              className={`flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between ${
                assigned ? "border-primary/50 bg-primary/5" : "bg-background/40"
              }`}
            >
              <div>
                <p className="font-medium">{guild.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {assigned
                    ? "Paid features are active here"
                    : assignedElsewhere
                      ? `${formatPlan(guild.effectivePlan)} is assigned by another plan owner`
                      : "Currently using the Free plan"}
                </p>
              </div>
              {assigned ? (
                <div className="flex items-center gap-2">
                  <Badge variant="success">Assigned</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={pending?.action === "unassign" && pending.guildId === guild.guildId}
                    disabled={Boolean(pending)}
                    onClick={() => onRemove(guild.guildId, guild.name)}
                  >
                    Remove access
                  </Button>
                </div>
              ) : assignedElsewhere ? (
                <Badge variant="success">{formatPlan(guild.effectivePlan)} active</Badge>
              ) : full ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() => onMove(guild.guildId, guild.name, sourceGuildIds)}
                >
                  Move access here
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={pending?.action === "assign" && pending.guildId === guild.guildId}
                  disabled={Boolean(pending)}
                  onClick={() => onAssign(guild.guildId)}
                >
                  Assign paid access
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function assignmentName(guildId: string | undefined, data: AssignmentData | null): string | null {
  if (!guildId || !data) return null;
  return data.eligibleGuilds.find((guild) => guild.guildId === guildId)?.name ?? null;
}

export function buildAssignmentAnnouncement(
  action: "assign" | "unassign" | "move",
  target: string,
  source?: string,
): string {
  if (action === "move")
    return `Paid access moved from ${source ?? "the selected Guild"} to ${target}.`;
  if (action === "unassign") return `Paid access removed from ${target}.`;
  return `Paid access assigned to ${target}.`;
}

export function formatAssignmentCapacity(used: number, capacity: number): string {
  return `${used} of ${capacity} slots in use${used >= capacity ? " · No slots available" : " · Slots available"}`;
}

export function requiresExplicitMoveSource(assignmentCount: number): boolean {
  return assignmentCount > 1;
}

function FrequencySelector({
  value,
  onChange,
}: {
  value: "monthly" | "yearly";
  onChange(value: "monthly" | "yearly"): void;
}) {
  return (
    <div
      className="inline-flex w-fit rounded-lg border bg-muted/30 p-1"
      role="group"
      aria-label="Billing frequency"
    >
      {(["monthly", "yearly"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          className={`rounded-md px-4 py-2 text-sm font-semibold capitalize transition-colors ${
            value === option
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onChange(option)}
        >
          {option}
          {option === "yearly" ? (
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Save 25%
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function PlanCard({
  plan,
  frequency,
  catalog,
  prices,
  pendingPrice,
  requested = false,
  mode,
  currentSubscription,
  onSelect,
}: {
  plan: "premium" | "premium_plus";
  frequency: "monthly" | "yearly";
  catalog: CatalogEntry[];
  prices: DisplayPrice[];
  pendingPrice: string | null;
  requested?: boolean;
  mode: "checkout" | "change";
  currentSubscription?: Subscription;
  onSelect(entry: CatalogEntry): void;
}) {
  const entry = catalog.find(
    (candidate) => candidate.plan === plan && candidate.frequency === frequency,
  );
  const price = prices.find(
    (candidate) => candidate.plan === plan && candidate.frequency === frequency,
  );
  const monthlyPrice = prices.find(
    (candidate) => candidate.plan === plan && candidate.frequency === "monthly",
  );
  const yearlyEquivalent =
    frequency === "yearly" && price ? formatMoney(price.unitAmount / 12, price.currency) : null;
  const features =
    plan === "premium"
      ? [
          "Premium tools for one Discord server",
          "More automation and staff controls",
          "Unlimited announcement messages",
          "Full feature configuration in HAF",
        ]
      : [
          "Premium tools for up to three Discord servers",
          "Everything included with Premium",
          "Move plan slots between your communities",
          "Option to use your own branded bot",
        ];
  const savings =
    frequency === "yearly" && price && monthlyPrice
      ? monthlyPrice.unitAmount * 12 - price.unitAmount
      : 0;
  const recommended = plan === "premium";
  const current = Boolean(entry && currentSubscription?.priceId === entry.priceId);

  return (
    <Card
      className={`relative flex min-h-[390px] flex-col overflow-hidden ${
        recommended
          ? "border-primary/60 shadow-[inset_0_3px_0_hsl(var(--primary))]"
          : requested
            ? "border-primary/60 ring-2 ring-primary/20"
            : ""
      }`}
    >
      {recommended ? (
        <div className="absolute right-4 top-4 rounded-full bg-primary/15 px-2.5 py-1 font-display text-[9px] font-semibold uppercase tracking-[0.12em] text-primary">
          Most popular
        </div>
      ) : null}
      <CardHeader className="pb-3">
        <p className="font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {plan === "premium" ? "For one community" : "For growing networks"}
        </p>
        <CardTitle className="text-2xl">{formatPlan(plan)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <div className="min-h-[76px] border-b pb-5">
          {price ? (
            <>
              <div className="flex items-baseline gap-2">
                <strong className="font-display text-4xl font-semibold tracking-tight">
                  {price.formattedAmount}
                </strong>
                <span className="text-sm text-muted-foreground">
                  / {frequency === "monthly" ? "month" : "year"}
                </span>
              </div>
              {yearlyEquivalent ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {yearlyEquivalent}/month equivalent
                  {savings > 0 ? ` · Save ${formatMoney(savings, price.currency)} yearly` : ""}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">Billed monthly</p>
              )}
            </>
          ) : (
            <p className="pt-2 text-sm font-medium">Price available at checkout</p>
          )}
        </div>
        <ul className="my-5 space-y-3 text-sm">
          {features.map((feature) => (
            <li key={feature} className="flex gap-2.5">
              <CheckIcon className="mt-0.5 h-4 w-4 text-primary" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
        <Button
          className="mt-auto w-full"
          size="lg"
          variant={recommended ? "default" : "outline"}
          disabled={!entry || current || pendingPrice !== null}
          loading={pendingPrice === entry?.priceId}
          loadingLabel={mode === "checkout" ? "Opening secure checkout…" : "Applying change…"}
          onClick={() => entry && onSelect(entry)}
        >
          {current
            ? "Current plan"
            : mode === "checkout"
              ? `Choose ${formatPlan(plan)}`
              : "Review change"}
        </Button>
      </CardContent>
    </Card>
  );
}

function readRequestedPlan(): "premium" | "premium_plus" | null {
  if (typeof window === "undefined") return null;
  const plan = new URLSearchParams(window.location.search).get("plan");
  return plan === "premium" || plan === "premium_plus" ? plan : null;
}

function ChangeReview({
  current,
  target,
  prices,
}: {
  current: Subscription;
  target: CatalogEntry;
  prices: DisplayPrice[];
}) {
  const price = prices.find(
    (candidate) => candidate.plan === target.plan && candidate.frequency === target.frequency,
  );
  const scheduledAtRenewal = current.plan === "premium_plus" && target.plan === "premium";

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/30 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          New price
        </p>
        <p className="mt-1 font-display text-xl font-semibold">
          {price?.formattedAmount ?? "Current Stripe price"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            / {target.frequency === "monthly" ? "month" : "year"}
          </span>
        </p>
      </div>
      <p>
        {scheduledAtRenewal
          ? `This downgrade is scheduled for ${formatDate(current.currentPeriodEndMs)}. Your current access continues until then.`
          : "This change takes effect immediately. Stripe calculates any prorated charge or credit for the time remaining in your current billing period."}
      </p>
      {scheduledAtRenewal ? (
        <p className="text-muted-foreground">
          Before scheduling, HAF checks that your Guild Assignments and branded-bot commitments fit
          the new plan.
        </p>
      ) : null}
      <p className="text-muted-foreground">
        After confirmation, Stripe will open so you can review billing details and invoices.
      </p>
    </div>
  );
}

function formatDate(value: number | null): string {
  return value ? new Date(value).toLocaleDateString() : "your next renewal";
}

function friendlyBillingError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("downgrade_obligations_unresolved")) {
    return "Before downgrading, reduce Guild Assignments to one and resolve any branded-bot commitment.";
  }
  if (message.includes("billing_in_grace")) {
    return "Plan changes are paused while a payment needs attention. Open Stripe to update payment details.";
  }
  if (message.includes("billing_quarantined")) {
    return "Billing needs support attention before this subscription can be changed.";
  }
  return message || "The subscription change could not be completed.";
}

function formatMoney(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(unitAmount / 100);
}
