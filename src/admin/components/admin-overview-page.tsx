import { Card, CardContent } from "./ui/card";
import { AlertTriangleIcon, CheckIcon } from "./ui/icons";
import { useMemo, useRef, useState } from "react";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import {
  buildPlayerLinkPlatformHref,
  buildReactionRulesTabHref,
  buildTicketsTabHref,
} from "../lib/admin-route-state";
import type { AdminGuildOverviewCard, RecommendedNextStep } from "../../runtime/admin-types";
import type { GuildEntitlementTier } from "../../types";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { ONBOARDING_GOALS } from "../../onboarding-goals";
import { reportDashboardMilestone } from "../lib/product-analytics";
import type { OperationalIncidentView } from "../../operations/incidents";
import { describeError, readJsonOrThrow } from "../lib/api";
import { AdminErrorNotice } from "./admin-error-notice";
import { useToast } from "./toast";
import { Button } from "./ui/button";

interface AdminOverviewPageProps {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  tier: GuildEntitlementTier | null;
  cards: AdminGuildOverviewCard[];
  recommendedNextStep?: RecommendedNextStep | null;
  r2Usage?: EntitlementInfo["r2Usage"] | null;
  openIncidents?: OperationalIncidentView[];
  canRemediate?: boolean;
  onRouteDataRefresh?: () => Promise<void>;
}

type OverviewItem = {
  card: AdminGuildOverviewCard;
  href: string;
  workspaceId?: string;
  guildId?: string;
};

const ACTIONABLE_READINESS = new Set([
  "needs_attention",
  "setup_incomplete",
  "ready_disabled",
  "dormant",
]);
const STORAGE_WARNING_THRESHOLD = 0.8;

export function AdminOverviewPage({
  selectedWorkspaceId,
  selectedGuildId,
  tier,
  cards,
  recommendedNextStep = null,
  r2Usage = null,
  openIncidents = [],
  canRemediate = false,
  onRouteDataRefresh,
}: AdminOverviewPageProps) {
  const [retrying, setRetrying] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const items = cards.map((card) => ({
    card,
    href: buildFeatureCardHref(card, selectedWorkspaceId, selectedGuildId),
    workspaceId: selectedWorkspaceId,
    guildId: selectedGuildId,
  }));
  const attentionItems = getOverviewAttentionItems(items);
  const storageWarning = r2Usage ? getStorageWarning(r2Usage) : null;
  const hasAttention =
    openIncidents.length > 0 || attentionItems.length > 0 || storageWarning !== null;

  return (
    <section className="admin-ops-overview admin-status-board">
      <OverviewHeader
        tier={tier}
        attentionCount={openIncidents.length + attentionItems.length + (storageWarning ? 1 : 0)}
      />
      {items.length === 0 ? (
        <div className="space-y-3" role="status">
          <p>
            The feature directory is unavailable. Reload it to see feature status and Guided setup.
          </p>
          {loadError ? <AdminErrorNotice error={loadError} /> : null}
          <Button
            type="button"
            variant="outline"
            disabled={!onRouteDataRefresh || retrying}
            loading={retrying}
            onClick={() => {
              setRetrying(true);
              setLoadError(null);
              void onRouteDataRefresh?.()
                .catch(setLoadError)
                .finally(() => setRetrying(false));
            }}
          >
            Reload feature directory
          </Button>
        </div>
      ) : null}
      {hasAttention ? (
        <AttentionQueue
          items={attentionItems}
          storageWarning={storageWarning}
          billingHref={buildAdminDashboardHref(
            "/admin/billing",
            selectedWorkspaceId,
            selectedGuildId,
          )}
        />
      ) : items.length > 0 ? (
        <HealthyState />
      ) : null}
      {openIncidents.length > 0 ? (
        <OperationsInbox
          incidents={openIncidents}
          canRemediate={canRemediate}
          workspaceId={selectedWorkspaceId}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      ) : null}
      <AllFeatures items={items} />
      {!hasAttention && recommendedNextStep ? (
        <RecommendedNextStepPanel step={recommendedNextStep} />
      ) : null}
      {!hasAttention && items.length > 0 ? (
        <GoalOnboardingPanel
          items={items}
          workspaceId={selectedWorkspaceId}
          guildId={selectedGuildId}
        />
      ) : null}
    </section>
  );
}

