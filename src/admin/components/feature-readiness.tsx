import { useCallback, useEffect, useState } from "react";

import type {
  AdminPermissionCheck,
  AdminPermissionDiagnosticsResponse,
  AdminPermissionFeature,
} from "../../runtime/admin-types";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import { describeError, readJsonOrThrow } from "../lib/api";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/icons";
import { useSetupCheckDirtyState } from "./setup-check-dirty-state";

type ReadinessState =
  | { kind: "loading" }
  | { kind: "ready"; checks: AdminPermissionCheck[] }
  | { kind: "unavailable"; message: string };

export function FeatureReadiness({
  feature,
  selectedGuildId,
  selectedWorkspaceId,
}: {
  feature: AdminPermissionFeature;
  selectedGuildId: string;
  selectedWorkspaceId: string;
}) {
  const guildId = selectedGuildId.trim();
  const workspaceId = selectedWorkspaceId.trim();
  const [state, setState] = useState<ReadinessState>({ kind: "loading" });
  const { hasUnsavedChanges } = useSetupCheckDirtyState();

  const load = useCallback(
    async (refresh = false) => {
      if (!guildId) return;
      setState({ kind: "loading" });
      try {
        const params = new URLSearchParams({ guildId });
        if (workspaceId) params.set("workspaceId", workspaceId);
        if (refresh) params.set("refresh", "1");
        const diagnostics = await readJsonOrThrow<AdminPermissionDiagnosticsResponse>(
          `/admin/api/permissions/diagnostics?${params.toString()}`,
        );
        setState({ kind: "ready", checks: diagnostics.checksByFeature[feature] ?? [] });
      } catch (error) {
        setState({ kind: "unavailable", message: describeError(error) });
      }
    },
    [feature, guildId, workspaceId],
  );

  useEffect(() => {
    if (guildId) void load(false);
  }, [guildId, load]);

  if (!guildId) return null;
  const troubleshootingHref = buildFeatureTroubleshootingHref(feature, workspaceId, guildId);
  const summary = summarizeFeatureReadiness(state, hasUnsavedChanges);

  if (shouldHideFeatureReadiness(state, hasUnsavedChanges)) return null;

  return (
    <aside
      className={`flex flex-wrap items-center justify-end gap-2 text-sm ${summary.tone}`}
      aria-live="polite"
      data-feature-readiness={feature}
    >
      <span title={summary.detail}>{summary.label}</span>
      {state.kind === "ready" && summary.problem ? (
        <a className="underline underline-offset-4" href={troubleshootingHref}>
          Review setup
        </a>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 gap-1"
        disabled={state.kind === "loading" || hasUnsavedChanges}
        onClick={() => void load(true)}
      >
        <RefreshIcon className="h-3.5 w-3.5" />
        {state.kind === "loading" ? "Checking…" : "Recheck setup"}
      </Button>
    </aside>
  );
}

export function shouldHideFeatureReadiness(
  state: ReadinessState,
  hasUnsavedChanges = false,
): boolean {
  if (hasUnsavedChanges || state.kind !== "ready" || state.checks.length === 0) return false;
  return state.checks.every((check) => check.status === "ok");
}

export function buildFeatureTroubleshootingHref(
  feature: AdminPermissionFeature,
  workspaceId: string,
  guildId: string,
): string {
  return `${buildAdminDashboardHref(
    "/admin/troubleshooting",
    workspaceId,
    guildId,
  )}#feature-${feature}`;
}

export function summarizeFeatureReadiness(
  state: ReadinessState,
  hasUnsavedChanges = false,
): {
  label: string;
  detail: string;
  tone: string;
  problem: boolean;
} {
  if (hasUnsavedChanges) {
    return {
      label: "Setup check: Unsaved changes",
      detail: "Checks describe the saved configuration. Save your changes before rechecking.",
      tone: "text-amber-600",
      problem: true,
    };
  }
  if (state.kind === "loading") {
    return {
      label: "Setup check: Checking…",
      detail: "",
      tone: "text-muted-foreground",
      problem: false,
    };
  }
  if (state.kind === "unavailable") {
    return {
      label: "Setup check unavailable",
      detail: state.message,
      tone: "text-muted-foreground",
      problem: false,
    };
  }
  const failing =
    state.checks.find((check) => check.status === "error") ??
    state.checks.find((check) => check.status === "warning");
  if (state.checks.length === 0) {
    return {
      label: "Setup check: Not configured",
      detail: "Save this feature's configuration before checking its setup.",
      tone: "text-amber-600",
      problem: true,
    };
  }
  if (!failing) {
    return {
      label: "Setup check: Passed",
      detail: "All current setup checks passed.",
      tone: "text-emerald-600",
      problem: false,
    };
  }
  const missing = /Manage Roles is missing/i.test(failing.detail)
    ? "Missing Manage Roles"
    : failing.label;
  return {
    label: `Setup check: ${missing}`,
    detail: failing.detail,
    tone: failing.status === "error" ? "text-destructive" : "text-amber-600",
    problem: true,
  };
}
