import { useState } from "react";

import type { ServerLevelsLoaderData } from "../lib/admin-route-loaders";
import { readResponseError } from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock, SettingsPanel } from "./admin-form-layout";
import { ChannelSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

type PublicServer = ServerLevelsLoaderData["servers"][number];

interface SecretSetup {
  webhookUrl: string;
  requiredEvents: string[];
  payloadFormat: string;
}

interface ServerMutationResponse {
  ok: true;
  server?: PublicServer | null;
  setup?: SecretSetup;
}

export function AdminServerLevelsPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ServerLevelsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [data, setData] = useState<ServerLevelsLoaderData | null>(initialData ?? null);
  const [announcementChannelId, setAnnouncementChannelId] = useState(
    initialData?.config?.announcementChannelId ?? "",
  );
  const [displayName, setDisplayName] = useState("");
  const [providerServerId, setProviderServerId] = useState("");
  const [maxSlots, setMaxSlots] = useState("60");
  const [setup, setSetup] = useState<SecretSetup | null>(null);
  const api = useAdminApi();
  const toast = useToast();
  const confirmDialog = useConfirmDialog();
  const guildResources = useGuildResources(selectedWorkspaceId, selectedGuildId);

  if (!selectedGuildId) {
    return <NoGuildSelected feature="Server Levels" />;
  }
  if (!data) {
    return <PageFeedback error="Server Levels configuration could not be loaded." />;
  }

  const config = data.config;
  const savedChannelId = config?.announcementChannelId ?? "";
  const hasUnsavedChanges = announcementChannelId !== savedChannelId;
  const discardChanges = () => {
    setAnnouncementChannelId(savedChannelId);
    api.setError(null);
  };
  const handleDiscardChanges = async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Discard announcement channel changes?",
      description: "This restores the last saved Server Levels announcement channel.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  };
  const allWebhooksVerified =
    data.servers.length > 0 && data.servers.every((server) => server.webhookVerifiedAtMs !== null);
  const dataApiReady = data.servers.every(
    (server) => !server.dataApiConfigured || server.lastRosterReconciledAtMs !== null,
  );
  const allSubscriptionsReady =
    data.servers.length > 0 &&
    data.servers.every((server) =>
      data.requiredEvents.every((event) => server.subscribedEvents.includes(event)),
    );
  const ready =
    Boolean(config?.enabled) &&
    data.steamLinkConfigured &&
    data.credentialEncryptionAvailable &&
    data.processingAvailable &&
    allWebhooksVerified &&
    allSubscriptionsReady &&
    dataApiReady;

  const request = async <T,>(method: string, path: string, body: Record<string, unknown>) => {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        guildId: selectedGuildId,
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(await readResponseError(response, "Server Levels request failed."));
    }
    return response.json() as Promise<T>;
  };

  const saveConfig = (enabled: boolean, channelId: string, successMessage: string) =>
    api.run(
      () =>
        request<{ ok: true }>("POST", "/admin/api/server-levels/config", {
          enabled,
          announcementChannelId: channelId || null,
        }),
      () => {
        const now = Date.now();
        setData((current) =>
          current
            ? {
                ...current,
                config: {
                  guildId: selectedGuildId,
                  enabled,
                  announcementChannelId: channelId || null,
                  removedAtMs: null,
                  updatedAtMs: now,
                },
              }
            : current,
        );
        toast.success(successMessage);
      },
      toast.error,
    );

  const addServer = () => {
    const parsedMaxSlots = Number(maxSlots);
    if (!displayName.trim() || !providerServerId.trim() || !Number.isInteger(parsedMaxSlots)) {
      api.setError("Enter a server name, CFTools server ID, and whole-number capacity.");
      return;
    }
    void api.run(
      () =>
        request<ServerMutationResponse>("POST", "/admin/api/server-levels/servers", {
          displayName: displayName.trim(),
          providerServerId: providerServerId.trim(),
          maxSlots: parsedMaxSlots,
        }),
      (result) => {
        if (result.server) {
          setData((current) =>
            current ? { ...current, servers: [...current.servers, result.server!] } : current,
          );
        }
        setSetup(result.setup ?? null);
        setDisplayName("");
        setProviderServerId("");
        toast.success("Configured Game Server added. Save the secret now.");
      },
      toast.error,
    );
  };

  const storeProviderSecret = (server: PublicServer, secret: string, onStored: () => void) =>
    api.run(
      () =>
        request<ServerMutationResponse>(
          "POST",
          `/admin/api/server-levels/servers/${encodeURIComponent(server.id)}/rotate-secret`,
          { secret },
        ),
      () => {
        setData((current) =>
          current
            ? {
                ...current,
                servers: current.servers.map((entry) =>
                  entry.id === server.id ? { ...entry, webhookVerifiedAtMs: null } : entry,
                ),
              }
            : current,
        );
        onStored();
        toast.success("CFTools webhook secret stored securely.");
      },
      toast.error,
    );

  const removeServer = async (server: PublicServer) => {
    const confirmed = await confirmDialog.confirm({
      title: `Remove ${server.displayName}?`,
      description: "Active earning sessions on this server will close immediately.",
      confirmLabel: "Remove server",
      variant: "destructive",
    });
    if (!confirmed) return;
    await api.run(
      () =>
        request<{ ok: true }>(
          "DELETE",
          `/admin/api/server-levels/servers/${encodeURIComponent(server.id)}`,
          {},
        ),
      () => {
        setData((current) =>
          current
            ? { ...current, servers: current.servers.filter((entry) => entry.id !== server.id) }
            : current,
        );
        toast.success("Configured Game Server removed.");
      },
      toast.error,
    );
  };

  const confirmSubscriptions = (server: PublicServer) =>
    api.run(
      () =>
        request<{ ok: true }>(
          "POST",
          `/admin/api/server-levels/servers/${encodeURIComponent(server.id)}/subscriptions`,
          { confirmation: "SUBSCRIPTIONS_CONFIGURED" },
        ),
      () => {
        setData((current) =>
          current
            ? {
                ...current,
                servers: current.servers.map((entry) =>
                  entry.id === server.id
                    ? { ...entry, subscribedEvents: [...current.requiredEvents] }
                    : entry,
                ),
              }
            : current,
        );
        toast.success("Required CFTools event subscriptions confirmed.");
      },
      toast.error,
    );

  const storeDataApiCredentials = (
    server: PublicServer,
    applicationId: string,
    secret: string,
    onStored: () => void,
  ) =>
    api.run(
      () =>
        request<{ ok: true }>(
          "POST",
          `/admin/api/server-levels/servers/${encodeURIComponent(server.id)}/data-api`,
          { applicationId, secret },
        ),
      () => {
        setData((current) =>
          current
            ? {
                ...current,
                servers: current.servers.map((entry) =>
                  entry.id === server.id
                    ? {
                        ...entry,
                        dataApiConfigured: true,
                        lastRosterReconciledAtMs: null,
                        lastCapacityCheckedAtMs: null,
                      }
                    : entry,
                ),
              }
            : current,
        );
        onStored();
        toast.success("CFTools Data API credentials stored securely.");
      },
      toast.error,
    );

  const removeDataApiCredentials = (server: PublicServer) =>
    api.run(
      () =>
        request<{ ok: true }>(
          "DELETE",
          `/admin/api/server-levels/servers/${encodeURIComponent(server.id)}/data-api`,
          {},
        ),
      () => {
        setData((current) =>
          current
            ? {
                ...current,
                servers: current.servers.map((entry) =>
                  entry.id === server.id ? { ...entry, dataApiConfigured: false } : entry,
                ),
              }
            : current,
        );
        toast.success("CFTools Data API disconnected.");
      },
      toast.error,
    );

  const acceptCapacity = (server: PublicServer) => {
    if (!server.capacityProposal) return;
    const proposed = server.capacityProposal.maxSlots;
    void api.run(
      () =>
        request<{ ok: true }>(
          "PATCH",
          `/admin/api/server-levels/servers/${encodeURIComponent(server.id)}`,
          {
            displayName: server.displayName,
            providerServerId: server.providerServerId,
            maxSlots: proposed,
          },
        ),
      () => {
        setData((current) =>
          current
            ? {
                ...current,
                servers: current.servers.map((entry) =>
                  entry.id === server.id
                    ? { ...entry, maxSlots: proposed, capacityProposal: null }
                    : entry,
                ),
              }
            : current,
        );
        toast.success("Canonical capacity updated.");
      },
      toast.error,
    );
  };

  const copy = async (value: string, label: string) => {
    try {
      await copyTextToClipboard(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}.`);
    }
  };

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      {confirmDialog.dialog}
      <AdminPageHeader
        title="Server Levels"
        description="Award Discord-server XP from verified CFTools DayZ attendance. This feature is in beta."
        actions={<Badge variant="info">Beta</Badge>}
        readinessFeature="server-levels"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      <PageFeedback error={api.error} />
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />

      {setup ? (
        <SettingsBlock className="border-amber-500/40 bg-amber-500/5">
          <SectionHeader
            title="Connect the CFTools webhook"
            description="Create a webhook in this CFTools server, then paste the provider-issued secret into the server card below."
            actions={
              <Button type="button" variant="secondary" onClick={() => setSetup(null)}>
                Done
              </Button>
            }
          />
          <SecretValue
            label="Webhook URL"
            value={setup.webhookUrl}
            onCopy={() => void copy(setup.webhookUrl, "Webhook URL")}
          />
          <p className="text-xs text-muted-foreground">
            Select payload format <strong>{setup.payloadFormat}</strong> and subscribe to{" "}
            {setup.requiredEvents.join(", ")}.
          </p>
        </SettingsBlock>
      ) : null}

      <SettingsPanel>
        <SettingsBlock>
          <SectionHeader
            title="Readiness"
            description="XP starts only for new attendance after all prerequisites are ready; there is no backfill."
            actions={
              <Badge variant={ready ? "success" : "warning"}>
                {ready ? "Ready" : "Needs setup"}
              </Badge>
            }
          />
          <ul className="grid gap-2 text-sm md:grid-cols-2">
            <ReadinessItem
              ready={Boolean(config?.enabled)}
              label="Guild has opted into Server Levels"
            />
            <ReadinessItem
              ready={data.steamLinkConfigured}
              label="Steam Platform Link is configured"
            />
            <ReadinessItem
              ready={data.credentialEncryptionAvailable}
              label="Encrypted webhook credentials are available"
            />
            <ReadinessItem
              ready={data.processingAvailable}
              label="Durable persistence and processing are available"
            />
            <ReadinessItem
              ready={allWebhooksVerified}
              label="Every server has sent a verified webhook"
            />
            <ReadinessItem
              ready={allSubscriptionsReady}
              label="Required webhook event subscriptions are confirmed"
            />
            <ReadinessItem
              ready={dataApiReady}
              label="Optional Data API connections have reconciled"
            />
          </ul>
        </SettingsBlock>

        <SettingsBlock>
          <SectionHeader
            title="Guild configuration"
            description="Disabling closes active earning sessions but preserves progress and configuration."
          />
          <div className="flex items-center justify-between gap-4 rounded-[4px] border p-4">
            <div>
              <p className="text-sm font-medium">Enable Server Levels</p>
              <p className="text-xs text-muted-foreground">Paid beta; up to five DayZ servers.</p>
            </div>
            <Switch
              checked={Boolean(config?.enabled)}
              disabled={api.loading}
              onCheckedChange={(checked) =>
                void saveConfig(
                  checked,
                  savedChannelId,
                  checked ? "Server Levels enabled." : "Server Levels disabled.",
                )
              }
              aria-label="Enable Server Levels"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <FormField label="Level-up announcement channel" htmlFor="server-level-announcements">
              <ChannelSelect
                id="server-level-announcements"
                channels={guildResources.resources?.textChannels ?? []}
                value={announcementChannelId}
                onChange={setAnnouncementChannelId}
                disabled={api.loading || guildResources.loading}
                placeholder="No announcements"
              />
            </FormField>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!hasUnsavedChanges || api.loading}
                onClick={() => void handleDiscardChanges()}
              >
                Discard changes
              </Button>
              {announcementChannelId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAnnouncementChannelId("")}
                >
                  Clear
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                disabled={!hasUnsavedChanges || api.loading}
                onClick={() =>
                  void saveConfig(
                    Boolean(config?.enabled),
                    announcementChannelId,
                    announcementChannelId
                      ? "Level-up announcement channel saved."
                      : "Level-up announcement channel cleared.",
                  )
                }
              >
                Save channel
              </Button>
            </div>
          </div>
        </SettingsBlock>

        <SettingsBlock>
          <SectionHeader
            title={`Configured Game Servers (${data.servers.length}/${data.maxServers})`}
            description="Each server has an independent CFTools webhook endpoint and secret."
          />
          {data.servers.length === 0 ? (
            <p className="rounded-[4px] border border-dashed p-5 text-sm text-muted-foreground">
              No DayZ servers are configured yet.
            </p>
          ) : (
            <div className="space-y-3">
              {data.servers.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  requiredEvents={data.requiredEvents}
                  loading={api.loading}
                  onCopy={() => void copy(server.webhookUrl, "Webhook URL")}
                  onStoreSecret={(secret, onStored) =>
                    void storeProviderSecret(server, secret, onStored)
                  }
                  onStoreDataApi={(applicationId, secret, onStored) =>
                    void storeDataApiCredentials(server, applicationId, secret, onStored)
                  }
                  onRemoveDataApi={() => void removeDataApiCredentials(server)}
                  onAcceptCapacity={() => acceptCapacity(server)}
                  onConfirmSubscriptions={() => void confirmSubscriptions(server)}
                  onRemove={() => void removeServer(server)}
                />
              ))}
            </div>
          )}
        </SettingsBlock>

        <SettingsBlock>
          <SectionHeader
            title="Add a DayZ server"
            description="Use the stable server ID shown by CFTools, not an IP address."
          />
          <div className="grid gap-4 md:grid-cols-3">
            <FormField label="Display name" htmlFor="server-level-name" required>
              <Input
                id="server-level-name"
                value={displayName}
                maxLength={100}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </FormField>
            <FormField label="CFTools server ID" htmlFor="server-level-provider-id" required>
              <Input
                id="server-level-provider-id"
                value={providerServerId}
                maxLength={200}
                onChange={(event) => setProviderServerId(event.target.value)}
              />
            </FormField>
            <FormField label="Maximum player slots" htmlFor="server-level-slots" required>
              <Input
                id="server-level-slots"
                type="number"
                min={1}
                max={10_000}
                value={maxSlots}
                onChange={(event) => setMaxSlots(event.target.value)}
              />
            </FormField>
          </div>
          <Button
            type="button"
            disabled={
              api.loading ||
              !config?.enabled ||
              !data.steamLinkConfigured ||
              !data.credentialEncryptionAvailable ||
              data.servers.length >= data.maxServers
            }
            loading={api.loading}
            onClick={addServer}
          >
            Add server
          </Button>
        </SettingsBlock>
      </SettingsPanel>
    </div>
  );
}

function ReadinessItem({ ready, label }: { ready: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 rounded-[4px] border p-3">
      <Badge variant={ready ? "success" : "warning"}>{ready ? "Ready" : "Pending"}</Badge>
      <span>{label}</span>
    </li>
  );
}

function SecretValue({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <code className="min-w-0 flex-1 break-all rounded-[4px] border bg-background p-3 text-xs">
          {value}
        </code>
        <Button type="button" variant="outline" onClick={onCopy}>
          Copy
        </Button>
      </div>
    </div>
  );
}

function ServerRow({
  server,
  requiredEvents,
  loading,
  onCopy,
  onStoreSecret,
  onStoreDataApi,
  onRemoveDataApi,
  onAcceptCapacity,
  onConfirmSubscriptions,
  onRemove,
}: {
  server: PublicServer;
  requiredEvents: string[];
  loading: boolean;
  onCopy: () => void;
  onStoreSecret: (secret: string, onStored: () => void) => void;
  onStoreDataApi: (applicationId: string, secret: string, onStored: () => void) => void;
  onRemoveDataApi: () => void;
  onAcceptCapacity: () => void;
  onConfirmSubscriptions: () => void;
  onRemove: () => void;
}) {
  const [providerSecret, setProviderSecret] = useState("");
  const [dataApiApplicationId, setDataApiApplicationId] = useState("");
  const [dataApiSecret, setDataApiSecret] = useState("");
  const subscriptionsReady = requiredEvents.every((event) =>
    server.subscribedEvents.includes(event),
  );
  return (
    <article className="space-y-3 rounded-[4px] border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{server.displayName}</h3>
          <p className="text-xs text-muted-foreground">
            CFTools {server.providerServerId} · {server.maxSlots} slots
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant={server.webhookVerifiedAtMs ? "success" : "warning"}>
            {server.webhookVerifiedAtMs ? "Webhook verified" : "Awaiting webhook"}
          </Badge>
          <Badge variant={subscriptionsReady ? "success" : "danger"}>
            {subscriptionsReady ? "Events ready" : "Missing events"}
          </Badge>
          <Badge
            variant={
              server.dataApiConfigured
                ? server.lastRosterReconciledAtMs
                  ? "success"
                  : "warning"
                : "default"
            }
          >
            {server.dataApiConfigured
              ? server.lastRosterReconciledAtMs
                ? "Roster reconciled"
                : "API pending"
              : "API optional"}
          </Badge>
        </div>
      </div>
      <div className="space-y-2 rounded-[4px] border border-dashed p-3">
        <div>
          <p className="text-sm font-medium">Optional CFTools Data API reconciliation</p>
          <p className="text-xs text-muted-foreground">
            Grant this app read access to the server in CFTools. HAF Bot only reads server info, the
            live roster, and public status; it never changes the game server.
          </p>
        </div>
        {server.dataApiConfigured ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>
              {server.lastRosterReconciledAtMs
                ? `Last roster check ${new Date(server.lastRosterReconciledAtMs).toLocaleString()}`
                : "Waiting for the first successful roster check."}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={onRemoveDataApi}
            >
              Disconnect API
            </Button>
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <FormField label="Application ID" htmlFor={`server-level-data-api-app-${server.id}`}>
              <Input
                id={`server-level-data-api-app-${server.id}`}
                value={dataApiApplicationId}
                maxLength={200}
                onChange={(event) => setDataApiApplicationId(event.target.value)}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label="Application secret"
              htmlFor={`server-level-data-api-secret-${server.id}`}
            >
              <Input
                id={`server-level-data-api-secret-${server.id}`}
                type="password"
                value={dataApiSecret}
                maxLength={500}
                onChange={(event) => setDataApiSecret(event.target.value)}
                autoComplete="new-password"
              />
            </FormField>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={loading || !dataApiApplicationId.trim() || dataApiSecret.length < 8}
              onClick={() =>
                onStoreDataApi(dataApiApplicationId.trim(), dataApiSecret, () => {
                  setDataApiApplicationId("");
                  setDataApiSecret("");
                })
              }
            >
              Connect API
            </Button>
          </div>
        )}
      </div>
      <code className="block break-all rounded-[4px] bg-muted/40 p-2 text-xs">
        {server.webhookUrl}
      </code>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <FormField label="CFTools webhook secret" htmlFor={`server-level-secret-${server.id}`}>
          <Input
            id={`server-level-secret-${server.id}`}
            type="password"
            autoComplete="new-password"
            value={providerSecret}
            maxLength={500}
            onChange={(event) => setProviderSecret(event.target.value)}
            placeholder="Paste the Secret shown by CFTools"
          />
        </FormField>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={loading || providerSecret.length < 8}
          onClick={() => {
            onStoreSecret(providerSecret, () => setProviderSecret(""));
          }}
        >
          Save secret
        </Button>
      </div>
      {server.capacityProposal ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
          <p>
            CFTools recently observed {server.capacityProposal.maxSlots} slots. Review before
            changing scoring.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onAcceptCapacity}>
            Accept capacity
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!subscriptionsReady ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={loading}
            onClick={onConfirmSubscriptions}
          >
            Confirm required events configured
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={onCopy}>
          Copy URL
        </Button>
        <Button type="button" size="sm" variant="destructive" disabled={loading} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </article>
  );
}