function OperationsInbox({
  incidents,
  canRemediate,
  workspaceId,
  onRouteDataRefresh,
}: {
  incidents: OperationalIncidentView[];
  canRemediate: boolean;
  workspaceId: string;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [severity, setSeverity] = useState("all");
  const [feature, setFeature] = useState("all");
  const [pendingIncidentIds, setPendingIncidentIds] = useState<Set<string>>(() => new Set());
  const [remediationErrors, setRemediationErrors] = useState<Map<string, unknown>>(() => new Map());
  const pendingIncidentIdsRef = useRef<Set<string>>(new Set());
  const toast = useToast();
  const features = useMemo(
    () => [...new Set(incidents.map((incident) => incident.feature))].sort(),
    [incidents],
  );
  const filtered = incidents.filter(
    (incident) =>
      (severity === "all" || incident.severity === severity) &&
      (feature === "all" || incident.feature === feature),
  );
  return (
    <section className="admin-attention-section" aria-labelledby="operations-inbox-heading">
      <div className="admin-attention-heading">
        <div>
          <span>Operations inbox</span>
          <h2 id="operations-inbox-heading">Actionable failures</h2>
        </div>
        <b>{incidents.length}</b>
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-3" aria-label="Operations filters">
        <label className="text-xs text-muted-foreground">
          Severity
          <select
            className="ml-2 rounded border bg-background px-2 py-1"
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
          >
            <option value="all">All</option>
            <option value="critical">Critical</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Feature
          <select
            className="ml-2 rounded border bg-background px-2 py-1"
            value={feature}
            onChange={(event) => setFeature(event.target.value)}
          >
            <option value="all">All</option>
            {features.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="admin-attention-list">
        {filtered.map((incident) => (
          <article className={`admin-attention-row is-${incident.severity}`} key={incident.id}>
            <span className="admin-attention-icon" aria-hidden="true">
              <AlertTriangleIcon className="h-4 w-4" />
            </span>
            <div>
              <h3>{incident.feature}</h3>
              <p>{incident.summary}</p>
              <small>{incident.impact}</small>
            </div>
            <span className="admin-attention-state">
              {incident.severity} · {incident.occurrenceCount} observed · first seen{" "}
              {formatIncidentAge(incident.firstSeenAtMs)} · last seen{" "}
              {formatIncidentAge(incident.lastSeenAtMs)}
            </span>
            <a href={incident.deepLink}>Review ↗</a>
            {incident.remediation.executable ? (
              <button
                type="button"
                disabled={!canRemediate || pendingIncidentIds.has(incident.id)}
                title={!canRemediate ? "Write access is required" : undefined}
                onClick={() => {
                  if (!canRemediate || pendingIncidentIdsRef.current.has(incident.id)) return;
                  pendingIncidentIdsRef.current.add(incident.id);
                  setRemediationErrors((current) => {
                    const next = new Map(current);
                    next.delete(incident.id);
                    return next;
                  });
                  setPendingIncidentIds((current) => {
                    const next = new Set(current);
                    next.add(incident.id);
                    return next;
                  });
                  void (async () => {
                    let successMessage: string;
                    try {
                      const result = await readJsonOrThrow<{ message: string }>(
                        `/admin/api/operations/incidents/${encodeURIComponent(incident.id)}/remediate`,
                        {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            guildId: incident.guildId,
                            workspaceId,
                            incidentId: incident.id,
                            expectedVersion: incident.version,
                            action: incident.remediation.code,
                          }),
                        },
                      );
                      successMessage = result.message;
                    } catch (error) {
                      setRemediationErrors((current) => {
                        const next = new Map(current);
                        next.set(incident.id, error);
                        return next;
                      });
                      pendingIncidentIdsRef.current.delete(incident.id);
                      setPendingIncidentIds((current) => {
                        const next = new Set(current);
                        next.delete(incident.id);
                        return next;
                      });
                      return;
                    }

                    toast.success(successMessage);
                    try {
                      await onRouteDataRefresh?.();
                    } catch (error) {
                      toast.error(
                        "Repair succeeded, but the dashboard could not refresh. " +
                          describeError(error),
                      );
                    } finally {
                      pendingIncidentIdsRef.current.delete(incident.id);
                      setPendingIncidentIds((current) => {
                        const next = new Set(current);
                        next.delete(incident.id);
                        return next;
                      });
                    }
                  })();
                }}
              >
                {pendingIncidentIds.has(incident.id)
                  ? `${incident.remediation.label}…`
                  : incident.remediation.label}
              </button>
            ) : null}
            {remediationErrors.has(incident.id) ? (
              <AdminErrorNotice error={remediationErrors.get(incident.id)} />
            ) : null}
          </article>
        ))}
        {filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No incidents match these filters.</p>
        ) : null}
      </div>
    </section>
  );
}

