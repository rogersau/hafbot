import { useCallback, useState } from "react";

import type {
  AdminPermissionCheck,
  AdminPermissionDiagnosticsResponse,
  AdminPermissionFeature,
} from "../../runtime/admin-types";
import { AdminPageHeader } from "./admin-page-header";
import { SectionHeader, SettingsBlock } from "./admin-form-layout";
import { NoGuildSelected } from "./no-guild-selected";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/icons";
import { describeError, readJsonOrThrow } from "../lib/api";
import type { LoadedAdminRouteData } from "../lib/admin-route-loaders";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import { buildPlayerLinkPlatformHref, buildTicketsTabHref } from "../lib/admin-route-state";

const FEATURE_SECTIONS: Array<{
  feature: AdminPermissionFeature;
  label: string;
  description: string;
}> = [
  {
    feature: "blocklist",
    label: "Blocklist",
    description: "Reaction cleanup and text channel coverage.",
  },
  {
    feature: "timed-roles",
    label: "Timed Roles",
    description: "Role management permission and hierarchy checks.",
  },
  {
    feature: "tickets",
    label: "Tickets",
    description: "Panel, transcript, category, and support role access.",
  },
  {
    feature: "marketplace",
    label: "Marketplace",
    description: "Noticeboard and marketplace log channel access.",
  },
  {
    feature: "lfg",
    label: "LFG",
    description: "LFG noticeboard channel access.",
  },
  {
    feature: "player-count",
    label: "Player Count",
    description: "Voice channel rename access for live count updates.",
  },
  {
    feature: "wardogs",
    label: "WARDOGS",
    description: "Target credentials, secure connection approval, and read verification.",
  },
  {
    feature: "evidence-vault",
    label: "Evidence Vault",
    description: "Audit channel and access role checks.",
  },
  {
    feature: "managed-messages",
    label: "Managed Messages",
    description: "Published and draft destination channel access.",
  },
  {
    feature: "member-verification",
    label: "Member Verification",
    description: "Verified Role hierarchy and Welcome Panel access.",
  },
  {
    feature: "image-rules",
    label: "Image Rules",
    description: "Target-channel deletion and Image Rules Mod Queue access.",
  },
  {
    feature: "bot-defense",
    label: "Bot Defense",
    description: "Detector response and Bot Defense Mod Queue access.",
  },
  {
    feature: "mention-protection",
    label: "Mention Protection",
    description: "Message response, timeout, and Timed Role permissions.",
  },
  {
    feature: "player-link",
    label: "Player Link",
    description: "Linked-role hierarchy and panel/log access.",
  },
  {
    feature: "events",
    label: "Events",
    description: "Publish channel and optional Event thread access.",
  },
  {
    feature: "guild-audit-log",
    label: "Guild Audit Log",
    description: "Default audit destination access.",
  },
  {
    feature: "webhooks",
    label: "Webhooks",
    description: "Saved destination, routing, and regex configuration validity.",
  },
  {
    feature: "ban-cases",
    label: "Ban Cases",
    description: "Forum access and enabled Ban Case source readiness.",
  },
];

type DiagnosticsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      diagnostics: AdminPermissionDiagnosticsResponse;
      ranAtMs: number;
      refreshed: boolean;
    }
  | { kind: "error"; message: string };

