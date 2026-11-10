import { ConfigurationAvailabilityActions } from "./configuration-availability-actions";
import { useMemo, useState } from "react";

import type { PlayerCountServer } from "../../types/player-count";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock, SettingsPanel } from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Badge, type BadgeProps } from "./ui/badge";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { PlayerCountLoaderData } from "../lib/admin-route-loaders";
import { playerCountClient } from "../generated/admin-client/player-count";

interface PlayerCountResource {
  wardogs?: PlayerCountLoaderData["wardogs"];
  guildId: string;
  servers: PlayerCountServer[];
}

export type PlayerCountStatus = "recent" | "needs-attention" | "stale" | "never-checked";

export interface PlayerCountTestResult {
  snapshot: { count: number; maxSlots: number; queue: number | null };
  testedAtMs: number;
}

export function getPlayerCountStatus(
  server: PlayerCountServer,
  nowMs = Date.now(),
): PlayerCountStatus {
  if (server.readiness === "dormant") return "stale";
  if (server.consecutiveFailureCount > 0) return "needs-attention";
  if (server.lastFetchedAtMs === null) return "never-checked";
  return nowMs - server.lastFetchedAtMs > server.refreshIntervalMinutes * 60_000
    ? "stale"
    : "recent";
}

export function formatPlayerCountAge(lastFetchedAtMs: number | null, nowMs = Date.now()): string {
  if (lastFetchedAtMs === null) return "Never checked";
  const ageMinutes = Math.max(0, Math.round((nowMs - lastFetchedAtMs) / 60_000));
  return `${ageMinutes}m ago`;
}

export function formatPlayerCountTimestamp(lastFetchedAtMs: number | null): string {
  if (lastFetchedAtMs === null) return "Never checked";
  return new Date(lastFetchedAtMs).toLocaleString();
}

function playerCountStatusLabel(status: PlayerCountStatus): string {
  return status === "needs-attention"
    ? "Needs attention"
    : status === "never-checked"
      ? "Never checked"
      : status === "stale"
        ? "Stale"
        : "Recent";
}

function playerCountStatusVariant(status: PlayerCountStatus): NonNullable<BadgeProps["variant"]> {
  return status === "needs-attention"
    ? "danger"
    : status === "stale"
      ? "warning"
      : status === "recent"
        ? "success"
        : "default";
}

export function playerCountChannelLabel(
  channelId: string | null,
  channels: Array<{ id: string; name: string }>,
): string {
  if (!channelId) return "Not configured";
  const channel = channels.find((entry) => entry.id === channelId);
  return channel ? `#${channel.name}` : `Unavailable channel · ${channelId}`;
}

interface PendingServerAction {
  title: string;
  description: string;
  continueAction: () => void;
}