function formatIncidentAge(timestampMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestampMs) / 60_000));
  if (minutes < 1) return "now";
  if (minutes === 1) return "1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function getOverviewAttentionItems(items: OverviewItem[]): OverviewItem[] {
  return items
    .filter(
      ({ card }) =>
        !card.locked &&
        ((card.readiness && ACTIONABLE_READINESS.has(card.readiness)) ||
          isWhiteLabelBotAttention(card)),
    )
    .sort((left, right) => attentionPriority(left.card) - attentionPriority(right.card));
}

function isWhiteLabelBotAttention(card: AdminGuildOverviewCard) {
  return (
    card.id === "white-label-bot" &&
    card.status === "configured" &&
    card.detail !== "Active" &&
    card.detail !== "Decommissioned"
  );
}

function attentionPriority(card: AdminGuildOverviewCard) {
  if (card.readiness === "needs_attention") return 0;
  if (card.readiness === "setup_incomplete") return 1;
  if (isWhiteLabelBotAttention(card)) return 2;
  if (card.readiness === "dormant") return 3;
  return 4;
}

export function getStorageWarning(usage: EntitlementInfo["r2Usage"]) {
  const accountedBytes = usage.usedBytes + usage.reservedBytes;
  if (usage.maxBytes <= 0 || accountedBytes / usage.maxBytes < STORAGE_WARNING_THRESHOLD) {
    return null;
  }
  return {
    accountedBytes,
    percentage: Math.min(100, Math.round((accountedBytes / usage.maxBytes) * 100)),
    usage,
  };
}

function OverviewHeader({
  tier,
  attentionCount,
}: {
  tier: GuildEntitlementTier | null;
  attentionCount: number;
}) {
  return (
    <header className="admin-ops-page-header">
      <div>
        <span>Guild operations</span>
        <h1>What needs your attention</h1>
        <p>
          {attentionCount > 0
            ? `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} review.`
            : "No configuration issues need your attention."}
        </p>
      </div>
      {tier ? <span className="admin-ops-tier">{formatTier(tier)} tier</span> : null}
    </header>
  );
}

function AttentionQueue({
  items,
  storageWarning,
  billingHref,
}: {
  items: OverviewItem[];
  storageWarning: ReturnType<typeof getStorageWarning>;
  billingHref: string;
}) {
  return (
    <section className="admin-attention-section" aria-labelledby="admin-attention-heading">
      <div className="admin-attention-heading">
        <div>
          <span>Action queue</span>
          <h2 id="admin-attention-heading">Needs review</h2>
        </div>
        <b>{items.length + (storageWarning ? 1 : 0)}</b>
      </div>
      <div className="admin-attention-list">
        {items.map((item) => (
          <AttentionRow item={item} key={item.card.id} />
        ))}
        {storageWarning ? (
          <StorageWarningRow warning={storageWarning} billingHref={billingHref} />
        ) : null}
      </div>
    </section>
  );
}

