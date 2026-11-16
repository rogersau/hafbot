import { transitionRestore, restoreIsCommitted } from "../lib/restore-workflow";
import { useEffect, useReducer, useState } from "react";
import { useAdminApi } from "../hooks/use-admin-api";

import type { ConfigurationFeatureKey } from "../../configuration-revisions";
import { configurationRevisionsClient } from "../generated/admin-client/configuration-revisions";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { useToast } from "./toast";
import { copyTextToClipboard } from "../lib/clipboard";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type RevisionPage = Awaited<ReturnType<typeof configurationRevisionsClient.list>>;
type Revision = RevisionPage["revisions"][number];
type Diff = Awaited<ReturnType<typeof configurationRevisionsClient.compare>>["diff"];
type RestorePreview = Awaited<ReturnType<typeof configurationRevisionsClient.restorePreview>>;

export function ConfigurationHistoryCard({
  guildId,
  workspaceId,
  feature,
  resourceKey = "default",
  enabled,
  hasUnsavedChanges = false,
  onDiscardUnsavedChanges,
  onRestoreCompleted,
  onReconciliationPendingChange,
}: {
  guildId: string;
  workspaceId: string;
  feature: ConfigurationFeatureKey;
  resourceKey?: string;
  enabled: boolean;
  hasUnsavedChanges?: boolean | (() => boolean);
  onDiscardUnsavedChanges?: () => void;
  onRestoreCompleted?: () => Promise<void>;
  onReconciliationPendingChange?: (pending: boolean) => void;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<Revision | null>(null);
  const [diff, setDiff] = useState<Diff>([]);
  const [listLoading, setListLoading] = useState(enabled);
  const [listError, setListError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [restoreState, sendRestore] = useReducer(transitionRestore<RestorePreview>, {
    kind: "editing",
  });
  const { run: runPreview, cancel: cancelPreview } = useAdminApi();
  const restorePreview = "preview" in restoreState ? restoreState.preview : null;
  const restoreCommitted = restoreIsCommitted(restoreState);
  const previewing = restoreState.kind === "previewing";
  const restoring = restoreState.kind === "restoring" || restoreState.kind === "confirming";
  const previewError = restoreState.kind === "preview-failed" ? restoreState.error : null;
  const restoreError = restoreState.kind === "restore-failed" ? restoreState.error : null;
  const reconciliationError = restoreState.kind === "refresh-failed" ? restoreState.error : null;
  const [unsavedChangesResolved, setUnsavedChangesResolved] = useState(false);
  const [secretReplacements, setSecretReplacements] = useState<Record<string, string>>({});
  const [omittedSecretSlots, setOmittedSecretSlots] = useState<string[]>([]);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const { dialog, confirm } = useConfirmDialog();
  const toast = useToast();

  // eslint-disable-next-line custom/no-use-effect -- Revision history follows the selected Guild resource.
  useEffect(() => {
    if (!enabled || !guildId) {
      setListLoading(false);
      setRevisions([]);
      setNextCursor(null);
      return;
    }
    let active = true;
    setListLoading(true);
    setListError(null);
    void configurationRevisionsClient
      .list({
        guildId,
        workspaceId: workspaceId || undefined,
        feature,
        resourceKey,
        limit: "20",
      })
      .then((page) => {
        if (active) {
          setRevisions(page.revisions);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setListError(reason instanceof Error ? reason.message : "History failed to load.");
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, feature, guildId, refreshVersion, resourceKey, workspaceId]);

  if (!enabled) return null;

  async function loadMore() {
    if (listLoading || nextCursor === null) return;
    setListLoading(true);
    setListError(null);
    try {
      const page = await configurationRevisionsClient.list({
        guildId,
        workspaceId: workspaceId || undefined,
        feature,
        resourceKey,
        limit: "20",
        beforeCreatedAtMs: String(nextCursor),
      });
      setRevisions((current) => {
        return mergeConfigurationRevisionPages(current, page.revisions);
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : "More history failed to load.");
    } finally {
      setListLoading(false);
    }
  }

  async function review(revision: Revision, preserveRestoreInputs = false) {
    if (compareLoading || restoring || restoreCommitted) return;
    setSelected(revision);
    if (!preserveRestoreInputs) {
      cancelPreview();
      sendRestore({ type: "reset" });
      setSecretReplacements({});
      setOmittedSecretSlots([]);
      setUnsavedChangesResolved(false);
    }
    setCompareLoading(true);
    setCompareError(null);
    try {
      const comparison = await configurationRevisionsClient.compare({
        guildId,
        workspaceId: workspaceId || undefined,
        beforeRevisionId: revision.previousRevisionId ?? undefined,
        afterRevisionId: revision.id,
      });
      setDiff(comparison.diff);
    } catch (reason) {
      setDiff([]);
      setCompareError(reason instanceof Error ? reason.message : "Revision comparison failed.");
    } finally {
      setCompareLoading(false);
    }
  }

  async function previewRestore() {
    if (!selected) return;
    if (previewing || restoring || restoreCommitted) return;
    const editorHasUnsavedChanges = readConfigurationEditorDirtyState(hasUnsavedChanges);
    if (editorHasUnsavedChanges && !unsavedChangesResolved) {
      const discard = await confirm({
        title: "Discard unsaved edits before restoring?",
        description:
          "Restoring replaces the saved configuration. Discard the current editor changes before previewing this revision.",
        confirmLabel: "Discard edits and continue",
        variant: "destructive",
      });
      if (!discard) return;
      onDiscardUnsavedChanges?.();
      setUnsavedChangesResolved(true);
    }
    sendRestore({ type: "preview-started" });
    await runPreview(
      () =>
        configurationRevisionsClient.restorePreview({
          guildId,
          workspaceId: workspaceId || undefined,
          feature,
          resourceKey,
          revisionId: selected.id,
          secretReplacements: Object.entries(secretReplacements)
            .filter(([, value]) => value.trim())
            .map(([slot, value]) => ({ slot, value })),
          omittedSecretSlots,
        }),
      (preview) => sendRestore({ type: "preview-created", preview }),
      (error) =>
        sendRestore({
          type: "preview-failed",
          error,
        }),
    );
  }

  async function restoreRevision() {
    if (!selected || !restorePreview) return;
    if (restoring || previewing || restoreCommitted) return;
    sendRestore({ type: "confirmation-started" });
    const accepted = await confirm({
      title: restorePreview.destructive
        ? "Delete this configuration through restore?"
        : "Restore this configuration revision?",
      description:
        "The server will revalidate the configuration, entitlement, Discord resources, and revision head before committing a new append-only restore revision.",
      confirmLabel: "Restore revision",
      variant: "destructive",
    });
    if (!accepted) {
      sendRestore({ type: "confirmation-cancelled" });
      return;
    }
    sendRestore({ type: "restore-started" });
    try {
      await configurationRevisionsClient.restoreRevision({
        guildId,
        workspaceId: workspaceId || undefined,
        feature,
        resourceKey,
        revisionId: selected.id,
        previewToken: restorePreview.previewToken,
        secretReplacements: Object.entries(secretReplacements)
          .filter(([, value]) => value.trim())
          .map(([slot, value]) => ({ slot, value })),
        omittedSecretSlots,
      });
      sendRestore({ type: "restore-committed" });
      toast.success("Configuration revision restored. Refreshing the editor...");
      setRefreshVersion((version) => version + 1);
      await reconcileParentEditor();
    } catch (reason) {
      sendRestore({
        type: "restore-failed",
        error: reason instanceof Error ? reason.message : "Configuration restore failed.",
      });
    }
  }

  async function reconcileParentEditor() {
    sendRestore({ type: "refresh-started" });
    onReconciliationPendingChange?.(true);
    const result = await refreshRestoredConfiguration(onRestoreCompleted);
    if (result.ok) {
      setSelected(null);
      sendRestore({ type: "refresh-completed" });
      setUnsavedChangesResolved(false);
      toast.success("Restored configuration is now shown in the editor.");
      onReconciliationPendingChange?.(false);
    } else {
      sendRestore({ type: "refresh-failed", error: result.message });
    }
  }

  async function copyMetadata(value: string) {
    try {
      await copyTextToClipboard(value);
      setCopiedValue(value);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Reference could not be copied.");
    }
  }

  const exportHref = buildExportHref(guildId, workspaceId);
  const displayedDiff = restorePreview?.diff ?? diff;
  return (
    <Card>
      {dialog}
      <Dialog open={restoreCommitted} onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restored configuration is refreshing</DialogTitle>
            <DialogDescription>
              The restore was committed. Editing remains blocked until this page shows the
              authoritative restored configuration.
            </DialogDescription>
          </DialogHeader>
          {reconciliationError ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{reconciliationError}</p>
                <Button
                  className="mt-2"
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void reconcileParentEditor()}
                >
                  Retry editor refresh
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">Refreshing editor configuration...</p>
          )}
        </DialogContent>
      </Dialog>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg">Configuration history</CardTitle>
            <Badge variant="info">Premium</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Review append-only, redacted changes to this configuration.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={exportHref} download>
            Export JSON
          </a>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {listError ? (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{listError}</p>
              <Button
                className="mt-2"
                type="button"
                size="sm"
                variant="outline"
                disabled={listLoading}
                onClick={() => setRefreshVersion((version) => version + 1)}
              >
                Retry history
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {listLoading && revisions.length === 0 ? (
          <EmptyState>Loading configuration history...</EmptyState>
        ) : revisions.length === 0 ? (
          <EmptyState>History begins with the next saved change.</EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.3fr)]">
            <div className="divide-y rounded-md border">
              {revisions.map((revision) => (
                <RevisionRow
                  key={revision.id}
                  revision={revision}
                  selected={selected?.id === revision.id}
                  copiedValue={copiedValue}
                  disabled={compareLoading}
                  onReview={() => void review(revision)}
                  onCopy={(value) => void copyMetadata(value)}
                />
              ))}
              {nextCursor !== null ? (
                <div className="p-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={listLoading}
                    disabled={listLoading}
                    onClick={() => void loadMore()}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </div>
            {compareLoading ? (
              <EmptyState>Loading revision comparison...</EmptyState>
            ) : compareError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  <p>{compareError}</p>
                  <Button
                    className="mt-2"
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!selected || compareLoading}
                    onClick={() => selected && void review(selected, true)}
                  >
                    Retry comparison
                  </Button>
                </AlertDescription>
              </Alert>
            ) : !selected ? (
              <EmptyState>Select a revision to inspect its safe diff.</EmptyState>
            ) : displayedDiff.length === 0 ? (
              <EmptyState>This revision contains no displayable configuration changes.</EmptyState>
            ) : (
              <div className="max-h-[28rem] divide-y overflow-y-auto rounded-md border">
                {displayedDiff.map((entry) => (
                  <div key={`${entry.path}:${entry.kind}`} className="space-y-2 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{entry.label ?? entry.path}</span>
                      <Badge variant={entry.kind === "removed" ? "danger" : "info"}>
                        {entry.kind}
                      </Badge>
                    </div>
                    <div className="grid gap-2 text-xs sm:grid-cols-2">
                      <SafeValue label="Before" value={entry.before} />
                      <SafeValue label="After" value={entry.after} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {selected ? (
          <div className="space-y-3 rounded-md border p-3">
            <div>
              <h3 className="font-display font-semibold">Restore preview</h3>
              <p className="text-xs text-muted-foreground">
                Restore is validated and authorized by the server before any mutation.
              </p>
            </div>
            {previewError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  <p>{previewError}</p>
                  <Button
                    className="mt-2"
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={previewing}
                    onClick={() => void previewRestore()}
                  >
                    Retry restore preview
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {restoreError ? (
              <Alert variant="destructive">
                <AlertDescription>{restoreError}</AlertDescription>
              </Alert>
            ) : null}
            {reconciliationError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  <p>{reconciliationError}</p>
                  <Button
                    className="mt-2"
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void reconcileParentEditor()}
                  >
                    Retry editor refresh
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {restorePreview?.warnings.map((warning) => (
              <Alert key={warning}>
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}
            {restorePreview?.requiredSecretInputs.map((slot) => (
              <div key={slot} className="space-y-2 rounded-md bg-muted/30 p-3">
                <label className="text-sm font-medium" htmlFor={`replacement-${slot}`}>
                  Replacement required: {slot}
                </label>
                <Input
                  id={`replacement-${slot}`}
                  type="password"
                  autoComplete="off"
                  value={secretReplacements[slot] ?? ""}
                  disabled={omittedSecretSlots.includes(slot)}
                  onChange={(event) =>
                    setSecretReplacements((current) => ({
                      ...current,
                      [slot]: event.target.value,
                    }))
                  }
                />
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={omittedSecretSlots.includes(slot)}
                    onCheckedChange={(checked) =>
                      setOmittedSecretSlots((current) =>
                        checked
                          ? [...new Set([...current, slot])]
                          : current.filter((item) => item !== slot),
                      )
                    }
                  />
                  Omit this destination or notification credential
                </label>
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                loading={previewing}
                disabled={previewing || restoring || restoreCommitted}
                onClick={() => void previewRestore()}
              >
                {restorePreview ? "Revalidate preview" : "Preview restore"}
              </Button>
              {restorePreview && restorePreview.requiredSecretInputs.length === 0 ? (
                <Button
                  type="button"
                  variant="destructive"
                  loading={restoring}
                  disabled={restoring || previewing || restoreCommitted}
                  onClick={() => void restoreRevision()}
                >
                  Restore revision
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RevisionRow({
  revision,
  selected,
  copiedValue,
  disabled,
  onReview,
  onCopy,
}: {
  revision: Revision;
  selected: boolean;
  copiedValue: string | null;
  disabled: boolean;
  onReview(): void;
  onCopy(value: string): void;
}) {
  return (
    <article className={selected ? "bg-accent/30 p-3" : "p-3"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{configurationRevisionLabel(revision)}</p>
          <p className="text-xs text-muted-foreground">
            <time dateTime={new Date(revision.createdAtMs).toISOString()}>
              {new Date(revision.createdAtMs).toLocaleString()}
            </time>{" "}
            · {formatRelativeAge(revision.createdAtMs)}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onReview}>
          Review
        </Button>
      </div>
      <p className="mt-2 text-xs">
        {revision.actorUserId ? (
          <>
            Discord user ID: {revision.actorUserId}{" "}
            <MetadataCopyButton
              value={revision.actorUserId}
              label="Copy actor ID"
              copiedValue={copiedValue}
              onCopy={onCopy}
            />
          </>
        ) : (
          "Changed by the HAF system"
        )}
      </p>
      {revision.restoredFromRevisionId ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Restored from revision ending {shortReference(revision.restoredFromRevisionId)}
        </p>
      ) : null}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Diagnostic details</summary>
        <dl className="mt-2 space-y-2">
          <MetadataRow
            label="Operation ID"
            value={revision.operationId}
            copiedValue={copiedValue}
            onCopy={onCopy}
          />
          {revision.correlationId ? (
            <MetadataRow
              label="Correlation ID"
              value={revision.correlationId}
              copiedValue={copiedValue}
              onCopy={onCopy}
            />
          ) : null}
        </dl>
      </details>
    </article>
  );
}

function MetadataRow({
  label,
  value,
  copiedValue,
  onCopy,
}: {
  label: string;
  value: string;
  copiedValue: string | null;
  onCopy(value: string): void;
}) {
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd className="break-all text-muted-foreground">
        {value}{" "}
        <MetadataCopyButton
          value={value}
          label={`Copy ${label.toLocaleLowerCase()}`}
          copiedValue={copiedValue}
          onCopy={onCopy}
        />
      </dd>
    </div>
  );
}

function MetadataCopyButton({
  value,
  label,
  copiedValue,
  onCopy,
}: {
  value: string;
  label: string;
  copiedValue: string | null;
  onCopy(value: string): void;
}) {
  return (
    <button
      type="button"
      className="font-medium text-primary underline"
      onClick={() => onCopy(value)}
    >
      {copiedValue === value ? "Copied" : label}
    </button>
  );
}

export function configurationRevisionLabel(
  revision: Pick<Revision, "operation" | "source">,
): string {
  if (revision.operation === "restore" || revision.source === "restore")
    return "Restored from an earlier revision";
  if (revision.operation === "clone" || revision.source === "clone")
    return "Cloned from another configuration";
  if (revision.source === "system-snapshot") return "Captured from current configuration";
  const operations: Record<Revision["operation"], string> = {
    baseline: "Baseline recorded",
    create: "Created from dashboard",
    update: "Updated from dashboard",
    delete: "Deleted from dashboard",
    restore: "Restored from an earlier revision",
    clone: "Cloned from another configuration",
  };
  return operations[revision.operation];
}

export function readConfigurationEditorDirtyState(
  value: boolean | (() => boolean) | undefined,
): boolean {
  return typeof value === "function" ? value() : Boolean(value);
}

export function formatRelativeAge(timestampMs: number, nowMs = Date.now()): string {
  const elapsed = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function mergeConfigurationRevisionPages<T extends { id: string }>(
  current: T[],
  next: T[],
): T[] {
  const known = new Set(current.map((revision) => revision.id));
  return [...current, ...next.filter((revision) => !known.has(revision.id))];
}

export async function refreshRestoredConfiguration(
  refresh?: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await refresh?.();
    return { ok: true };
  } catch (reason) {
    return {
      ok: false,
      message: `The restore succeeded, but the editor could not refresh. ${
        reason instanceof Error ? reason.message : "Refresh the editor before continuing."
      }`,
    };
  }
}

function shortReference(value: string): string {
  return value.slice(-8);
}

function SafeValue({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/30 p-2">
      <span className="block uppercase text-muted-foreground">{label}</span>
      <span className="break-words font-mono">{value ?? "Not set"}</span>
    </div>
  );
}

function buildExportHref(guildId: string, workspaceId: string): string {
  const query = new URLSearchParams({ guildId, format: "json", limit: "1000" });
  if (workspaceId) query.set("workspaceId", workspaceId);
  return `/admin/api/configuration-revisions/export?${query}`;
}