export function AdminPlayerCountPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: PlayerCountLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Player Count"
        description="Keep live server counts synced to Discord channel names."
        readinessFeature="player-count"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Player Count" />
      ) : (
        <PlayerCountEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function PlayerCountEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: PlayerCountLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resource, setResource] = useState<PlayerCountResource | null>(initialData ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<PlayerCountServer | null>(null);
  const [editingOriginal, setEditingOriginal] = useState<PlayerCountServer | null>(null);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [pendingServerAction, setPendingServerAction] = useState<PendingServerAction | null>(null);
  const [pendingServerActionBusy, setPendingServerActionBusy] = useState(false);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, PlayerCountTestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string | null>>({});
  const [testPendingIds, setTestPendingIds] = useState<Set<string>>(() => new Set());
  const [showNeedsAttention, setShowNeedsAttention] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const hasUnsavedChanges = editing
    ? editingOriginal
      ? !areAdminActionSnapshotsEqual(editing, editingOriginal)
      : true
    : false;

  const unsavedIndicator = <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />;

  async function saveServer(): Promise<boolean> {
    if (!editing) return false;
    setSaved(false);
    setSaveAttempted(true);
    api.setError(null);

    // Validate provider-specific fields
    if (editing.provider === "steam-web" && !editing.steamHost?.trim()) {
      api.setError("Steam query host is required.");
      return false;
    }

    if (editing.provider === "wardogs-rcon" && !editing.providerServerId) {
      api.setError("Select a Guild-owned WARDOGS target.");
      return false;
    }
    const replacing =
      editingOriginal &&
      (editing.provider !== editingOriginal.provider ||
        editing.providerServerId !== editingOriginal.providerServerId ||
        editing.steamHost !== editingOriginal.steamHost ||
        editing.steamPort !== editingOriginal.steamPort);
    if (
      replacing &&
      editingOriginal.channelId &&
      editingOriginal.lastFetchedAtMs !== null &&
      !(await confirm({
        title: "Replace the displayed server?",
        description:
          "This clears the old population snapshot and failure history. Your channel and display templates are retained.",
        confirmLabel: "Replace server",
      }))
    )
      return false;
    setSaving(true);
    try {
      await playerCountClient.save({
        confirmReplacement: Boolean(replacing),
        workspaceId: selectedWorkspaceId,
        id: editing.id || undefined,
        guildId: selectedGuildId,
        name: editing.name,
        provider: editing.provider,
        providerServerId: editing.providerServerId,
        channelId: editing.channelId,
        alertChannelId: editing.alertChannelId,
        refreshIntervalMinutes: editing.refreshIntervalMinutes,
        displayFormat: editing.displayFormat,
        offlineFormat: editing.offlineFormat,
        failureThreshold: editing.failureThreshold,
        steamHost: editing.steamHost,
        steamPort: editing.steamPort,
      });
      toast.success(`Saved server "${editing.name}".`);
      setSaved(true);
      setSaveAttempted(false);
      setEditing(null);
      await refreshAdminRouteData(onRouteDataRefresh);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save server.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteServer(server: PlayerCountServer): Promise<boolean> {
    api.setError(null);
    try {
      await playerCountClient.delete({
        workspaceId: selectedWorkspaceId,
        id: server.id,
        guildId: selectedGuildId,
      });
      toast.success(`Deleted server "${server.name}".`);
      if (editing?.id === server.id) cancelEdit();
      await refreshAdminRouteData(onRouteDataRefresh);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete server.");
      return false;
    }
  }

  function startAdd() {
    setSaved(false);
    setSaveAttempted(false);
    setEditingOriginal(null);
    setEditing({
      id: "",
      guildId: selectedGuildId,
      name: "",
      provider: "steam-web",
      providerServerId: "",
      channelId: null,
      alertChannelId: null,
      refreshIntervalMinutes: 10,
      displayFormat: "🎮 Players: {count}/{max}",
      offlineFormat: "🎮 Players: Offline",
      failureThreshold: 3,
      renameOffsetMinutes: Math.floor(Math.random() * 10),
      lastRenamedAtMs: null,
      lastPlayerCount: null,
      lastMaxSlots: null,
      lastQueueSize: null,
      lastFetchedAtMs: null,
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      lastErrorAtMs: null,
      steamHost: null,
      steamPort: null,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    api.setError(null);
  }

  function startEdit(server: PlayerCountServer) {
    setSaved(false);
    setSaveAttempted(false);
    setEditingOriginal(server);
    setEditing({ ...server });
    api.setError(null);
    queueMicrotask(() => document.getElementById("pc-name")?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setEditingOriginal(null);
    setSaveAttempted(false);
  }

  async function handleDiscardChanges() {
    if (!hasUnsavedChanges) {
      cancelEdit();
      return;
    }

    const confirmed = await confirm({
      title: "Discard Player Count changes?",
      description: "This closes the editor and loses the unsaved Player Count server changes.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) cancelEdit();
  }

  function requestServerAction(action: PendingServerAction) {
    if (!hasUnsavedChanges) {
      action.continueAction();
      return;
    }
    setPendingServerAction(action);
  }

  function requestEdit(server: PlayerCountServer) {
    requestServerAction({
      title: "Switch Player Count server?",
      description: "Your current Player Count server draft has unsaved changes.",
      continueAction: () => startEdit(server),
    });
  }

  function requestAdd() {
    requestServerAction({
      title: "Start a new Player Count server?",
      description: "Your current Player Count server draft has unsaved changes.",
      continueAction: startAdd,
    });
  }

  async function saveAndContinueServerAction() {
    if (!pendingServerAction) return;
    setPendingServerActionBusy(true);
    const savedSuccessfully = await saveServer();
    setPendingServerActionBusy(false);
    if (!savedSuccessfully) return;
    const action = pendingServerAction;
    setPendingServerAction(null);
    action.continueAction();
  }

  function discardServerAction() {
    if (!pendingServerAction) return;
    const action = pendingServerAction;
    setPendingServerAction(null);
    cancelEdit();
    action.continueAction();
  }

  async function requestDelete(server: PlayerCountServer) {
    if (deletePendingId) return;
    setDeletePendingId(server.id);
    const voiceChannels = resources?.voiceChannels ?? [];
    const alertChannels = resources?.textChannels ?? [];
    const confirmed = await confirm({
      title: `Remove "${server.name}"?`,
      description: "This removes the Player Count integration and stops scheduled queries.",
      confirmLabel: "Remove server",
      variant: "destructive",
      children: (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            Connection:{" "}
            {server.provider === "wardogs-rcon"
              ? "WARDOGS RCON (experimental)"
              : `${server.steamHost ?? "Unavailable"}:${server.steamPort ?? 27015}`}
          </li>
          <li>Voice channel: {playerCountChannelLabel(server.channelId, voiceChannels)}</li>
          <li>
            Alerts:{" "}
            {server.alertChannelId
              ? playerCountChannelLabel(server.alertChannelId, alertChannels)
              : "Not configured"}
          </li>
          <li>The Discord channel itself is not deleted.</li>
          {editing?.id === server.id && hasUnsavedChanges ? (
            <li>Your unsaved edits to this server will be discarded.</li>
          ) : null}
        </ul>
      ),
    });
    if (!confirmed) {
      setDeletePendingId(null);
      focusRow(server.id);
      return;
    }
    const deleted = await deleteServer(server);
    setDeletePendingId(null);
    if (deleted) focusRow(server.id);
  }

  function focusRow(serverId: string) {
    queueMicrotask(() => {
      document
        .querySelector<HTMLElement>(`[data-player-count-row="${CSS.escape(serverId)}"]`)
        ?.focus();
    });
  }

  async function runTest(server: PlayerCountServer) {
    if (testPendingIds.has(server.id)) return;
    setTestPendingIds((current) => new Set(current).add(server.id));
    setTestErrors((current) => ({ ...current, [server.id]: null }));
    try {
      const data = await playerCountClient.test({ serverId: server.id, guildId: server.guildId });
      if (!data.ok) throw new Error(data.error);
      setTestResults((current) => ({
        ...current,
        [server.id]: { snapshot: data.snapshot, testedAtMs: Date.now() },
      }));
    } catch (err) {
      setTestErrors((current) => ({
        ...current,
        [server.id]: err instanceof Error ? err.message : "Player Count test failed.",
      }));
    } finally {
      setTestPendingIds((current) => {
        const next = new Set(current);
        next.delete(server.id);
        return next;
      });
    }
  }

  if (!resource) {
    return (
      <p className="text-sm text-muted-foreground">
        {api.loading ? "Loading player count servers…" : "Player count servers not loaded."}
      </p>
    );
  }

  return (
    <SettingsPanel>
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={cancelEdit} />
      {confirmDialog}
      <Dialog
        open={pendingServerAction !== null}
        onOpenChange={(open) => {
          if (!open && !pendingServerActionBusy) setPendingServerAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingServerAction?.title}</DialogTitle>
            <DialogDescription>{pendingServerAction?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={pendingServerActionBusy}
              onClick={() => setPendingServerAction(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingServerActionBusy}
              onClick={discardServerAction}
            >
              Discard and continue
            </Button>
            <Button
              type="button"
              loading={pendingServerActionBusy}
              onClick={() => void saveAndContinueServerAction()}
            >
              Save and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {unsavedIndicator}
      {editing ? (
        <SettingsBlock>
          <SectionHeader
            title={editing.id ? "Edit server" : "Add server"}
            description="Update the server configuration and voice channel settings."
          />
          <div className="grid gap-4 md:grid-cols-2">
            <FormField
              label="Display name"
              htmlFor="pc-name"
              hint="Internal name shown in this dashboard so staff can identify the game server."
            >
              <Input
                id="pc-name"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Main PvP"
              />
            </FormField>

            <FormField label="Provider" htmlFor="pc-provider">
              <select
                id="pc-provider"
                value={editing.provider}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    provider: event.target.value as PlayerCountServer["provider"],
                    providerServerId: "",
                    steamHost: null,
                    steamPort: null,
                  })
                }
              >
                <option value="steam-web">Steam Web</option>
                <option value="wardogs-rcon">WARDOGS RCON (experimental)</option>
              </select>
            </FormField>
            {editing.provider === "wardogs-rcon" ? (
              <FormField
                label="WARDOGS target"
                htmlFor="pc-wardogs-target"
                required
                hint="Select an existing secure target owned by this Guild. Passwords are managed in WARDOGS targets."
              >
                <select
                  id="pc-wardogs-target"
                  value={editing.providerServerId}
                  onChange={(event) =>
                    setEditing({ ...editing, providerServerId: event.target.value })
                  }
                >
                  <option value="">Select a target</option>
                  {resource?.wardogs?.targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                      {target.ready ? "" : " — read setup required"}
                    </option>
                  ))}
                </select>
                <p>
                  {!resource?.wardogs?.enabled
                    ? "WARDOGS Player Count is disabled by the HAF operator."
                    : resource.wardogs.targets.find(
                        (target) => target.id === editing.providerServerId,
                      )?.reason}
                </p>
                <p>
                  <a
                    href={`/admin/${encodeURIComponent(selectedGuildId)}/wardogs?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`}
                  >
                    Configure WARDOGS targets
                  </a>
                  . Status tests read aggregate population only.
                </p>
              </FormField>
            ) : (
              <>
                <FormField
                  label="Steam query host"
                  htmlFor="pc-steam-host"
                  required
                  hint="IP address or hostname the bot uses to query live player counts."
                  error={
                    saveAttempted && !editing.steamHost?.trim()
                      ? "Enter the Steam query host for this game server."
                      : undefined
                  }
                >
                  <Input
                    id="pc-steam-host"
                    value={editing.steamHost ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        steamHost: e.target.value.trim() || null,
                      })
                    }
                    placeholder="123.45.67.89 or rust.example.com"
                  />
                </FormField>
                <FormField
                  label="Steam query port"
                  htmlFor="pc-steam-port"
                  hint="Query port for the game server. Common default is 27015."
                >
                  <Input
                    id="pc-steam-port"
                    type="number"
                    value={editing.steamPort ?? ""}
                    onChange={(e) => {
                      const port = e.target.value ? Number.parseInt(e.target.value, 10) : null;
                      setEditing({
                        ...editing,
                        steamPort: port && Number.isFinite(port) ? port : null,
                      });
                    }}
                    placeholder="27015"
                  />
                </FormField>
              </>
            )}
            <FormField
              label="Voice channel"
              htmlFor="pc-channel"
              hint="Voice channel whose name is renamed with the latest player count."
            >
              <ChannelSelect
                allowClear
                id="pc-channel"
                channels={resources?.voiceChannels ?? []}
                value={editing.channelId ?? ""}
                onChange={(value) =>
                  setEditing({
                    ...editing,
                    channelId: value || null,
                  })
                }
                creation={{
                  guildId: selectedGuildId,
                  workspaceId: selectedWorkspaceId,
                  surfaceKey: "player_count",
                  dependencyKey: "status_voice_channel",
                  label: "status voice channel",
                  recommendedName: "Players (0)",
                }}
              />
            </FormField>
            <FormField
              label="Alert channel"
              htmlFor="pc-alert-channel"
              hint="Optional text channel to receive an alert when the server is offline for the configured number of checks."
            >
              <ChannelSelect
                allowClear
                id="pc-alert-channel"
                channels={resources?.textChannels ?? []}
                value={editing.alertChannelId ?? ""}
                onChange={(value) =>
                  setEditing({
                    ...editing,
                    alertChannelId: value || null,
                  })
                }
                placeholder="No alerts"
                creation={{
                  guildId: selectedGuildId,
                  workspaceId: selectedWorkspaceId,
                  surfaceKey: "player_count",
                  dependencyKey: "alert_channel",
                  label: "alert channel",
                  recommendedName: "server-alerts",
                }}
              />
            </FormField>
            <FormField
              label="Refresh interval"
              htmlFor="pc-refresh-interval"
              hint="How often the bot checks the server and updates the channel name. Minimum 5 minutes, maximum 60."
            >
              <Input
                id="pc-refresh-interval"
                type="number"
                min={5}
                max={60}
                value={editing.refreshIntervalMinutes}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  const next = Number.isFinite(parsed) ? Math.max(5, Math.min(60, parsed)) : 10;
                  setEditing({
                    ...editing,
                    refreshIntervalMinutes: next,
                  });
                }}
                placeholder="10"
              />
            </FormField>
            <FormField
              label="Failure threshold"
              htmlFor="pc-failure-threshold"
              hint="How many consecutive failed checks before posting an alert. Minimum 1, maximum 20."
            >
              <Input
                id="pc-failure-threshold"
                type="number"
                min={1}
                max={20}
                value={editing.failureThreshold}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  const next = Number.isFinite(parsed) ? Math.max(1, Math.min(20, parsed)) : 3;
                  setEditing({
                    ...editing,
                    failureThreshold: next,
                  });
                }}
                placeholder="3"
              />
            </FormField>
            <FormField
              label="Online channel name"
              htmlFor="pc-display-format"
              hint="Channel name used when the server responds. Use placeholders such as {count} and {max}."
            >
              <Input
                id="pc-display-format"
                value={editing.displayFormat}
                onChange={(e) => setEditing({ ...editing, displayFormat: e.target.value })}
                placeholder="🎮 Players: {count}/{max}"
              />
            </FormField>
            <FormField
              label="Offline channel name"
              htmlFor="pc-offline-format"
              hint="Channel name used when the server cannot be reached."
            >
              <Input
                id="pc-offline-format"
                value={editing.offlineFormat}
                onChange={(e) => setEditing({ ...editing, offlineFormat: e.target.value })}
                placeholder="🎮 Players: Offline"
              />
            </FormField>
          </div>
          <p className="text-xs text-muted-foreground">
            Placeholders: {"{count}"}, {"{max}"}, {"{queue}"}, {"{name}"}. Use {"{queue?text}"} to
            show text only when queued. Unknown queue is shown as ?; a confirmed empty queue is 0.
            WARDOGS queue is unavailable.
          </p>
        </SettingsBlock>
      ) : null}

      <SettingsBlock>
        <SectionHeader
          title="Configured servers"
          description="Manage player count sources and their Discord voice channel output."
          actions={
            !editing ? (
              <Button size="sm" onClick={requestAdd}>
                Add server
              </Button>
            ) : null
          }
        />
        <ServersTable
          servers={resource.servers}
          resources={resources}
          showNeedsAttention={showNeedsAttention}
          onShowNeedsAttentionChange={setShowNeedsAttention}
          testResults={testResults}
          testErrors={testErrors}
          testPendingIds={testPendingIds}
          onTest={runTest}
          onEdit={requestEdit}
          onEnabledChange={async (server, enabled) => {
            await api.run(
              async () => {
                await playerCountClient.setEnabled({
                  id: server.id,
                  enabled,
                  guildId: selectedGuildId,
                  workspaceId: selectedWorkspaceId,
                });
                await refreshAdminRouteData(onRouteDataRefresh);
              },
              () => {
                setResource((current) =>
                  current
                    ? {
                        ...current,
                        servers: current.servers.map((entry) =>
                          entry.id === server.id ? { ...entry, enabled } : entry,
                        ),
                      }
                    : current,
                );
                if (editing?.id === server.id) {
                  setEditing((current) => (current ? { ...current, enabled } : current));
                  setEditingOriginal((current) => (current ? { ...current, enabled } : current));
                }
                toast.success(`Player Count ${enabled ? "enabled" : "disabled"}.`);
              },
            );
          }}
          onDelete={requestDelete}
          deletePendingId={deletePendingId}
        />
      </SettingsBlock>

      <PageFeedback error={api.error} />
      {editing ? (
        <AdminBottomActionBar
          actions={[
            {
              label: "Save",
              loadingLabel: "Saving…",
              loading: saving,
              successLabel: "Saved",
              success: !hasUnsavedChanges && saved,
              disabled: !hasUnsavedChanges || saving,
              variant: "accent",
              onClick: () => void saveServer(),
            },
            {
              label: "Discard changes",
              variant: "outline",
              onClick: () => void handleDiscardChanges(),
            },
          ]}
        />
      ) : null}
    </SettingsPanel>
  );
}