export function AdminTroubleshootingPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: LoadedAdminRouteData<AdminPermissionDiagnosticsResponse> | null;
}) {
  const trimmedGuildId = selectedGuildId.trim();
  const trimmedWorkspaceId = selectedWorkspaceId.trim();
  const [state, setState] = useState<DiagnosticsState>(
    initialData
      ? {
          kind: "ready",
          diagnostics: initialData.data,
          ranAtMs: initialData.loadedAt,
          refreshed: false,
        }
      : { kind: "idle" },
  );
  const [filter, setFilter] = useState<DiagnosticFilter>("attention");

  const loadDiagnostics = useCallback(
    async (refresh = false) => {
      if (!trimmedGuildId) {
        setState({ kind: "idle" });
        return;
      }

      setState({ kind: "loading" });
      try {
        const params = new URLSearchParams({ guildId: trimmedGuildId });
        if (trimmedWorkspaceId) {
          params.set("workspaceId", trimmedWorkspaceId);
        }
        if (refresh) {
          params.set("refresh", "1");
        }
        const diagnostics = await readJsonOrThrow<AdminPermissionDiagnosticsResponse>(
          `/admin/api/permissions/diagnostics?${params.toString()}`,
        );
        setState({ kind: "ready", diagnostics, ranAtMs: Date.now(), refreshed: refresh });
      } catch (error) {
        setState({ kind: "error", message: describeError(error) });
      }
    },
    [trimmedGuildId, trimmedWorkspaceId],
  );

  return (
    <section className="admin-feature-page admin-page-system space-y-6">
      <AdminPageHeader title="Troubleshooting" />

      {!trimmedGuildId ? (
        <NoGuildSelected
          feature="troubleshooting diagnostics"
          description="Pick a server from the sidebar to run Discord permission diagnostics on demand."
        />
      ) : (
        <SettingsBlock>
          <SectionHeader
            title="Discord diagnostics"
            description="Checks bot permissions across the configured moderation features for this server."
            actions={
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => void loadDiagnostics(true)}
                disabled={state.kind === "loading"}
              >
                <RefreshIcon className="h-4 w-4" />
                {state.kind === "loading" ? "Checking..." : "Recheck setup"}
              </Button>
            }
          />
          <div className="space-y-4">
            {state.kind === "error" ? (
              <Alert variant="destructive">
                <AlertDescription>{state.message}</AlertDescription>
              </Alert>
            ) : null}

            {state.kind === "loading" ? (
              <p className="text-sm text-muted-foreground">
                Running Discord permission diagnostics...
              </p>
            ) : null}

            {state.kind === "ready"
              ? (() => {
                  const sections = FEATURE_SECTIONS.map(({ feature, label, description }) => {
                    const checks = state.diagnostics.checksByFeature[feature] ?? [];
                    const failingChecks = checks.filter((check) => check.status !== "ok");
                    const status = getDiagnosticStatus(checks);

                    return { feature, label, description, checks, failingChecks, status };
                  })
                    .filter(
                      (section) =>
                        filter === "all" ||
                        (filter === "configured"
                          ? section.status !== "unconfigured"
                          : section.status === "danger" ||
                            section.status === "warning" ||
                            section.status === "unconfigured"),
                    )
                    .sort(
                      (left, right) =>
                        diagnosticPriority(left.status) - diagnosticPriority(right.status),
                    );

                  const counts = FEATURE_SECTIONS.reduce(
                    (result, { feature }) => {
                      const checks = state.diagnostics.checksByFeature[feature] ?? [];
                      const failing = checks.filter((check) => check.status !== "ok");
                      if (failing.some((check) => check.status === "error")) result.errors += 1;
                      else if (failing.length > 0) result.warnings += 1;
                      else if (checks.length === 0) result.unconfigured += 1;
                      else result.healthy += 1;
                      return result;
                    },
                    { errors: 0, warnings: 0, healthy: 0, unconfigured: 0 },
                  );

                  return (
                    <>
                      <div
                        className="rounded-md border bg-muted/10 p-4"
                        aria-label="Diagnostic summary"
                      >
                        <div className="flex flex-wrap gap-3 text-sm">
                          <SummaryCount label="Errors" value={counts.errors} tone="danger" />
                          <SummaryCount label="Warnings" value={counts.warnings} tone="warning" />
                          <SummaryCount label="Healthy" value={counts.healthy} tone="success" />
                          <SummaryCount
                            label="Not configured"
                            value={counts.unconfigured}
                            tone="muted"
                          />
                        </div>
                        <div
                          className="mt-3 flex flex-wrap gap-2"
                          role="group"
                          aria-label="Diagnostic filters"
                        >
                          {(
                            [
                              ["attention", "Needs attention"],
                              ["configured", "All configured"],
                              ["all", "All features"],
                            ] as const
                          ).map(([value, label]) => (
                            <Button
                              key={value}
                              size="sm"
                              variant={filter === value ? "default" : "outline"}
                              aria-pressed={filter === value}
                              onClick={() => setFilter(value)}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">
                          Last run {new Date(state.ranAtMs).toLocaleString()}
                          {state.refreshed
                            ? " · forced Discord-cache refresh"
                            : " · cached Discord data"}
                          .
                        </p>
                      </div>
                      {sections.map(
                        ({ feature, label, description, checks, failingChecks, status }) => {
                          const href = buildTroubleshootingFeatureHref(
                            feature,
                            trimmedWorkspaceId,
                            trimmedGuildId,
                          );
                          const tone =
                            status === "danger"
                              ? "danger"
                              : status === "warning"
                                ? "warning"
                                : "success";

                          return (
                            <div
                              id={`feature-${feature}`}
                              key={feature}
                              className="scroll-mt-6 rounded-lg border bg-muted/10 p-4 space-y-3"
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="space-y-1">
                                  <p className="text-sm font-medium text-foreground">{label}</p>
                                  <p className="text-sm text-muted-foreground">{description}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Badge variant={status === "unconfigured" ? "default" : tone}>
                                    {status === "unconfigured"
                                      ? "Not configured"
                                      : status === "healthy"
                                        ? "Healthy"
                                        : `${failingChecks.length} issue${failingChecks.length === 1 ? "" : "s"}`}
                                  </Badge>
                                  <a
                                    className="text-xs font-medium text-primary underline"
                                    href={href}
                                  >
                                    Review configuration
                                  </a>
                                </div>
                              </div>

                              {checks.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                  Save this feature&apos;s configuration before checking its setup.
                                </p>
                              ) : failingChecks.length === 0 ? (
                                <details className="text-sm text-muted-foreground">
                                  <summary className="cursor-pointer">Show healthy details</summary>
                                  <p className="mt-2">
                                    All current checks passed for this feature.
                                  </p>
                                </details>
                              ) : (
                                <div className="space-y-2">
                                  {failingChecks.map((check) => (
                                    <DiagnosticCheckRow
                                      key={`${feature}:${check.id}`}
                                      check={check}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        },
                      )}
                    </>
                  );
                })()
              : null}
          </div>
        </SettingsBlock>
      )}
    </section>
  );
}

type DiagnosticFilter = "attention" | "configured" | "all";
type DiagnosticStatus = "danger" | "warning" | "unconfigured" | "healthy";

export function diagnosticPriority(status: DiagnosticStatus): number {
  return status === "danger" ? 0 : status === "warning" ? 1 : status === "unconfigured" ? 2 : 3;
}

export function getDiagnosticStatus(
  checks: Pick<AdminPermissionCheck, "status">[],
): DiagnosticStatus {
  if (checks.some((check) => check.status === "error")) return "danger";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return checks.length === 0 ? "unconfigured" : "healthy";
}

function SummaryCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "danger" | "warning" | "success" | "muted";
}) {
  return (
    <span
      className={`rounded border px-2 py-1 ${tone === "danger" ? "border-destructive/40 text-destructive" : tone === "warning" ? "border-amber-500/40 text-amber-700" : tone === "success" ? "border-emerald-500/40 text-emerald-700" : "text-muted-foreground"}`}
    >
      <strong>{value}</strong> {label}
    </span>
  );
}

const TROUBLESHOOTING_PATHS: Record<AdminPermissionFeature, string> = {
  blocklist: "/admin/blocklist",
  "timed-roles": "/admin/timed-roles",
  tickets: "/admin/tickets",
  marketplace: "/admin/marketplace",
  lfg: "/admin/lfg",
  "player-count": "/admin/playercount",
  wardogs: "/admin/wardogs",
  "server-levels": "/admin/server-levels",
  "evidence-vault": "/admin/evidence-vault",
  "managed-messages": "/admin/managed-messages",
  "member-verification": "/admin/member-verification",
  "image-rules": "/admin/image-rules",
  "bot-defense": "/admin/bot-defense",
  "mention-protection": "/admin/mention-protection",
  "player-link": "/admin/player-link",
  events: "/admin/events",
  "guild-audit-log": "/admin/audit-log",
  webhooks: "/admin/webhooks",
  "ban-cases": "/admin/ban-cases",
};

export function buildTroubleshootingFeatureHref(
  feature: AdminPermissionFeature,
  workspaceId: string,
  guildId: string,
): string {
  const base = buildAdminDashboardHref(TROUBLESHOOTING_PATHS[feature], workspaceId, guildId);
  if (feature === "tickets") return buildTicketsTabHref(base, "setup");
  if (feature === "player-link") return buildPlayerLinkPlatformHref(base, "steam");
  return base;
}

function DiagnosticCheckRow({ check }: { check: AdminPermissionCheck }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-background/70 p-3 space-y-1">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{check.label}</p>
        <Badge
          variant={
            check.status === "error" ? "danger" : check.status === "warning" ? "warning" : "success"
          }
        >
          {check.status}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{check.detail}</p>
      {check.remediation ? (
        <p className="text-sm font-medium text-foreground">Next step: {check.remediation}</p>
      ) : null}
    </div>
  );
}
