import { useEffect, useRef, useState } from "react";

import type { TicketPanelConfig } from "../../types";
import { ticketsClient } from "../generated/admin-client/tickets";
import { cn } from "../lib/utils";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge, type BadgeProps } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { EmptyState } from "./ui/empty-state";
import { ClockIcon, RefreshIcon } from "./ui/icons";
import { useToast } from "./toast";

type RevisionPage = Awaited<ReturnType<typeof ticketsClient.revisions>>;
type RevisionSummary = RevisionPage["revisions"][number];
type RevisionDetail = Awaited<ReturnType<typeof ticketsClient.revision>>;
type RestorePreviewResponse = Awaited<ReturnType<typeof ticketsClient.restorePreview>>;

export function TicketPanelHistory({
  selectedWorkspaceId,
  guildId,
  panelId,
  onRestored,
}: {
  selectedWorkspaceId: string;
  guildId: string;
  panelId: string;
  onRestored: (panel: TicketPanelConfig | null) => void | Promise<void>;
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyVersion = useRef(0);
  const detailRequest = useRef(0);
  const loadMorePending = useRef(false);
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();

  // eslint-disable-next-line custom/no-use-effect -- History follows the selected Guild and panel.
  useEffect(() => {
    setRevisions([]);
    setNextCursor(null);
    setDetail(null);
    setRestorePreview(null);
    void loadRevisions();
    return () => {
      historyVersion.current += 1;
    };
  }, [guildId, panelId, selectedWorkspaceId]);

  async function loadRevisions() {
    const version = ++historyVersion.current;
    loadMorePending.current = false;
    setLoading(true);
    setLoadingMore(false);
    setLoadingDetail(false);
    setRestoring(false);
    setError(null);
    try {
      const page = await ticketsClient.revisions({
        workspaceId: selectedWorkspaceId || undefined,
        guildId,
        panelId,
        limit: "50",
      });
      if (version !== historyVersion.current) return;
      setRevisions(page.revisions);
      setNextCursor(page.nextCursor);
      setDetail(null);
      setRestorePreview(null);
    } catch (reason) {
      if (version !== historyVersion.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to load Ticket Panel history.");
    } finally {
      if (version === historyVersion.current) setLoading(false);
    }
  }

  async function loadOlderRevisions() {
    if (loading || restoring || loadMorePending.current || nextCursor === null) return;
    const version = historyVersion.current;
    loadMorePending.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await ticketsClient.revisions({
        workspaceId: selectedWorkspaceId || undefined,
        guildId,
        panelId,
        limit: "50",
        beforeCreatedAtMs: String(nextCursor),
      });
      if (version !== historyVersion.current) return;
      setRevisions((current) => {
        const seen = new Set(current.map((revision) => revision.id));
        const older = page.revisions.filter((revision) => {
          if (seen.has(revision.id)) return false;
          seen.add(revision.id);
          return true;
        });
        return [...current, ...older];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (version !== historyVersion.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Older Ticket Panel changes could not be loaded.",
      );
    } finally {
      if (version === historyVersion.current) {
        loadMorePending.current = false;
        setLoadingMore(false);
      }
    }
  }

  async function reviewRevision(revision: RevisionSummary) {
    if (restoring) return;
    const version = historyVersion.current;
    const request = ++detailRequest.current;
    setLoadingDetail(true);
    setError(null);
    try {
      const nextDetail = await ticketsClient.revision({
        workspaceId: selectedWorkspaceId || undefined,
        guildId,
        revisionId: revision.id,
      });
      if (version !== historyVersion.current || request !== detailRequest.current) return;
      setDetail(nextDetail);
      setRestorePreview(null);
    } catch (reason) {
      if (version !== historyVersion.current || request !== detailRequest.current) return;
      setDetail(null);
      setRestorePreview(null);
      setError(reason instanceof Error ? reason.message : "Failed to load this revision.");
    } finally {
      if (version === historyVersion.current && request === detailRequest.current) {
        setLoadingDetail(false);
      }
    }
  }

  async function previewRestore() {
    if (!detail || restoring) return;
    const version = historyVersion.current;
    const request = detailRequest.current;
    setRestoring(true);
    setError(null);
    try {
      const preview = await ticketsClient.restorePreview({
        guildId,
        workspaceId: selectedWorkspaceId || undefined,
        revisionId: detail.revision.id,
      });
      if (version !== historyVersion.current || request !== detailRequest.current) return;
      setRestorePreview(preview);
    } catch (reason) {
      if (version !== historyVersion.current || request !== detailRequest.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to prepare this restore.");
    } finally {
      if (version === historyVersion.current && request === detailRequest.current) {
        setRestoring(false);
      }
    }
  }

  async function restoreRevision() {
    if (!detail || !restorePreview) return;
    const version = historyVersion.current;
    const request = detailRequest.current;
    const confirmed = await confirm({
      title: restorePreview.destructive
        ? "Delete this Ticket Panel through restore?"
        : "Restore this Ticket Panel revision?",
      description: [
        "The server will revalidate this preview before it changes anything and will record a new history entry.",
        ...restorePreview.warnings,
      ].join(" "),
      confirmLabel: "Restore revision",
      variant: "destructive",
    });
    if (!confirmed || version !== historyVersion.current || request !== detailRequest.current) {
      return;
    }

    setRestoring(true);
    setError(null);
    try {
      const response = await ticketsClient.restoreRevision({
        guildId,
        workspaceId: selectedWorkspaceId || undefined,
        revisionId: detail.revision.id,
        previewToken: restorePreview.previewToken,
      });
      if (version !== historyVersion.current || request !== detailRequest.current) return;
      await onRestored(response.panel);
      toast.success("Ticket Panel revision restored.");
    } catch (reason) {
      if (version !== historyVersion.current || request !== detailRequest.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to restore this revision.");
    } finally {
      if (version === historyVersion.current && request === detailRequest.current) {
        setRestoring(false);
      }
    }
  }

  return (
    <Card>
      {confirmDialog}
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-lg">Panel revision history</CardTitle>
            <Badge variant="info">Premium</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Review saved versions and restore an earlier Ticket Panel configuration.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-2"
          disabled={loading || loadingMore || restoring}
          onClick={() => void loadRevisions()}
        >
          <RefreshIcon className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {loading ? (
          <EmptyState>Loading Ticket Panel revision history...</EmptyState>
        ) : revisions.length === 0 ? (
          <EmptyState>No revisions have been recorded for this panel yet.</EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-3">
              <div className="divide-y rounded-md border">
                {revisions.map((revision, index) => (
                  <button
                    key={revision.id}
                    type="button"
                    disabled={restoring}
                    className={cn(
                      "flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-accent/60",
                      detail?.revision.id === revision.id && "bg-accent",
                    )}
                    onClick={() => void reviewRevision(revision)}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={revisionBadgeVariant(revision.operation)}>
                          {revisionOperationLabel(revision.operation)}
                        </Badge>
                        {index === 0 ? <Badge variant="success">Current</Badge> : null}
                      </div>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ClockIcon className="h-3.5 w-3.5" />
                        {formatRevisionDate(revision.createdAtMs)}
                      </p>
                    </div>
                    <span className="text-xs font-medium text-primary">Review</span>
                  </button>
                ))}
              </div>
              {nextCursor !== null ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={loadingMore || restoring}
                  loading={loadingMore}
                  loadingLabel="Loading older changes…"
                  onClick={() => void loadOlderRevisions()}
                >
                  Load older changes
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground" role="status">
                  All recorded changes are shown.
                </p>
              )}
            </div>
            <RevisionPreview
              detail={detail}
              restorePreview={restorePreview}
              loading={loadingDetail}
              restoring={restoring}
              onPreview={() => void previewRestore()}
              onRestore={() => void restoreRevision()}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RevisionPreview({
  detail,
  restorePreview,
  loading,
  restoring,
  onPreview,
  onRestore,
}: {
  detail: RevisionDetail | null;
  restorePreview: RestorePreviewResponse | null;
  loading: boolean;
  restoring: boolean;
  onPreview: () => void;
  onRestore: () => void;
}) {
  if (loading) return <EmptyState>Loading revision preview...</EmptyState>;
  if (!detail) return <EmptyState>Select a revision to preview its saved settings.</EmptyState>;

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div>
        <h3 className="font-display font-semibold">Restore preview</h3>
        <p className="text-xs text-muted-foreground">
          Saved {formatRevisionDate(detail.revision.createdAtMs)}
        </p>
      </div>
      {!restorePreview ? (
        <Alert>
          <AlertDescription>
            Review the saved change below, then ask the server to validate a restore against the
            current configuration, plan, and Discord resources.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {restorePreview.warnings.map((warning) => (
            <Alert key={warning} variant={restorePreview.destructive ? "destructive" : "default"}>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}
          <div className="max-h-[30rem] divide-y overflow-y-auto rounded-md border">
            {restorePreview.diff.map((entry) => (
              <div key={`${entry.path}:${entry.kind}`} className="space-y-2 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {entry.label ?? formatRevisionPath(entry.path)}
                  </span>
                  <Badge variant={diffBadgeVariant(entry.kind)}>{entry.kind}</Badge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <DiffValue label="Current" value={entry.before} />
                  <DiffValue label="Restored" value={entry.after} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="destructive"
          disabled={restoring}
          onClick={restorePreview ? onRestore : onPreview}
        >
          {restoring
            ? "Validating..."
            : restorePreview
              ? "Restore this revision"
              : "Preview restore"}
        </Button>
      </div>
    </div>
  );
}

function DiffValue({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/30 p-2">
      <p className="mb-1 text-[0.7rem] font-medium uppercase text-muted-foreground">{label}</p>
      <p className="break-words font-mono text-xs">{value ?? "Not set"}</p>
    </div>
  );
}

function revisionOperationLabel(operation: RevisionSummary["operation"]): string {
  return operation === "baseline"
    ? "Baseline"
    : operation === "create"
      ? "Created"
      : operation === "update"
        ? "Updated"
        : operation === "delete"
          ? "Deleted"
          : operation === "restore"
            ? "Restored"
            : "Cloned";
}

export function formatRevisionPath(path: string): string {
  const labels: string[] = [];
  for (const segment of path.split(".")) {
    if (/^\d+$/.test(segment)) {
      const previous = labels.pop();
      labels.push(previous ? `${previous} #${segment}` : `#${segment}`);
      continue;
    }
    const words = segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(" ")
      .filter(Boolean)
      .map((word, index) => {
        if (word.toLowerCase() === "id") return "ID";
        const lower = word.toLowerCase();
        return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
      });
    labels.push(words.join(" "));
  }
  return labels.join(" › ");
}

function formatRevisionDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function revisionBadgeVariant(
  operation: RevisionSummary["operation"],
): NonNullable<BadgeProps["variant"]> {
  return operation === "delete"
    ? "danger"
    : operation === "restore"
      ? "success"
      : operation === "baseline"
        ? "default"
        : "info";
}

function diffBadgeVariant(
  kind: RestorePreviewResponse["diff"][number]["kind"],
): NonNullable<BadgeProps["variant"]> {
  return kind === "removed" ? "danger" : kind === "added" ? "success" : "warning";
}