function AttentionRow({ item }: { item: OverviewItem }) {
  const label = getAttentionLabel(item.card);
  return (
    <article className={`admin-attention-row is-${item.card.readiness ?? "warning"}`}>
      <span className="admin-attention-icon" aria-hidden="true">
        <AlertTriangleIcon className="h-4 w-4" />
      </span>
      <div>
        <h3>{item.card.label}</h3>
        <p>{item.card.detail ?? label}</p>
      </div>
      <span className="admin-attention-state">{label}</span>
      {item.href ? <a href={item.href}>Review ↗</a> : null}
    </article>
  );
}

function getAttentionLabel(card: AdminGuildOverviewCard) {
  if (card.readiness === "needs_attention") return "Needs attention";
  if (card.readiness === "setup_incomplete") return "Setup incomplete";
  if (card.readiness === "ready_disabled") return "Ready but inactive";
  if (card.readiness === "dormant") return "Not currently effective";
  return "Status review";
}

function StorageWarningRow({
  warning,
  billingHref,
}: {
  warning: NonNullable<ReturnType<typeof getStorageWarning>>;
  billingHref: string;
}) {
  const { usage, accountedBytes, percentage } = warning;
  return (
    <article className="admin-attention-row is-storage-warning">
      <span className="admin-attention-icon" aria-hidden="true">
        <AlertTriangleIcon className="h-4 w-4" />
      </span>
      <div>
        <h3>Managed storage</h3>
        <p>
          {formatBytes(accountedBytes)} of {formatBytes(usage.maxBytes)} is in use
          {usage.reservedBytes > 0
            ? `, including ${formatBytes(usage.reservedBytes)} reserved`
            : ""}
          .
        </p>
      </div>
      <span className="admin-attention-state">{percentage}% used</span>
      <a href={billingHref}>Review plan ↗</a>
    </article>
  );
}

function HealthyState() {
  return (
    <section className="admin-healthy-state" aria-label="Guild configuration status">
      <span aria-hidden="true">
        <CheckIcon className="h-5 w-5" />
      </span>
      <div>
        <strong>Everything configured is operating normally</strong>
        <p>Healthy features stay out of the way. We will surface them here if they need review.</p>
      </div>
    </section>
  );
}

