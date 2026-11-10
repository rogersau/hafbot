import { useEffect, useMemo, useState } from "react";

import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../../types";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { cn } from "../lib/utils";
import { AdminPageHeader } from "./admin-page-header";
import {
  EditorActions,
  FormField,
  SectionHeader,
  SettingsBlock,
  SettingsPanel,
} from "./admin-form-layout";
import { PaidPlanLockedCard } from "./paid-plan-locked-card";
import { NoGuildSelected } from "./no-guild-selected";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import type { WebhooksLoaderData } from "../lib/admin-route-loaders";
import { copyTextToClipboard } from "../lib/clipboard";
import { webhookProxyClient } from "../generated/admin-client/webhook-proxy";
import { parseAppIdListWithErrors } from "../../services/steam-ban-app-id-parser";
import {
  evaluateWebhookProxyPayload,
  type WebhookProxyPayloadEvaluation,
} from "../../services/webhook-proxy-service";
import { ConfigurationTestPanel } from "./configuration-test-panel";
import { ConfigurationHistoryCard } from "./configuration-history-card";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface MaskedWebhookCredentialDto {
  configured: true;
  credentialId: string;
  provider: "discord";
  fingerprint: string;
  maskedDisplay: string;
}

interface AdminWebhookDestination {
  id: string;
  label: string;
  credential: MaskedWebhookCredentialDto;
}

interface AdminWebhookConfig extends Omit<
  WebhookProxyConfig,
  "destinations" | "destinationsV2" | "banLookupNotificationUrl" | "banLookupCredentialId"
> {
  destinations: AdminWebhookDestination[];
  banLookupCredential: MaskedWebhookCredentialDto | null;
}

type CredentialDraft =
  | { action: "preserve"; credentialId: string; maskedDisplay: string; fingerprint: string }
  | { action: "replace"; url: string };

interface EditableWebhookConfig extends Omit<
  AdminWebhookConfig,
  "createdAtMs" | "updatedAtMs" | "destinations" | "banLookupCredential"
> {
  destinations: Array<{ id: string; label: string; credential: CredentialDraft }>;
  banLookupCredential: CredentialDraft | { action: "clear" };
}

interface WebhookProxyResource {
  guildId: string;
  configs: AdminWebhookConfig[];
}

interface WebhookRuleValidation {
  id: string | null;
  label: string | null;
  pattern: string | null;
  flags: string | null;
  destinationIds: string | null;
}

interface WebhookReplacementValidation {
  id: string | null;
  label: string | null;
  pattern: string | null;
  flags: string | null;
  replacement: string | null;
}

interface WebhookConfigValidation {
  firstError: string | null;
  routingRules: WebhookRuleValidation[];
  contentReplacements: WebhookReplacementValidation[];
}

interface PendingWebhookAction {
  title: string;
  description: string;
  continueAction: () => void | Promise<void>;
}