function ServersTable({
  servers,
  resources,
  showNeedsAttention,
  onShowNeedsAttentionChange,
  testResults,
  testErrors,
  testPendingIds,
  onTest,
  onEdit,
  onDelete,
  onEnabledChange,
  deletePendingId,
}: {
  servers: PlayerCountServer[];
  resources: {
    voiceChannels: Array<{ id: string; name: string }>;
    textChannels: Array<{ id: string; name: string }>;
  } | null;
  showNeedsAttention: boolean;
  onShowNeedsAttentionChange: (value: boolean) => void;
  testResults: Record<string, PlayerCountTestResult>;
  testErrors: Record<string, string | null>;
  testPendingIds: Set<string>;
  onTest: (server: PlayerCountServer) => void;
  onEdit: (server: PlayerCountServer) => void;
  onDelete: (server: PlayerCountServer) => void | Promise<void>;
  onEnabledChange: (server: PlayerCountServer, enabled: boolean) => Promise<void>;
  deletePendingId: string | null;
}) {
  if (servers.length === 0) {
    return <EmptyState>No servers configured yet.</EmptyState>;
  }

  const sortedServers = useMemo(
    () =>
      [...servers].sort((a, b) => {
        const rank = (server: PlayerCountServer) => {
          const status = getPlayerCountStatus(server);
          return status === "needs-attention"
            ? 0
            : status === "stale"
              ? 1
              : status === "never-checked"
                ? 2
                : 3;
        };
        return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      }),
    [servers],
  );
  const attentionCount = sortedServers.filter(
    (server) => getPlayerCountStatus(server) === "needs-attention",
  ).length;
  const visibleServers = showNeedsAttention
    ? sortedServers.filter((server) => getPlayerCountStatus(server) === "needs-attention")
    : sortedServers;
  const channelResources = resources ?? { voiceChannels: [], textChannels: [] };
  const columns: ResponsiveTableColumn<PlayerCountServer>[] = [
    {
      header: "Game server",
      cell: (server) => (
        <div>
          <div className="font-medium">{server.name}</div>
          <div className="font-mono text-xs text-muted-foreground">
            {server.provider === "wardogs-rcon"
              ? "WARDOGS RCON (experimental)"
              : `${server.steamHost ?? "Unavailable"}:${server.steamPort ?? 27015}`}
          </div>
        </div>
      ),
    },
    {
      header: "Status",
      cell: (server) => (
        <>
          <ServerStatus server={server} />
          {server.readinessMessage && <p className="text-xs">{server.readinessMessage}</p>}
        </>
      ),
    },
    {
      header: "Stored snapshot",
      cell: (server) => <StoredSnapshot server={server} />,
    },
    {
      header: "Discord destinations",
      cell: (server) => (
        <div className="space-y-1 text-xs">
          <div>
            Voice: {playerCountChannelLabel(server.channelId, channelResources.voiceChannels)}
          </div>
          <div>
            Alerts: {playerCountChannelLabel(server.alertChannelId, channelResources.textChannels)}
          </div>
        </div>
      ),
    },
    {
      header: "Latest query",
      cell: (server) => (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>{formatPlayerCountTimestamp(server.lastFetchedAtMs)}</div>
          <div>{formatPlayerCountAge(server.lastFetchedAtMs)}</div>
          <details>
            <summary className="cursor-pointer text-primary">Latest query message</summary>
            <p className="mt-1 max-w-[260px] text-muted-foreground">
              {server.lastErrorMessage ?? "No query error message recorded."}
            </p>
          </details>
        </div>
      ),
    },
    {
      header: "Test",
      cell: (server) => (
        <TestFeedback
          server={server}
          result={testResults[server.id]}
          error={testErrors[server.id] ?? null}
          pending={testPendingIds.has(server.id)}
          onTest={onTest}
        />
      ),
    },
    {
      header: "Actions",
      cell: (server) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onEdit(server)}>
            Edit
          </Button>
          <ConfigurationAvailabilityActions
            label={server.name}
            enabled={server.enabled !== false}
            disabled={deletePendingId === server.id}
            description="Scheduled queries, channel renames, and outage alerts will stop. The server settings, last snapshot, and Discord channels are kept."
            onEnabledChange={(enabled) => onEnabledChange(server, enabled)}
            additionalActions={[
              {
                label: "Remove server",
                disabled: deletePendingId === server.id,
                onSelect: () => void onDelete(server),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {servers.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showNeedsAttention}
            onChange={(event) => onShowNeedsAttentionChange(event.target.checked)}
          />
          Needs attention only ({attentionCount})
        </label>
      ) : null}
      {visibleServers.length === 0 ? (
        <p className="rounded-[4px] border border-dashed p-4 text-sm text-muted-foreground">
          No servers need attention.
        </p>
      ) : (
        <ResponsiveTable
          rows={visibleServers}
          rowKey={(server) => server.id}
          columns={columns}
          className="player-count-servers"
          renderCard={(server, _index, cells) => (
            <div
              className="rounded-[4px] border bg-card p-4"
              data-player-count-row={server.id}
              tabIndex={-1}
            >
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {cells.map((cell, cellIndex) => (
                  <div key={cellIndex} className={cellIndex === 0 ? "sm:col-span-2" : undefined}>
                    <dt className="font-display text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {cell.header}
                    </dt>
                    <dd className="text-sm">{cell.content}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        />
      )}
    </div>
  );
}

function ServerStatus({ server }: { server: PlayerCountServer }) {
  if (server.enabled === false) return <Badge>Disabled</Badge>;
  const status = getPlayerCountStatus(server);
  return (
    <div className="space-y-1">
      <Badge
        variant={playerCountStatusVariant(status)}
        data-testid={`player-count-status-${status}`}
      >
        {playerCountStatusLabel(status)}
      </Badge>
      {status === "recent" ? <span className="ml-1 text-xs text-muted-foreground">OK</span> : null}
      {status === "needs-attention" ? (
        <div data-testid="player-count-error" className="text-xs text-destructive">
          ⚠ Error · {server.consecutiveFailureCount}× in a row
        </div>
      ) : null}
    </div>
  );
}

function StoredSnapshot({ server }: { server: PlayerCountServer }) {
  if (server.lastPlayerCount === null || server.lastMaxSlots === null)
    return <span className="text-xs text-muted-foreground">No stored snapshot</span>;
  return (
    <span className="text-xs">
      Current players {server.lastPlayerCount} · Maximum slots {server.lastMaxSlots} · Queue{" "}
      {server.lastQueueSize ?? "Unavailable"}
    </span>
  );
}

function TestFeedback({
  server,
  result,
  error,
  pending,
  onTest,
}: {
  server: PlayerCountServer;
  result?: PlayerCountTestResult;
  error: string | null;
  pending: boolean;
  onTest: (server: PlayerCountServer) => void;
}) {
  return (
    <div className="min-w-[170px] space-y-1 text-xs">
      <Button
        size="sm"
        variant="outline"
        onClick={() => onTest(server)}
        disabled={pending}
        loading={pending}
      >
        {pending ? "Testing…" : "Test"}
      </Button>
      {result ? (
        <div data-testid="player-count-test-result" className="text-muted-foreground">
          <div>Live Test · {new Date(result.testedAtMs).toLocaleString()}</div>
          <div>
            Players {result.snapshot.count} · Maximum slots {result.snapshot.maxSlots} · Queue{" "}
            {result.snapshot.queue ?? "Unavailable"}
          </div>
        </div>
      ) : null}
      {error ? (
        <div data-testid="player-count-test-error" className="text-destructive">
          Test failed: {error}
        </div>
      ) : null}
    </div>
  );
}