function AllFeatures({ items }: { items: OverviewItem[] }) {
  return (
    <section
      className="mt-6 rounded-lg border bg-card"
      aria-labelledby="all-features-heading"
      data-section="all-features"
    >
      <header className="border-b px-4 py-4 sm:px-5">
        <span className="text-xs font-semibold uppercase tracking-wide text-accent">
          Feature directory
        </span>
        <h2 id="all-features-heading" className="mt-1 text-lg font-semibold text-foreground">
          All features
        </h2>
      </header>
      <ul className="grid list-none grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li key={item.card.id} className="min-w-0">
            <AllFeatureItem item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AllFeatureItem({ item }: { item: OverviewItem }) {
  const { card, href } = item;
  const locked = card.locked || card.status === "requires-paid-plan";
  const attention = card.status === "attention" || card.readiness === "needs_attention";
  const state = getAllFeatureState(card);
  const className = [
    "flex h-full min-w-0 flex-col rounded-md border p-3 text-left no-underline transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    attention
      ? "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
      : locked
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-border bg-background hover:border-accent/60 hover:bg-muted/40",
  ].join(" ");
  const content = (
    <>
      <span className="flex min-w-0 items-start justify-between gap-3">
        <strong className="min-w-0 truncate text-sm font-semibold text-foreground">
          {card.label}
        </strong>
        <span
          className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold ${
            attention
              ? "border-destructive/40 text-destructive"
              : locked
                ? "border-amber-500/30 text-amber-200"
                : "border-border text-muted-foreground"
          }`}
        >
          {state}
        </span>
      </span>
      {locked ? (
        <span className="mt-2 text-xs leading-5 text-muted-foreground">
          {getLockedFeatureDescription(card)}
        </span>
      ) : !attention && card.detail ? (
        <span className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {card.detail}
        </span>
      ) : null}
    </>
  );

  if (locked) {
    const upgradeHref = buildBillingUpgradeHref(
      card,
      buildAdminDashboardHref("/admin/billing", item.workspaceId ?? "", item.guildId ?? ""),
    );
    return (
      <a
        href={upgradeHref}
        className={className}
        data-feature-id={card.id}
        data-feature-state={state}
        aria-label={`${card.label}: view plan options`}
      >
        {content}
        <span className="mt-3 text-xs font-semibold text-primary">View plan options ↗</span>
      </a>
    );
  }
  return href ? (
    <a href={href} className={className} data-feature-id={card.id} data-feature-state={state}>
      {content}
    </a>
  ) : (
    <article className={className} data-feature-id={card.id} data-feature-state={state}>
      {content}
    </article>
  );
}

const LOCKED_FEATURE_DESCRIPTIONS: Record<string, string> = {
  events: "Publish community events, collect sign-ups, and keep members informed.",
  "image-rules": "Review image content against your community's configured topics.",
  "bot-defense": "Detect automated accounts with honeypot and rate signals for staff review.",
  marketplace: "Run a structured marketplace with listings, trades, and audit history.",
  clans: "Give members persistent teams with private channels and managed roles.",
  "white-label-bot": "Operate a dedicated branded bot identity for this community.",
};

export function getLockedFeatureDescription(card: AdminGuildOverviewCard): string {
  return (
    LOCKED_FEATURE_DESCRIPTIONS[card.id] ??
    card.detail ??
    `${card.label} is available on a paid plan.`
  );
}

export function buildBillingUpgradeHref(
  card: AdminGuildOverviewCard,
  fallbackHref: string,
): string {
  const params = new URLSearchParams();
  params.set("feature", card.id);
  params.set("plan", "premium");
  if (fallbackHref.includes("workspaceId=")) {
    const existing = new URLSearchParams(fallbackHref.split("?")[1] ?? "");
    const workspaceId = existing.get("workspaceId");
    const guildId = existing.get("guildId");
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (guildId) params.set("guildId", guildId);
  }
  return `/admin/billing?${params.toString()}`;
}

function getAllFeatureState(card: AdminGuildOverviewCard) {
  if (card.locked || card.status === "requires-paid-plan") return "Paid plan";
  if (card.status === "attention" || card.readiness === "needs_attention") {
    return "Needs attention";
  }
  if (
    card.status === "not-set-up" ||
    card.readiness === "not_setup" ||
    card.readiness === "setup_incomplete"
  ) {
    return "Not set up";
  }
  if (
    card.status === "configured" &&
    (card.readiness === "ready_disabled" || card.readiness === "dormant")
  ) {
    return "Inactive";
  }
  return "Configured";
}

function RecommendedNextStepPanel({ step }: { step: RecommendedNextStep }) {
  return (
    <aside className="admin-ops-recommendation">
      <div>
        <span>Recommended next improvement</span>
        <strong>{step.title}</strong>
        <p>{step.description}</p>
      </div>
      <a href={step.ctaHref}>Set up ↗</a>
    </aside>
  );
}

function GoalOnboardingPanel({
  items,
  workspaceId,
  guildId,
}: {
  items: OverviewItem[];
  workspaceId: string;
  guildId: string;
}) {
  const itemsById = new Map(items.map((item) => [item.card.id, item]));

  return (
    <section className="mt-6 rounded-lg border bg-card p-5" aria-labelledby="goal-onboarding-title">
      <header className="max-w-3xl">
        <span className="text-xs font-semibold uppercase tracking-wide text-accent">
          Guided setup
        </span>
        <h2 id="goal-onboarding-title" className="mt-1 text-xl font-semibold text-foreground">
          Set up HAF around your goal
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose what you want to improve. HAF will recommend a sensible starting point, then send
          you to the feature that owns the setup.
        </p>
      </header>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {ONBOARDING_GOALS.map((goal) => {
          const recommendations = goal.recommendations.flatMap((recommendation) => {
            const item = itemsById.get(recommendation.featureId);
            return item ? [{ item, recommendation }] : [];
          });
          return (
            <details
              key={goal.key}
              className="group rounded-md border bg-background p-4"
              onToggle={(event) => {
                if (!event.currentTarget.open) return;
                void reportDashboardMilestone({
                  guildId,
                  workspaceId,
                  action: "onboarding_goal_selected",
                }).catch(() => undefined);
              }}
            >
              <summary className="cursor-pointer font-medium text-foreground">{goal.label}</summary>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{goal.prompt}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                <strong className="text-foreground">First success:</strong> {goal.firstSuccess}
              </p>
              <ol className="mt-4 space-y-3">
                {recommendations.map(({ item, recommendation }, index) => (
                  <li
                    key={item.card.id}
                    className="grid grid-cols-[auto_1fr_auto] gap-3 rounded-md border p-3"
                  >
                    <span className="text-xs font-semibold text-accent">{index + 1}</span>
                    <div>
                      <strong className="text-sm text-foreground">{item.card.label}</strong>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {recommendation.reason}
                      </p>
                    </div>
                    {item.card.locked || item.card.status === "requires-paid-plan" ? (
                      <a
                        className="text-xs font-medium text-accent underline"
                        href={buildBillingUpgradeHref(
                          item.card,
                          buildAdminDashboardHref("/admin/billing", workspaceId, guildId),
                        )}
                        aria-label={`${item.card.label}: view plan options`}
                      >
                        View plan options ↗
                      </a>
                    ) : item.href ? (
                      <a className="text-xs font-medium text-accent" href={item.href}>
                        {item.card.status === "not-set-up" ? "Set up ↗" : "Review ↗"}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ol>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatTier(tier: GuildEntitlementTier) {
  return tier === "premium_plus" ? "Premium Plus" : tier === "premium" ? "Premium" : "Free";
}

function buildFeatureCardHref(
  card: AdminGuildOverviewCard,
  workspaceId: string,
  guildId: string,
): string {
  if (!card.path) return "";

  const base = buildAdminDashboardHref(card.path, workspaceId, guildId);
  if (card.id === "reaction-rules") {
    const reactionRulesHref = buildReactionRulesTabHref(base, "blocklist");
    return card.status === "not-set-up" ? `${reactionRulesHref}&wizard=1` : reactionRulesHref;
  }
  if (card.id === "tickets") {
    const ticketsHref = buildTicketsTabHref(base, "panel");
    return card.status === "not-set-up" ? `${ticketsHref}&wizard=1` : ticketsHref;
  }
  if (card.id === "player-link") return buildPlayerLinkPlatformHref(base, "steam");
  return base;
}

export function GuildDirectoryEmptyCard({
  hasGuilds = false,
  allGuildsHidden,
  lookupError,
  workspaceId,
  onRefresh,
}: {
  hasGuilds?: boolean;
  allGuildsHidden: boolean;
  lookupError: string | null;
  workspaceId: string;
  onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-4 px-6 py-10">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold" role="status">
            {lookupError
              ? "Could not load your servers"
              : allGuildsHidden
                ? "Your servers are hidden"
                : hasGuilds
                  ? "Choose a server"
                  : "No servers available"}
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            {lookupError ||
              (allGuildsHidden
                ? "Your servers are hidden from the dashboard. Restore a server in Profile to continue."
                : hasGuilds
                  ? "Choose a server from Current guild. If you have hidden your servers, restore them in your profile."
                  : "Use the Discord account that owns the server or has Administrator or Manage Server permission. Add HAF to that server, then refresh this list.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {!lookupError && (
            <Button asChild>
              {allGuildsHidden ? (
                <a href={buildAdminDashboardHref("/admin/profile", workspaceId, "")}>
                  Restore hidden servers
                </a>
              ) : (
                <a href="/install" target="_blank" rel="noopener noreferrer">
                  Add HAF to a server
                </a>
              )}
            </Button>
          )}
          <Button
            variant="outline"
            loading={refreshing}
            loadingLabel="Refreshing…"
            onClick={() => {
              setRefreshing(true);
              void onRefresh()
                .catch(() => undefined)
                .finally(() => setRefreshing(false));
            }}
          >
            Refresh servers
          </Button>
          {hasGuilds && !allGuildsHidden && !lookupError ? (
            <a
              href={buildAdminDashboardHref("/admin/profile", workspaceId, "")}
              className="text-sm underline"
            >
              Manage hidden servers
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