export function AdminWebhooksPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  initialData?: WebhooksLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Webhooks"
        description="Create and manage inbound webhook proxy URLs and Discord delivery routes."
        readinessFeature="webhooks"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="webhooks" />
      ) : entitlement && entitlement.tier === "free" ? (
        <PaidPlanLockedCard
          feature="Webhook Proxy"
          description="The Webhook Proxy forwards inbound webhook traffic to Discord channels with configurable content rules."
          supportInvite={entitlement.supportInvite}
        />
      ) : (
        <WebhookProxyEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          historyEnabled={Boolean(entitlement && entitlement.tier !== "free")}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function WebhookProxyEditor({
  selectedWorkspaceId,
  selectedGuildId,
  historyEnabled,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  historyEnabled: boolean;
  initialData?: WebhooksLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resource, setResource] = useState<WebhookProxyResource | null>(
    (initialData as WebhookProxyResource | null | undefined) ?? null,
  );
  const [draft, setDraft] = useState<EditableWebhookConfig>(() =>
    createBlankConfig(selectedGuildId),
  );
  const [savedDraft, setSavedDraft] = useState<EditableWebhookConfig>(() =>
    createBlankConfig(selectedGuildId),
  );
  const [logs, setLogs] = useState<WebhookProxyForwardLog[]>([]);
  const [logsConfig, setLogsConfig] = useState<AdminWebhookConfig | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [selectedPublicId, setSelectedPublicId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [pendingWebhookAction, setPendingWebhookAction] = useState<PendingWebhookAction | null>(
    null,
  );
  const [pendingWebhookActionBusy, setPendingWebhookActionBusy] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();

  const configs = resource?.configs ?? [];
  const selectedConfig = useMemo(
    () => configs.find((config) => config.publicId === selectedPublicId) ?? null,
    [configs, selectedPublicId],
  );
  const validation = validateWebhookConfigDraftDetails(draft);

  async function loadWebhooks() {
    await api.run(
      () =>
        webhookProxyClient.get({
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
        }),
      (data) => {
        setResource(data);
        setSelectedPublicId((current) =>
          current && data.configs.some((config) => config.publicId === current) ? current : null,
        );
      },
    );
  }

  async function loadLogs(config: AdminWebhookConfig) {
    api.setError(null);
    setLogsConfig(config);
    setLogs([]);
    setLogsLoading(true);
    setLogsOpen(true);
    try {
      const data = await webhookProxyClient.logs({
        workspaceId: selectedWorkspaceId,
        guildId: config.guildId,
        publicId: config.publicId,
        limit: "20",
      });
      setLogs(data.logs);
    } catch (loadError) {
      api.setError(
        loadError instanceof Error ? loadError.message : "Failed to load delivery logs.",
      );
    } finally {
      setLogsLoading(false);
    }
  }

  async function saveConfig(): Promise<boolean> {
    setSaved(false);
    api.setError(null);
    setSaveAttempted(true);
    const validationError = validateWebhookConfigDraft(draft);
    if (validationError) {
      api.setError(validationError);
      return false;
    }
    setSaving(true);
    try {
      const data = await webhookProxyClient.save({ ...draft, workspaceId: selectedWorkspaceId });
      toast.success(
        draft.publicId ? "Webhook updated." : "Webhook created. Copy its URL before sharing it.",
      );
      setDraft(createBlankConfig(selectedGuildId));
      setSavedDraft(createBlankConfig(selectedGuildId));
      setSaveAttempted(false);
      setSelectedPublicId(data.publicId ?? null);
      setSaved(true);
      await refreshAdminRouteData(onRouteDataRefresh);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save webhook.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteConfig(config: AdminWebhookConfig) {
    const confirmed = await confirm({
      title: "Delete webhook?",
      description: `This permanently deletes "${config.name}". Any existing inbound URL for this webhook will stop working.`,
      confirmLabel: "Delete webhook",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    try {
      await webhookProxyClient.delete({
        publicId: config.publicId,
        workspaceId: selectedWorkspaceId,
        guildId: config.guildId,
      });
      toast.success("Webhook deleted.");
      if (draft.publicId === config.publicId) {
        const blank = createBlankConfig(selectedGuildId);
        setDraft(blank);
        setSavedDraft(blank);
      }
      if (logsConfig?.publicId === config.publicId) {
        setLogs([]);
        setLogsConfig(null);
        setLogsOpen(false);
      }
      setLogs([]);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete webhook.");
    }
  }

  function startNewWebhookNow() {
    const blank = createBlankConfig(selectedGuildId);
    setDraft(blank);
    setSavedDraft(blank);
    setSelectedPublicId(null);
    setLogs([]);
    setLogsConfig(null);
    setLogsOpen(false);
    setSaved(false);
    setSaveAttempted(false);
    api.setError(null);
  }

  function editConfigNow(config: AdminWebhookConfig) {
    const nextDraft = toDraft(config);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setSelectedPublicId(config.publicId);
    setSaved(false);
    setSaveAttempted(false);
    api.setError(null);
  }

  function requestWebhookAction(action: PendingWebhookAction) {
    if (!hasUnsavedChanges) {
      void action.continueAction();
      return;
    }
    setPendingWebhookAction(action);
  }

  function startNewWebhook() {
    requestWebhookAction({
      title: "Start a new webhook?",
      description: "Your current Webhook Proxy draft has unsaved changes.",
      continueAction: startNewWebhookNow,
    });
  }

  function editConfig(config: AdminWebhookConfig) {
    requestWebhookAction({
      title: "Switch webhook?",
      description: "Your current Webhook Proxy draft has unsaved changes.",
      continueAction: () => editConfigNow(config),
    });
  }

  function discardWebhookChanges() {
    setDraft(savedDraft);
    setSaveAttempted(false);
    api.setError(null);
  }

  async function saveAndContinueWebhookAction() {
    if (!pendingWebhookAction) return;
    setPendingWebhookActionBusy(true);
    const savedSuccessfully = await saveConfig();
    setPendingWebhookActionBusy(false);
    if (!savedSuccessfully) return;
    const action = pendingWebhookAction;
    setPendingWebhookAction(null);
    await action.continueAction();
  }

  function discardWebhookAction() {
    if (!pendingWebhookAction) return;
    const action = pendingWebhookAction;
    setPendingWebhookAction(null);
    discardWebhookChanges();
    void action.continueAction();
  }

  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(
    normalizeWebhookDraftForSnapshot(draft),
    normalizeWebhookDraftForSnapshot(savedDraft),
  );

  return (
    <SettingsPanel>
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardWebhookChanges} />
      {confirmDialog}
      <Dialog
        open={pendingWebhookAction !== null}
        onOpenChange={(open) => {
          if (!open && !pendingWebhookActionBusy) setPendingWebhookAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingWebhookAction?.title}</DialogTitle>
            <DialogDescription>{pendingWebhookAction?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={pendingWebhookActionBusy}
              onClick={() => setPendingWebhookAction(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingWebhookActionBusy}
              onClick={discardWebhookAction}
            >
              Discard and continue
            </Button>
            <Button
              type="button"
              loading={pendingWebhookActionBusy}
              disabled={pendingWebhookActionBusy}
              onClick={() => void saveAndContinueWebhookAction()}
            >
              Save and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <WebhookSummary
        configs={configs}
        loading={api.loading}
        onRefresh={() => void loadWebhooks()}
      />
      <WebhookConfigList
        configs={configs}
        loading={api.loading}
        selectedPublicId={selectedPublicId}
        onCreate={startNewWebhook}
        onEdit={editConfig}
        onDelete={(config) => void deleteConfig(config)}
        onLogs={(config) => void loadLogs(config)}
      />
      <WebhookConfigForm
        selectedWorkspaceId={selectedWorkspaceId}
        draft={draft}
        setDraft={setDraft}
        editing={Boolean(draft.publicId)}
        saving={saving}
        saved={saved}
        saveAttempted={saveAttempted}
        validation={validation}
        onCancel={startNewWebhook}
        onDiscard={discardWebhookChanges}
        onSave={() => void saveConfig()}
      />
      <WebhookLogsDialog
        open={logsOpen}
        config={logsConfig ?? selectedConfig}
        logs={logs}
        loading={logsLoading}
        onClose={() => setLogsOpen(false)}
      />
      {selectedPublicId ? (
        <ConfigurationHistoryCard
          guildId={selectedGuildId}
          workspaceId={selectedWorkspaceId}
          feature="webhook-proxy"
          resourceKey={selectedPublicId}
          enabled={historyEnabled}
          hasUnsavedChanges={hasUnsavedChanges}
          onDiscardUnsavedChanges={() =>
            selectedConfig ? editConfigNow(selectedConfig) : startNewWebhookNow()
          }
          onRestoreCompleted={async () => {
            const data = await webhookProxyClient.get({
              workspaceId: selectedWorkspaceId,
              guildId: selectedGuildId,
            });
            setResource(data);
            const restored = data.configs.find((config) => config.publicId === selectedPublicId);
            if (restored) {
              const restoredDraft = toDraft(restored);
              setDraft(restoredDraft);
              setSavedDraft(restoredDraft);
              setSelectedPublicId(restored.publicId);
            } else {
              startNewWebhook();
            }
            await refreshAdminRouteData(onRouteDataRefresh);
          }}
        />
      ) : null}
      <PageFeedback error={api.error} />
    </SettingsPanel>
  );
}

function WebhookLogsDialog({
  open,
  config,
  logs,
  loading,
  onClose,
}: {
  open: boolean;
  config: AdminWebhookConfig | null;
  logs: WebhookProxyForwardLog[];
  loading: boolean;
  onClose: () => void;
}) {
  // Synchronizes the modal with browser body scrolling and global Escape handling.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !config) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhook-logs-title"
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0 space-y-1">
            <h3 id="webhook-logs-title" className="text-base font-semibold text-foreground">
              Delivery logs
            </h3>
            <p className="text-sm text-muted-foreground">{config.name}</p>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {buildInboundPath(config.publicId)}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading ? (
            <EmptyState>Loading delivery logs…</EmptyState>
          ) : logs.length === 0 ? (
            <EmptyState>No delivery logs yet.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>{new Date(log.timestampMs).toLocaleString()}</TableCell>
                    <TableCell>{log.destinationId}</TableCell>
                    <TableCell>
                      <Badge variant={log.ok ? "success" : "danger"}>
                        {log.status ?? (log.ok ? "OK" : "Network")}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.attempt}</TableCell>
                    <TableCell className="max-w-md truncate">{log.error ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}

function WebhookSummary({
  configs,
  loading,
  onRefresh,
}: {
  configs: AdminWebhookConfig[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const enabledCount = configs.filter((config) => config.enabled).length;
  const destinationCount = configs.reduce((total, config) => total + config.destinations.length, 0);
  const ruleCount = configs.reduce((total, config) => total + config.routingRules.length, 0);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Webhook proxy"
        description="Generated URLs are bearer secrets. Anyone with a URL can post payloads, so rotate by deleting and recreating if one leaks."
        actions={
          <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Configured" value={configs.length} detail={`${enabledCount} enabled`} />
        <MetricCard label="Destinations" value={destinationCount} detail="Discord webhook URLs" />
        <MetricCard label="Regex rules" value={ruleCount} detail="Ordered match rules" />
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-[4px] border bg-card/70 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function WebhookConfigList({
  configs,
  loading,
  selectedPublicId,
  onCreate,
  onEdit,
  onDelete,
  onLogs,
}: {
  configs: AdminWebhookConfig[];
  loading: boolean;
  selectedPublicId: string | null;
  onCreate: () => void;
  onEdit: (config: AdminWebhookConfig) => void;
  onDelete: (config: AdminWebhookConfig) => void;
  onLogs: (config: AdminWebhookConfig) => void;
}) {
  return (
    <div className="space-y-3">
      <SectionHeader
        title="Configured webhooks"
        description="Existing webhooks stay collapsed so the editor gets the full page width."
        actions={
          <Button type="button" size="sm" onClick={onCreate}>
            New
          </Button>
        }
      />
      {configs.length === 0 ? (
        <EmptyState>
          {loading
            ? "Loading webhooks…"
            : "No webhooks yet. Add a destination URL, save, then copy the generated inbound URL."}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <WebhookConfigCard
              key={`${config.publicId}:${config.publicId === selectedPublicId}`}
              config={config}
              selected={config.publicId === selectedPublicId}
              onEdit={() => onEdit(config)}
              onDelete={() => onDelete(config)}
              onLogs={() => onLogs(config)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WebhookConfigCard({
  config,
  selected,
  onEdit,
  onDelete,
  onLogs,
}: {
  config: AdminWebhookConfig;
  selected: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onLogs: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(selected);
  const toast = useToast();

  async function handleCopy() {
    try {
      await copyInboundUrl(config.publicId);
      setCopied(true);
      if (typeof window !== "undefined") window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      setCopied(false);
      toast.error(error instanceof Error ? error.message : "Could not copy webhook URL.");
    }
  }

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className={cn(
        "group rounded-[4px] border bg-card/70 transition-colors",
        selected && "border-accent/70",
      )}
    >
      <summary className="flex cursor-pointer list-none flex-col gap-3 p-4 marker:hidden md:flex-row md:items-center md:justify-between [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-foreground">{config.name}</h4>
            <Badge variant={config.enabled ? "success" : "warning"}>
              {config.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {selected ? <Badge variant="info">Selected</Badge> : null}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground md:truncate">
            {buildInboundPath(config.publicId)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{config.destinations.length} destinations</span>
          <span>•</span>
          <span>{config.routingRules.length} rules</span>
          <span>•</span>
          <span>{expanded ? "Collapse" : "Expand"}</span>
        </div>
      </summary>
      <div className="space-y-3 border-t px-4 pb-4 pt-3">
        <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-3">
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="font-medium uppercase tracking-wide">Fallback</p>
            <p className="mt-1 break-words">
              {config.defaultDestinationIds.join(", ") || "No fallback"}
            </p>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="font-medium uppercase tracking-wide">Destinations</p>
            <p className="mt-1 break-words">
              {config.destinations.map((destination) => destination.label).join(", ")}
            </p>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="font-medium uppercase tracking-wide">Routing</p>
            <p className="mt-1 break-words">
              {config.routingRules.length > 0
                ? config.routingRules.map((rule) => rule.label).join(", ")
                : "Fallback only"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()}>
            {copied ? "Copied" : "Copy URL"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onLogs}>
            Logs
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
    </details>
  );
}

function WebhookConfigForm({
  selectedWorkspaceId,
  draft,
  setDraft,
  editing,
  saving,
  saved,
  saveAttempted,
  validation,
  onCancel,
  onDiscard,
  onSave,
}: {
  selectedWorkspaceId: string;
  draft: EditableWebhookConfig;
  setDraft: (draft: EditableWebhookConfig) => void;
  editing: boolean;
  saving: boolean;
  saved: boolean;
  saveAttempted: boolean;
  validation: WebhookConfigValidation;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const [testSample, setTestSample] = useState("");
  const [testContentType, setTestContentType] = useState<"application/json" | "text/plain">(
    "application/json",
  );
  const [testRequested, setTestRequested] = useState(false);
  const testResult = useMemo<
    | { evaluation: WebhookProxyPayloadEvaluation; error: null }
    | { evaluation: null; error: string }
    | null
  >(() => {
    if (!testRequested) return null;
    if (!testSample) return { evaluation: null, error: "Enter a sample payload." };
    try {
      return {
        evaluation: evaluateWebhookProxyPayload(
          {
            guildId: draft.guildId,
            publicId: draft.publicId,
            name: draft.name,
            enabled: draft.enabled,
            banLookupEnabled: draft.banLookupEnabled,
            banLookupNotificationUrl: null,
            banLookupAppIds: draft.banLookupAppIds,
            destinations: draft.destinations.map((destination) => ({
              id: destination.id,
              label: destination.label,
              url: "https://discord.com",
            })),
            defaultDestinationIds: draft.defaultDestinationIds,
            routingRules: draft.routingRules,
            contentReplacements: draft.contentReplacements,
            createdAtMs: 0,
            updatedAtMs: 0,
          },
          testSample,
          testContentType,
        ),
        error: null,
      };
    } catch (error) {
      return {
        evaluation: null,
        error:
          error instanceof SyntaxError
            ? "The sample is not valid JSON. Choose Text if the source sends a text body."
            : error instanceof Error
              ? error.message
              : "The payload could not be evaluated.",
      };
    }
  }, [draft, testContentType, testRequested, testSample]);

  return (
    <SettingsBlock>
      <SectionHeader
        title={editing ? "Edit webhook" : "Create webhook"}
        description="Add Discord destination webhook URLs, then optionally route matching payloads with regex."
        actions={
          editing ? (
            <Badge variant="info">Existing URL</Badge>
          ) : (
            <Badge>New URL generated on save</Badge>
          )
        }
      />

      {editing ? (
        <div className="rounded-[4px] border bg-background/70 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Inbound URL
          </p>
          <p className="mt-1 break-all font-mono text-sm text-foreground">
            {buildInboundPath(draft.publicId)}
          </p>
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <FormField
            label="Webhook name"
            htmlFor="webhook-name"
            required
            hint="Staff-facing name for this inbound URL. Use something that identifies the source system."
            error={
              saveAttempted && !draft.name.trim() ? "Enter a name for this webhook." : undefined
            }
          >
            <Input
              id="webhook-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Server events"
            />
          </FormField>
          <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            Enabled
          </label>
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeader
          title="Steam ban lookup"
          description="Scan forwarded payloads for SteamID64 values and send standalone ban reports."
        />
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={draft.banLookupEnabled}
              onChange={(event) => setDraft({ ...draft, banLookupEnabled: event.target.checked })}
            />
            Enable Steam ban lookup
          </label>
          <CredentialField
            credential={draft.banLookupCredential}
            revealCredential={() =>
              webhookProxyClient.revealBanCredential({
                guildId: draft.guildId,
                publicId: draft.publicId,
                workspaceId: selectedWorkspaceId,
              })
            }
            label="Ban report webhook URL"
            onChange={(banLookupCredential) => setDraft({ ...draft, banLookupCredential })}
          />
          <BanLookupAppIdField
            value={draft.banLookupAppIds}
            onChange={(appIds) => setDraft({ ...draft, banLookupAppIds: appIds })}
          />
        </div>
      </div>

      <div className="space-y-4">
        <SectionHeader
          title="Destinations"
          description="Register the Discord webhook URLs this proxy can forward messages to."
        />
        <div className="space-y-3">
          {draft.destinations.map((destination, index) => (
            <DestinationEditor
              key={`${destination.id}-${index}`}
              destination={destination}
              index={index}
              workspaceId={selectedWorkspaceId}
              guildId={draft.guildId}
              publicId={draft.publicId}
              saveAttempted={saveAttempted}
              canRemove={draft.destinations.length > 1}
              onChange={(patch) => updateDestination(draft, setDraft, index, patch)}
              onRemove={() => removeDestination(draft, setDraft, index)}
            />
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => addDestination(draft, setDraft)}
        >
          Add destination
        </Button>
      </div>

      <div className="space-y-4">
        <SectionHeader
          title="Regex routing"
          description="Match incoming request bodies and forward each match to one or more destinations."
        />
        {draft.routingRules.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
            No routing rules. Payloads will use the fallback destinations below.
          </div>
        ) : (
          <div className="space-y-3">
            {draft.routingRules.map((rule, index) => (
              <RoutingRuleEditor
                key={`${rule.id}-${index}`}
                rule={rule}
                index={index}
                destinations={draft.destinations}
                validation={validation.routingRules[index] ?? null}
                saveAttempted={saveAttempted}
                onChange={(patch) => updateRule(draft, setDraft, index, patch)}
                onRemove={() => removeRule(draft, setDraft, index)}
              />
            ))}
          </div>
        )}
        <Button type="button" size="sm" variant="outline" onClick={() => addRule(draft, setDraft)}>
          Add regex rule
        </Button>
      </div>

      <div className="space-y-4">
        <SectionHeader
          title="Content replacements"
          description="Rewrite message content with ordered regex replacements before forwarding. Capture groups like $1 are supported."
        />
        {(draft.contentReplacements ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
            No content replacements. Message content will be forwarded unchanged.
          </div>
        ) : (
          <div className="space-y-3">
            {(draft.contentReplacements ?? []).map((replacement, index) => (
              <ContentReplacementEditor
                key={`${replacement.id}-${index}`}
                replacement={replacement}
                index={index}
                validation={validation.contentReplacements[index] ?? null}
                saveAttempted={saveAttempted}
                onChange={(patch) => updateContentReplacement(draft, setDraft, index, patch)}
                onRemove={() => removeContentReplacement(draft, setDraft, index)}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => addContentReplacement(draft, setDraft)}
          >
            Add replacement
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => addCftoolsReplacement(draft, setDraft)}
          >
            Add CFTools profile rule
          </Button>
        </div>
      </div>

      <DestinationSelector
        label="Fallback destinations"
        description="Choose where payloads go when no routing rule matches."
        destinations={draft.destinations}
        selectedIds={draft.defaultDestinationIds}
        onChange={(defaultDestinationIds) => setDraft({ ...draft, defaultDestinationIds })}
      />

      <ConfigurationTestPanel
        sampleLabel="Sample payload"
        sample={testSample}
        onSampleChange={setTestSample}
        onTest={() => setTestRequested(true)}
        placeholder='{"content":"ERROR: example"}'
        description="Run the current unsaved replacements and routing rules locally. Nothing is forwarded, queued, or saved."
        controls={
          <FormField label="Payload type" htmlFor="webhook-test-content-type">
            <select
              id="webhook-test-content-type"
              className="flex h-9 w-full rounded-[3px] border border-input bg-background/70 px-3 py-1 text-sm"
              value={testContentType}
              onChange={(event) =>
                setTestContentType(event.target.value as "application/json" | "text/plain")
              }
            >
              <option value="application/json">JSON</option>
              <option value="text/plain">Text</option>
            </select>
          </FormField>
        }
        result={
          testResult ? (
            testResult.evaluation ? (
              <WebhookConfigurationTestResult evaluation={testResult.evaluation} />
            ) : (
              <p className="rounded-[4px] border bg-background/70 p-3 text-sm text-destructive">
                {testResult.error}
              </p>
            )
          ) : null
        }
      />

      <EditorActions>
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard changes
        </Button>
        {editing ? (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel edit
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={saving}
          loading={saving}
          loadingLabel="Saving…"
          success={saved}
          successLabel="Saved"
        >
          {editing ? "Save changes" : "Create webhook"}
        </Button>
      </EditorActions>
    </SettingsBlock>
  );
}

function WebhookConfigurationTestResult({
  evaluation,
}: {
  evaluation: WebhookProxyPayloadEvaluation;
}) {
  return (
    <div className="space-y-3 rounded-[4px] border bg-background/70 p-3 text-sm">
      <div>
        <p className="text-xs font-medium text-muted-foreground">Transformed payload</p>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 text-xs">
          {evaluation.transformedBody}
        </pre>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground">Matched rules</p>
        <p className="mt-1">
          {evaluation.matchedRules.length > 0
            ? evaluation.matchedRules.map((rule) => rule.label).join(", ")
            : "No rules matched; fallback destinations apply."}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground">Final destinations</p>
        <p className="mt-1">
          {evaluation.destinations.length > 0
            ? evaluation.destinations.map((destination) => destination.label).join(", ")
            : "No destinations selected."}
        </p>
      </div>
      {evaluation.steamIds.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Extracted SteamID64 values</p>
          <p className="mt-1 break-all font-mono">{evaluation.steamIds.join(", ")}</p>
        </div>
      ) : null}
    </div>
  );
}

function CredentialField({
  credential,
  revealCredential,
  label,
  onChange,
}: {
  credential: CredentialDraft | { action: "clear" };
  revealCredential: () => Promise<{ url: string; fingerprint: string; expiresAtMs: number }>;
  label: string;
  onChange: (credential: CredentialDraft | { action: "clear" }) => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Plaintext is deliberately component-local and is cleared after 30 seconds or unmount.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    if (!revealed || typeof window === "undefined") return;
    const timeout = window.setTimeout(() => setRevealed(null), 30_000);
    return () => window.clearTimeout(timeout);
  }, [revealed]);

  async function reveal(copy: boolean) {
    setError(null);
    try {
      const result = await revealCredential();
      setRevealed(result.url);
      if (copy) {
        try {
          await copyTextToClipboard(result.url);
        } catch (cause) {
          setRevealed(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not copy credential URL after reveal attempt.",
          );
          return;
        }
      }
    } catch (cause) {
      setRevealed(null);
      setError(cause instanceof Error ? cause.message : "Could not reveal credential.");
    }
  }

  if (credential.action === "replace") {
    return (
      <FormField
        label={label}
        required
        error={!credential.url.trim() ? "Enter a complete Discord webhook URL." : undefined}
      >
        <div className="flex gap-2">
          <Input
            aria-label={label}
            value={credential.url}
            onChange={(event) => onChange({ action: "replace", url: event.target.value.trim() })}
            placeholder="https://discord.com/api/webhooks/..."
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange({ action: "clear" })}
          >
            Clear
          </Button>
        </div>
      </FormField>
    );
  }

  if (credential.action === "clear") {
    return (
      <FormField label={label}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange({ action: "replace", url: "" })}
        >
          Configure URL
        </Button>
      </FormField>
    );
  }

  return (
    <FormField
      label={label}
      hint={`Fingerprint ${credential.fingerprint.slice(0, 12)}. Reveals automatically hide after 30 seconds.`}
      error={error ?? undefined}
    >
      <div className="space-y-2">
        <Input
          aria-label={label}
          value={revealed ?? credential.maskedDisplay}
          readOnly
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void reveal(false)}>
            Reveal URL
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void reveal(true)}>
            Copy URL
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setRevealed(null);
              onChange({ action: "replace", url: "" });
            }}
          >
            Replace
          </Button>
        </div>
      </div>
    </FormField>
  );
}

function DestinationEditor({
  destination,
  index,
  workspaceId,
  guildId,
  publicId,
  canRemove,
  saveAttempted,
  onChange,
  onRemove,
}: {
  destination: EditableWebhookConfig["destinations"][number];
  index: number;
  workspaceId: string;
  guildId: string;
  publicId: string;
  canRemove: boolean;
  saveAttempted: boolean;
  onChange: (patch: Partial<EditableWebhookConfig["destinations"][number]>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-[4px] border bg-card/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">Destination {index + 1}</p>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove} disabled={!canRemove}>
          Remove
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[0.7fr_1fr_2fr]">
        <FormField
          label="Destination ID"
          required
          hint="Short internal key used by routing rules. Keep it lowercase and stable."
          error={
            saveAttempted && !destination.id.trim()
              ? "Enter an ID for this destination."
              : undefined
          }
        >
          <Input
            aria-label="Destination ID"
            value={destination.id}
            onChange={(event) => onChange({ id: event.target.value.trim() })}
            placeholder="main"
          />
        </FormField>
        <FormField
          label="Destination label"
          required
          hint="Human-readable name shown in the dashboard."
          error={
            saveAttempted && !destination.label.trim()
              ? "Enter a label for this destination."
              : undefined
          }
        >
          <Input
            aria-label="Destination label"
            value={destination.label}
            onChange={(event) => onChange({ label: event.target.value })}
            placeholder="Main channel"
          />
        </FormField>
        <CredentialField
          credential={destination.credential}
          revealCredential={() =>
            webhookProxyClient.revealCredential({
              guildId,
              publicId,
              destinationId: destination.id,
              workspaceId,
            })
          }
          label="Discord webhook URL"
          onChange={(credential) => {
            if (credential.action !== "clear") onChange({ credential });
          }}
        />
      </div>
    </div>
  );
}

function RoutingRuleEditor({
  rule,
  index,
  destinations,
  validation,
  saveAttempted,
  onChange,
  onRemove,
}: {
  rule: EditableWebhookConfig["routingRules"][number];
  index: number;
  destinations: EditableWebhookConfig["destinations"];
  validation: WebhookRuleValidation | null;
  saveAttempted: boolean;
  onChange: (patch: Partial<EditableWebhookConfig["routingRules"][number]>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-3 rounded-[4px] border bg-card/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">Rule {index + 1}</p>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[0.7fr_1fr_1.5fr_0.45fr]">
        <FormField
          label="Rule ID"
          required
          hint="Stable internal key used by the webhook proxy."
          error={saveAttempted ? (validation?.id ?? undefined) : undefined}
        >
          <Input
            aria-label="Rule ID"
            value={rule.id}
            onChange={(event) => onChange({ id: event.target.value.trim() })}
            placeholder="errors"
          />
        </FormField>
        <FormField
          label="Rule label"
          required
          hint="Human-readable name shown in the editor."
          error={saveAttempted ? (validation?.label ?? undefined) : undefined}
        >
          <Input
            aria-label="Rule label"
            value={rule.label}
            onChange={(event) => onChange({ label: event.target.value })}
            placeholder="Errors"
          />
        </FormField>
        <FormField
          label="Regex pattern"
          required
          hint="Pattern matched against the inbound request body."
          error={saveAttempted ? (validation?.pattern ?? undefined) : undefined}
        >
          <Input
            aria-label="Regex pattern"
            value={rule.pattern}
            onChange={(event) => onChange({ pattern: event.target.value })}
            placeholder="error|failed"
          />
        </FormField>
        <FormField
          label="Flags"
          hint="Optional regex flags like i, m, s, u, or y."
          error={saveAttempted ? (validation?.flags ?? undefined) : undefined}
        >
          <Input
            aria-label="Regex flags"
            value={rule.flags}
            onChange={(event) => onChange({ flags: event.target.value })}
            placeholder="i"
          />
        </FormField>
      </div>
      <DestinationSelector
        label="Route to"
        description="Choose one or more destinations. At least one destination is required."
        destinations={destinations}
        selectedIds={rule.destinationIds}
        error={saveAttempted ? (validation?.destinationIds ?? undefined) : undefined}
        onChange={(destinationIds) => onChange({ destinationIds })}
      />
    </div>
  );
}

function ContentReplacementEditor({
  replacement,
  index,
  validation,
  saveAttempted,
  onChange,
  onRemove,
}: {
  replacement: NonNullable<EditableWebhookConfig["contentReplacements"]>[number];
  index: number;
  validation: WebhookReplacementValidation | null;
  saveAttempted: boolean;
  onChange: (
    patch: Partial<NonNullable<EditableWebhookConfig["contentReplacements"]>[number]>,
  ) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-3 rounded-[4px] border bg-card/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">Replacement {index + 1}</p>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[0.7fr_1fr_1.5fr_0.45fr]">
        <FormField
          label="Replacement ID"
          required
          hint="Stable internal key used to manage this replacement."
          error={saveAttempted ? (validation?.id ?? undefined) : undefined}
        >
          <Input
            aria-label="Replacement ID"
            value={replacement.id}
            onChange={(event) => onChange({ id: event.target.value.trim() })}
            placeholder="cftools-profile"
          />
        </FormField>
        <FormField
          label="Replacement label"
          required
          hint="Human-readable name shown in the editor."
          error={saveAttempted ? (validation?.label ?? undefined) : undefined}
        >
          <Input
            aria-label="Replacement label"
            value={replacement.label}
            onChange={(event) => onChange({ label: event.target.value })}
            placeholder="CFTools profile"
          />
        </FormField>
        <FormField
          label="Regex pattern"
          required
          hint="Pattern matched before the message is forwarded."
          error={saveAttempted ? (validation?.pattern ?? undefined) : undefined}
        >
          <Input
            aria-label="Replacement regex pattern"
            value={replacement.pattern}
            onChange={(event) => onChange({ pattern: event.target.value })}
            placeholder="\\b(7656119\\d{10})\\b"
          />
        </FormField>
        <FormField
          label="Flags"
          hint="Optional regex flags like g, i, m, s, u, or y."
          error={saveAttempted ? (validation?.flags ?? undefined) : undefined}
        >
          <Input
            aria-label="Replacement regex flags"
            value={replacement.flags}
            onChange={(event) => onChange({ flags: event.target.value })}
            placeholder="g"
          />
        </FormField>
      </div>
      <FormField
        label="Replacement text"
        required
        hint="Text inserted into the forwarded payload. Capture groups like $1 are allowed."
        error={saveAttempted ? (validation?.replacement ?? undefined) : undefined}
      >
        <Input
          aria-label="Replacement text"
          value={replacement.replacement}
          onChange={(event) => onChange({ replacement: event.target.value })}
          placeholder="[$1](https://app.cftools.cloud/profile/$1)"
        />
      </FormField>
    </div>
  );
}

function DestinationSelector({
  label,
  description,
  destinations,
  selectedIds,
  error,
  onChange,
}: {
  label: string;
  description?: string;
  destinations: EditableWebhookConfig["destinations"];
  selectedIds: string[];
  error?: string;
  onChange: (selectedIds: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {destinations.map((destination) => {
          const selected = selectedIds.includes(destination.id);
          return (
            <Button
              key={destination.id}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              onClick={() =>
                onChange(
                  selected
                    ? selectedIds.filter((destinationId) => destinationId !== destination.id)
                    : [...selectedIds, destination.id],
                )
              }
            >
              {destination.label || destination.id || "Unnamed"}
            </Button>
          );
        })}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function createBlankConfig(guildId: string): EditableWebhookConfig {
  return {
    guildId,
    publicId: "",
    name: "New webhook",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredential: { action: "clear" },
    banLookupAppIds: [],
    destinations: [{ id: "main", label: "Main", credential: { action: "replace", url: "" } }],
    defaultDestinationIds: ["main"],
    routingRules: [],
    contentReplacements: [],
  };
}

/** Keep secret credential values out of dirty-state snapshots while still detecting replacement. */
function normalizeWebhookDraftForSnapshot(draft: EditableWebhookConfig): unknown {
  return {
    ...draft,
    destinations: draft.destinations.map((destination) => ({
      ...destination,
      credential:
        destination.credential.action === "replace"
          ? { action: "replace", fingerprint: secretDraftFingerprint(destination.credential.url) }
          : destination.credential,
    })),
    banLookupCredential:
      draft.banLookupCredential.action === "replace"
        ? { action: "replace", fingerprint: secretDraftFingerprint(draft.banLookupCredential.url) }
        : draft.banLookupCredential,
  };
}

// Dirty snapshots may distinguish replacement values but never retain plaintext credentials.
function secretDraftFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${hash >>> 0}:${value.length}`;
}

function toDraft(config: AdminWebhookConfig): EditableWebhookConfig {
  return {
    guildId: config.guildId,
    publicId: config.publicId,
    name: config.name,
    enabled: config.enabled,
    banLookupEnabled: config.banLookupEnabled,
    banLookupCredential: config.banLookupCredential
      ? {
          action: "preserve",
          credentialId: config.banLookupCredential.credentialId,
          maskedDisplay: config.banLookupCredential.maskedDisplay,
          fingerprint: config.banLookupCredential.fingerprint,
        }
      : { action: "clear" },
    banLookupAppIds: config.banLookupAppIds,
    destinations: config.destinations.map((destination) => ({
      id: destination.id,
      label: destination.label,
      credential: {
        action: "preserve",
        credentialId: destination.credential.credentialId,
        maskedDisplay: destination.credential.maskedDisplay,
        fingerprint: destination.credential.fingerprint,
      },
    })),
    defaultDestinationIds: config.defaultDestinationIds,
    routingRules: config.routingRules,
    contentReplacements: config.contentReplacements ?? [],
  };
}

export function validateWebhookConfigDraft(draft: EditableWebhookConfig): string | null {
  return validateWebhookConfigDraftDetails(draft).firstError;
}

export function validateWebhookConfigDraftDetails(
  draft: EditableWebhookConfig,
): WebhookConfigValidation {
  const routingRules: WebhookRuleValidation[] = [];
  const contentReplacements: WebhookReplacementValidation[] = [];
  let firstError: string | null = null;

  function remember(error: string | null) {
    if (!firstError && error) firstError = error;
  }

  if (!draft.name.trim()) remember("Webhook name is required.");
  if (draft.banLookupEnabled && draft.banLookupCredential.action === "clear") {
    remember("Ban report webhook URL is required when Steam ban lookup is enabled.");
  }

  for (let index = 0; index < draft.destinations.length; index += 1) {
    const destination = draft.destinations[index]!;
    if (!destination.id.trim()) {
      remember(`Destination ${index + 1} needs an ID.`);
    }
    if (!destination.label.trim()) {
      remember(`Destination ${index + 1} needs a label.`);
    }
    if (destination.credential.action === "replace" && !destination.credential.url.trim()) {
      remember(`Destination ${index + 1} needs a Discord webhook URL.`);
    }
  }

  for (const [index, rule] of draft.routingRules.entries()) {
    const validation = validateWebhookRoutingRule(rule);
    routingRules.push(validation);
    remember(firstRuleError(validation, index, "routing rule"));
  }

  for (const [index, replacement] of (draft.contentReplacements ?? []).entries()) {
    const validation = validateWebhookContentReplacement(replacement);
    contentReplacements.push(validation);
    remember(firstReplacementError(validation, index));
  }

  return { firstError, routingRules, contentReplacements };
}

export function validateWebhookRoutingRule(
  rule: EditableWebhookConfig["routingRules"][number],
): WebhookRuleValidation {
  const pattern = rule.pattern.trim();
  const flags = rule.flags.trim();
  const regexValidation = validateRegexPattern(pattern, flags);

  return {
    id: rule.id.trim() ? null : "Enter a rule ID.",
    label: rule.label.trim() ? null : "Enter a rule label.",
    pattern: regexValidation.pattern,
    flags: regexValidation.flags,
    destinationIds:
      rule.destinationIds.length > 0 ? null : "Select at least one destination for this rule.",
  };
}

export function validateWebhookContentReplacement(
  replacement: NonNullable<EditableWebhookConfig["contentReplacements"]>[number],
): WebhookReplacementValidation {
  const pattern = replacement.pattern.trim();
  const flags = replacement.flags.trim();
  const regexValidation = validateRegexPattern(pattern, flags);

  return {
    id: replacement.id.trim() ? null : "Enter a replacement ID.",
    label: replacement.label.trim() ? null : "Enter a replacement label.",
    pattern: regexValidation.pattern,
    flags: regexValidation.flags,
    replacement: replacement.replacement.trim() ? null : "Enter replacement text.",
  };
}

function validateRegexPattern(
  pattern: string,
  flags: string,
): { pattern: string | null; flags: string | null } {
  if (!pattern.trim()) {
    return { pattern: "Enter a regex pattern.", flags: null };
  }

  try {
    // Validate flags separately so the UI can point at the right field.
    // eslint-disable-next-line no-new
    new RegExp("", flags);
  } catch {
    return { pattern: null, flags: "Enter valid regex flags such as i, m, s, u, y, or g." };
  }

  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
  } catch {
    return { pattern: "Enter a valid regular expression.", flags: null };
  }

  return { pattern: null, flags: null };
}

function firstRuleError(
  validation: WebhookRuleValidation,
  index: number,
  label: string,
): string | null {
  if (validation.id) return `${capitalize(label)} ${index + 1}: ${validation.id}`;
  if (validation.label) return `${capitalize(label)} ${index + 1}: ${validation.label}`;
  if (validation.pattern) return `${capitalize(label)} ${index + 1}: ${validation.pattern}`;
  if (validation.flags) return `${capitalize(label)} ${index + 1}: ${validation.flags}`;
  if (validation.destinationIds)
    return `${capitalize(label)} ${index + 1}: ${validation.destinationIds}`;
  return null;
}

function firstReplacementError(
  validation: WebhookReplacementValidation,
  index: number,
): string | null {
  if (validation.id) return `Replacement ${index + 1}: ${validation.id}`;
  if (validation.label) return `Replacement ${index + 1}: ${validation.label}`;
  if (validation.pattern) return `Replacement ${index + 1}: ${validation.pattern}`;
  if (validation.flags) return `Replacement ${index + 1}: ${validation.flags}`;
  if (validation.replacement) return `Replacement ${index + 1}: ${validation.replacement}`;
  return null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function updateDestination(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
  index: number,
  patch: Partial<EditableWebhookConfig["destinations"][number]>,
) {
  const destinations = draft.destinations.map((destination, destinationIndex) =>
    destinationIndex === index ? { ...destination, ...patch } : destination,
  );
  const validIds = new Set(destinations.map((destination) => destination.id));
  setDraft({
    ...draft,
    destinations,
    defaultDestinationIds: draft.defaultDestinationIds.filter((id) => validIds.has(id)),
    routingRules: draft.routingRules.map((rule) => ({
      ...rule,
      destinationIds: rule.destinationIds.filter((id) => validIds.has(id)),
    })),
  });
}

function BanLookupAppIdField({
  value,
  onChange,
}: {
  value: number[];
  onChange: (appIds: number[]) => void;
}) {
  const [input, setInput] = useState(value.join(", "));
  const errorMessage = (() => {
    const { appIds, invalid } = parseAppIdListWithErrors(input);
    const trimmedCount = input.split(",").filter((part) => part.trim()).length;
    if (invalid.length > 0 && appIds.length + invalid.length === trimmedCount) {
      return `Invalid App IDs: ${invalid.join(", ")}`;
    }
    return undefined;
  })();
  return (
    <FormField
      label="Game ban App IDs"
      htmlFor="ban-lookup-app-ids"
      hint="Comma-separated Steam App IDs. Leave empty to alert on all game bans."
      error={errorMessage}
    >
      <Input
        id="ban-lookup-app-ids"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          const { appIds } = parseAppIdListWithErrors(event.target.value);
          onChange(appIds);
        }}
        placeholder="221100, 730"
      />
    </FormField>
  );
}

function addDestination(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
) {
  const id = nextUniqueId(
    "dest",
    draft.destinations.map((destination) => destination.id),
  );
  setDraft({
    ...draft,
    destinations: [
      ...draft.destinations,
      {
        id,
        label: `Destination ${draft.destinations.length + 1}`,
        credential: { action: "replace", url: "" },
      },
    ],
    defaultDestinationIds: [...draft.defaultDestinationIds, id],
  });
}

function removeDestination(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
  index: number,
) {
  if (draft.destinations.length <= 1) return;
  const destinations = draft.destinations.filter(
    (_, destinationIndex) => destinationIndex !== index,
  );
  const validIds = new Set(destinations.map((destination) => destination.id));
  const fallbackId = destinations[0]?.id ?? "";
  const defaultDestinationIds = draft.defaultDestinationIds.filter((id) => validIds.has(id));
  setDraft({
    ...draft,
    destinations,
    defaultDestinationIds: defaultDestinationIds.length > 0 ? defaultDestinationIds : [fallbackId],
    routingRules: draft.routingRules.map((rule) => {
      const destinationIds = rule.destinationIds.filter((id) => validIds.has(id));
      return { ...rule, destinationIds: destinationIds.length > 0 ? destinationIds : [fallbackId] };
    }),
  });
}

function updateRule(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
  index: number,
  patch: Partial<EditableWebhookConfig["routingRules"][number]>,
) {
  setDraft({
    ...draft,
    routingRules: draft.routingRules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...patch } : rule,
    ),
  });
}

function addRule(draft: EditableWebhookConfig, setDraft: (draft: EditableWebhookConfig) => void) {
  const firstDestination = draft.destinations[0]?.id ?? "main";
  const id = nextUniqueId(
    "rule",
    draft.routingRules.map((rule) => rule.id),
  );
  setDraft({
    ...draft,
    routingRules: [
      ...draft.routingRules,
      {
        id,
        label: `Rule ${draft.routingRules.length + 1}`,
        pattern: "",
        flags: "i",
        destinationIds: [firstDestination],
      },
    ],
  });
}

function removeRule(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
  index: number,
) {
  setDraft({
    ...draft,
    routingRules: draft.routingRules.filter((_, ruleIndex) => ruleIndex !== index),
  });
}

function updateContentReplacement(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
  index: number,
  patch: Partial<NonNullable<EditableWebhookConfig["contentReplacements"]>[number]>,
) {
  setDraft({
    ...draft,
    contentReplacements: (draft.contentReplacements ?? []).map((replacement, replacementIndex) =>
      replacementIndex === index ? { ...replacement, ...patch } : replacement,
    ),
  });
}

function addContentReplacement(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
) {
  const replacements = draft.contentReplacements ?? [];
  const id = nextUniqueId(
    "replacement",
    replacements.map((replacement) => replacement.id),
  );
  setDraft({
    ...draft,
    contentReplacements: [
      ...replacements,
      {
        id,
        label: `Replacement ${replacements.length + 1}`,
        pattern: "",
        flags: "g",
        replacement: "",
      },
    ],
  });
}

function addCftoolsReplacement(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
) {
  const replacements = draft.contentReplacements ?? [];
  const id = nextUniqueId(
    "cftools-profile",
    replacements.map((replacement) => replacement.id),
  );
  setDraft({
    ...draft,
    contentReplacements: [
      ...replacements,
      {
        id,
        label: "CFTools profile",
        pattern: "\\b(7656119\\d{10})\\b",
        flags: "g",
        replacement: "[$1](https://app.cftools.cloud/profile/$1)",
      },
    ],
  });
}

function removeContentReplacement(
  draft: EditableWebhookConfig,
  setDraft: (draft: EditableWebhookConfig) => void,
  index: number,
) {
  setDraft({
    ...draft,
    contentReplacements: (draft.contentReplacements ?? []).filter(
      (_, replacementIndex) => replacementIndex !== index,
    ),
  });
}

function nextUniqueId(prefix: string, existingIds: string[]): string {
  const existing = new Set(existingIds);
  for (let index = existing.size + 1; index < existing.size + 100; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

function buildInboundPath(publicId: string): string {
  return `/webhooks/${publicId}`;
}

async function copyInboundUrl(publicId: string): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Clipboard is unavailable in this environment.");
  }
  const url = new URL(buildInboundPath(publicId), window.location.origin).toString();
  await copyTextToClipboard(url);
}
