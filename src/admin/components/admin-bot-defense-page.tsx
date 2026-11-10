import { useRef, useState, type ReactNode } from "react";

import { getBotDefenseHoneypotChannelLimitError } from "../../bot-defense-config";
import type { BotDefenseConfig } from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect, MultiChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { Switch } from "./ui/switch";
import { Checkbox } from "./ui/checkbox";
import { AlertTriangleIcon, CheckIcon, InfoIcon, ShieldIcon } from "./ui/icons";
import { Button } from "./ui/button";
import { useToast } from "./toast";
import { refreshAdminRouteData, requireAdminRouteRefresh } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { BotDefenseLoaderData } from "../lib/admin-route-loaders";
import { resetGuildResourcesCache } from "../lib/guild-resources-cache";
import { ConfigurationHistoryCard } from "./configuration-history-card";

interface BotDefenseConfigSnapshot {
  honeypotEnabled: boolean;
  honeypotWarnUser: boolean;
  honeypotDeleteMessage: boolean;
  rateEnabled: boolean;
  rateWarnUser: boolean;
  rateDeleteMessage: boolean;
  honeypotChannelIds: string[];
  rateChannelThreshold: number;
  rateWindowSeconds: number;
  excludedRoleIds: string[];
  modRoleIds: string[];
  modQueueChannelId: string;
  pingOnQueuePost: boolean;
}

const DEFAULT_BOT_DEFENSE_CONFIG: BotDefenseConfigSnapshot = {
  honeypotEnabled: false,
  honeypotWarnUser: false,
  honeypotDeleteMessage: false,
  rateEnabled: false,
  rateWarnUser: false,
  rateDeleteMessage: false,
  honeypotChannelIds: [],
  rateChannelThreshold: 5,
  rateWindowSeconds: 60,
  excludedRoleIds: [],
  modRoleIds: [],
  modQueueChannelId: "",
  pingOnQueuePost: true,
};

export function AdminBotDefensePage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement: EntitlementInfo | null;
  initialData?: BotDefenseLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();
  const [editorGeneration, setEditorGeneration] = useState(0);
  const editorHasUnsavedChanges = useRef(false);

  return (
    <section className="admin-feature-page admin-page-settings admin-bot-defense-page space-y-6">
      <AdminPageHeader
        title="Bot Defense"
        description="Detect automated accounts with honeypot and repeated-message signals, then review flags in a mod queue."
        readinessFeature="bot-defense"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Bot Defense" />
      ) : (
        <>
          <BotDefenseEditor
            key={editorGeneration}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={trimmedGuildId}
            paidFeaturesAvailable={entitlement?.tier !== "free"}
            initialData={initialData}
            onRouteDataRefresh={onRouteDataRefresh}
            onUnsavedChangesChange={(hasChanges) => {
              editorHasUnsavedChanges.current = hasChanges;
            }}
          />
          <ConfigurationHistoryCard
            guildId={trimmedGuildId}
            workspaceId={selectedWorkspaceId}
            feature="bot-defense"
            enabled={Boolean(entitlement && entitlement.tier !== "free")}
            hasUnsavedChanges={() => editorHasUnsavedChanges.current}
            onDiscardUnsavedChanges={() => setEditorGeneration((value) => value + 1)}
            onRestoreCompleted={async () => {
              await requireAdminRouteRefresh(onRouteDataRefresh);
              setEditorGeneration((value) => value + 1);
            }}
          />
        </>
      )}
    </section>
  );
}

export function validateBotDefenseConfig(config: BotDefenseConfigSnapshot): {
  honeypotChannels: string | null;
  rateThreshold: string | null;
  rateWindow: string | null;
} {
  return {
    honeypotChannels: getBotDefenseHoneypotChannelLimitError(config.honeypotChannelIds),
    rateThreshold:
      config.rateEnabled && config.rateChannelThreshold < 2
        ? "Rate threshold must be at least 2 matching channels."
        : null,
    rateWindow:
      config.rateEnabled && config.rateWindowSeconds < 1
        ? "Time window must be at least 1 second."
        : null,
  };
}

export function normalizeBotDefenseConfigSnapshot(
  config?: Partial<BotDefenseConfig> | Partial<BotDefenseConfigSnapshot> | null,
): BotDefenseConfigSnapshot {
  return {
    ...DEFAULT_BOT_DEFENSE_CONFIG,
    honeypotEnabled: config?.honeypotEnabled ?? DEFAULT_BOT_DEFENSE_CONFIG.honeypotEnabled,
    honeypotWarnUser: config?.honeypotWarnUser ?? DEFAULT_BOT_DEFENSE_CONFIG.honeypotWarnUser,
    honeypotDeleteMessage:
      config?.honeypotDeleteMessage ?? DEFAULT_BOT_DEFENSE_CONFIG.honeypotDeleteMessage,
    rateEnabled: config?.rateEnabled ?? DEFAULT_BOT_DEFENSE_CONFIG.rateEnabled,
    rateWarnUser: config?.rateWarnUser ?? DEFAULT_BOT_DEFENSE_CONFIG.rateWarnUser,
    rateDeleteMessage: config?.rateDeleteMessage ?? DEFAULT_BOT_DEFENSE_CONFIG.rateDeleteMessage,
    honeypotChannelIds: config?.honeypotChannelIds ?? DEFAULT_BOT_DEFENSE_CONFIG.honeypotChannelIds,
    rateChannelThreshold:
      config?.rateChannelThreshold ?? DEFAULT_BOT_DEFENSE_CONFIG.rateChannelThreshold,
    rateWindowSeconds: config?.rateWindowSeconds ?? DEFAULT_BOT_DEFENSE_CONFIG.rateWindowSeconds,
    excludedRoleIds: config?.excludedRoleIds ?? DEFAULT_BOT_DEFENSE_CONFIG.excludedRoleIds,
    modRoleIds: config?.modRoleIds ?? DEFAULT_BOT_DEFENSE_CONFIG.modRoleIds,
    modQueueChannelId: config?.modQueueChannelId ?? "",
    pingOnQueuePost: config?.pingOnQueuePost ?? DEFAULT_BOT_DEFENSE_CONFIG.pingOnQueuePost,
  };
}

async function postBotDefenseConfig(
  config: BotDefenseConfigSnapshot,
  workspaceId: string,
  guildId: string,
) {
  await createAdminLoaderClient().postJson(
    "/admin/api/bot-defense/config",
    {
      honeypotEnabled: config.honeypotEnabled,
      honeypotWarnUser: config.honeypotWarnUser,
      honeypotDeleteMessage: config.honeypotDeleteMessage,
      rateEnabled: config.rateEnabled,
      rateWarnUser: config.rateWarnUser,
      rateDeleteMessage: config.rateDeleteMessage,
      honeypotChannelIds: config.honeypotChannelIds,
      rateChannelThreshold: config.rateChannelThreshold,
      rateWindowSeconds: config.rateWindowSeconds,
      excludedRoleIds: config.excludedRoleIds,
      modRoleIds: config.modRoleIds,
      modQueueChannelId: config.modQueueChannelId.trim() || null,
      pingOnQueuePost: config.pingOnQueuePost,
    },
    { workspaceId, guildId },
  );
}

function BotDefenseEditor({
  selectedWorkspaceId,
  selectedGuildId,
  paidFeaturesAvailable,
  initialData,
  onRouteDataRefresh,
  onUnsavedChangesChange,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  paidFeaturesAvailable: boolean;
  initialData?: BotDefenseLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
  onUnsavedChangesChange?: (hasChanges: boolean) => void;
}) {
  const [honeypotEnabled, setHoneypotEnabled] = useState(
    initialData?.config?.honeypotEnabled ?? false,
  );
  const [honeypotWarnUser, setHoneypotWarnUser] = useState(
    initialData?.config?.honeypotWarnUser ?? false,
  );
  const [honeypotDeleteMessage, setHoneypotDeleteMessage] = useState(
    initialData?.config?.honeypotDeleteMessage ?? false,
  );
  const [rateEnabled, setRateEnabled] = useState(initialData?.config?.rateEnabled ?? false);
  const [rateWarnUser, setRateWarnUser] = useState(initialData?.config?.rateWarnUser ?? false);
  const [rateDeleteMessage, setRateDeleteMessage] = useState(
    initialData?.config?.rateDeleteMessage ?? false,
  );
  const [honeypotChannelIds, setHoneypotChannelIds] = useState<string[]>(
    initialData?.config?.honeypotChannelIds ?? [],
  );
  const [rateChannelThreshold, setRateChannelThreshold] = useState(
    initialData?.config?.rateChannelThreshold ?? DEFAULT_BOT_DEFENSE_CONFIG.rateChannelThreshold,
  );
  const [rateWindowSeconds, setRateWindowSeconds] = useState(
    initialData?.config?.rateWindowSeconds ?? DEFAULT_BOT_DEFENSE_CONFIG.rateWindowSeconds,
  );
  const [excludedRoleIds, setExcludedRoleIds] = useState<string[]>(
    initialData?.config?.excludedRoleIds ?? [],
  );
  const [modRoleIds, setModRoleIds] = useState<string[]>(initialData?.config?.modRoleIds ?? []);
  const [modQueueChannelId, setModQueueChannelId] = useState(
    initialData?.config?.modQueueChannelId ?? "",
  );
  const [pingOnQueuePost, setPingOnQueuePost] = useState(
    initialData?.config?.pingOnQueuePost ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [creatingHoneypotChannel, setCreatingHoneypotChannel] = useState(false);
  const [createdHoneypotChannels, setCreatedHoneypotChannels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [saved, setSaved] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const [savedConfig, setSavedConfig] = useState<BotDefenseConfigSnapshot>(() =>
    normalizeBotDefenseConfigSnapshot(initialData?.config),
  );
  const currentConfig = normalizeBotDefenseConfigSnapshot({
    honeypotEnabled,
    honeypotWarnUser,
    honeypotDeleteMessage,
    rateEnabled,
    rateWarnUser,
    rateDeleteMessage,
    honeypotChannelIds,
    rateChannelThreshold,
    rateWindowSeconds,
    excludedRoleIds,
    modRoleIds,
    modQueueChannelId,
    pingOnQueuePost,
  });
  const fieldErrors = validateBotDefenseConfig({
    ...currentConfig,
    rateEnabled: paidFeaturesAvailable && currentConfig.rateEnabled,
  });
  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(currentConfig, savedConfig);
  onUnsavedChangesChange?.(hasUnsavedChanges);
  const savedSuccessfully = !hasUnsavedChanges && saved;

  function discardChanges() {
    setHoneypotEnabled(savedConfig.honeypotEnabled);
    setHoneypotWarnUser(savedConfig.honeypotWarnUser);
    setHoneypotDeleteMessage(savedConfig.honeypotDeleteMessage);
    setRateEnabled(savedConfig.rateEnabled);
    setRateWarnUser(savedConfig.rateWarnUser);
    setRateDeleteMessage(savedConfig.rateDeleteMessage);
    setHoneypotChannelIds(savedConfig.honeypotChannelIds);
    setRateChannelThreshold(savedConfig.rateChannelThreshold);
    setRateWindowSeconds(savedConfig.rateWindowSeconds);
    setExcludedRoleIds(savedConfig.excludedRoleIds);
    setModRoleIds(savedConfig.modRoleIds);
    setModQueueChannelId(savedConfig.modQueueChannelId ?? "");
    setPingOnQueuePost(savedConfig.pingOnQueuePost);
    setSaved(false);
    api.setError(null);
  }

  async function saveConfig() {
    setSaved(false);
    api.setError(null);

    const errors = validateBotDefenseConfig({
      ...currentConfig,
      rateEnabled: paidFeaturesAvailable && currentConfig.rateEnabled,
    });
    const firstError = errors.honeypotChannels ?? errors.rateThreshold ?? errors.rateWindow ?? null;
    if (firstError) {
      api.setError(firstError);
      return;
    }

    setSaving(true);
    try {
      await postBotDefenseConfig(currentConfig, selectedWorkspaceId, selectedGuildId);
      await refreshAdminRouteData(onRouteDataRefresh);
      setSavedConfig(normalizeBotDefenseConfigSnapshot(currentConfig));
      toast.success("Saved Bot Defense configuration.");
      setSaved(true);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Failed to save Bot Defense.";
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  async function setupHoneypotChannel() {
    setCreatingHoneypotChannel(true);
    api.setError(null);
    try {
      const result = await createAdminLoaderClient().postJson<{
        channel: { id: string; name: string };
        created: boolean;
      }>(
        "/admin/api/bot-defense/honeypot-channel",
        { excludedRoleIds },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      setCreatedHoneypotChannels((channels) => [
        ...channels.filter((channel) => channel.id !== result.channel.id),
        result.channel,
      ]);
      setHoneypotChannelIds((channelIds) =>
        channelIds.includes(result.channel.id) ? channelIds : [...channelIds, result.channel.id],
      );
      setSavedConfig((current) => ({
        ...current,
        honeypotChannelIds: current.honeypotChannelIds.includes(result.channel.id)
          ? current.honeypotChannelIds
          : [...current.honeypotChannelIds, result.channel.id],
      }));
      setHoneypotEnabled(true);
      resetGuildResourcesCache();
      toast.success(
        result.created
          ? "Created and selected #do-not-post. Save to activate it."
          : "Updated and selected #do-not-post. Save to activate it.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set up honeypot channel.");
    } finally {
      setCreatingHoneypotChannel(false);
    }
  }

  const detectorsEnabled = honeypotEnabled || (paidFeaturesAvailable && rateEnabled);
  const automaticActionsEnabled =
    (honeypotEnabled && (honeypotWarnUser || honeypotDeleteMessage)) ||
    (paidFeaturesAvailable && rateEnabled && (rateWarnUser || rateDeleteMessage));
  const honeypotReady = !honeypotEnabled || honeypotChannelIds.length > 0;
  const queueReady = modQueueChannelId.trim().length > 0;
  const availableTextChannels = [
    ...(resources?.textChannels ?? []),
    ...createdHoneypotChannels.filter(
      (created) => !resources?.textChannels.some((channel) => channel.id === created.id),
    ),
  ];

  return (
    <div className="admin-bot-defense-editor space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <div className="admin-bot-defense-status overflow-hidden rounded-[4px] border bg-card/50">
        <div className="grid sm:grid-cols-3">
          <StatusItem
            label="Detection"
            value={detectorsEnabled ? "Active" : "Not active"}
            ready={detectorsEnabled}
          />
          <StatusItem
            label="Review queue"
            value={queueReady ? "Connected" : "Not selected"}
            ready={queueReady}
          />
          <StatusItem
            label="Response"
            value={automaticActionsEnabled ? "Automatic + staff" : "Staff decision"}
            ready
          />
        </div>
        <div className="flex gap-3 border-t bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p>
            Bot Defense raises evidence-backed flags for staff review. Each detector can also warn
            the member, delete the triggering message, or do both automatically.
          </p>
        </div>
      </div>

      {!detectorsEnabled ? (
        <ConfigurationNotice>
          Turn on at least one detector to begin monitoring new messages.
        </ConfigurationNotice>
      ) : !honeypotReady ? (
        <ConfigurationNotice>
          Choose at least one honeypot channel so the Honeypot Detector can raise flags.
        </ConfigurationNotice>
      ) : !queueReady ? (
        <ConfigurationNotice>
          Select a mod queue channel so staff can see and resolve new flags.
        </ConfigurationNotice>
      ) : null}

      <div className="admin-bot-defense-layout">
        <SettingsBlock className="admin-bot-defense-panel admin-bot-defense-detection">
          <SectionHeader
            title="1. Choose detection signals"
            description="Use either detector on its own, or combine both for broader coverage."
          />

          <div className="border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">Honeypot Detector</p>
                  <DetectorState enabled={honeypotEnabled} />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Flags members who post in trap channels that legitimate members should never use.
                </p>
              </div>
              <Switch
                checked={honeypotEnabled}
                onCheckedChange={setHoneypotEnabled}
                aria-label="Enable Honeypot Detector"
              />
            </div>

            {honeypotEnabled ? (
              <div className="mt-4 space-y-4 border-t pt-4">
                <FormField
                  label="Honeypot channels"
                  htmlFor="bd-honeypot-channels"
                  hint="Every message posted in a selected channel triggers Bot Defense. If automatic deletion is enabled, HAF deletes that message immediately. Use only clearly marked trap channels that normal members should never post in."
                  error={fieldErrors.honeypotChannels ?? undefined}
                >
                  <MultiChannelSelect
                    id="bd-honeypot-channels"
                    value={honeypotChannelIds}
                    onChange={setHoneypotChannelIds}
                    channels={availableTextChannels}
                    allowSelectAll={false}
                  />
                </FormField>
                <DetectorActionFields
                  detector="Honeypot"
                  warnUser={honeypotWarnUser}
                  deleteMessage={honeypotDeleteMessage}
                  onWarnUserChange={setHoneypotWarnUser}
                  onDeleteMessageChange={setHoneypotDeleteMessage}
                />
                {honeypotDeleteMessage ? (
                  <div
                    role="alert"
                    className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
                  >
                    <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <p>
                      <strong>Automatic message deletion is enabled.</strong>{" "}
                      {honeypotChannelIds.length === 0
                        ? "Select a honeypot channel to activate it."
                        : `Every message posted in the ${honeypotChannelIds.length} selected honeypot ${honeypotChannelIds.length === 1 ? "channel" : "channels"} will be deleted immediately.`}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="mt-4 flex flex-col items-start gap-2 border-t pt-4 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="secondary"
                loading={creatingHoneypotChannel}
                loadingLabel="Setting up..."
                onClick={setupHoneypotChannel}
              >
                <ShieldIcon className="h-4 w-4" />
                Set up recommended channel
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                Creates or repairs #do-not-post and hides it from Excluded Roles when saved.
              </p>
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">Rate Detector</p>
                  <DetectorState enabled={paidFeaturesAvailable && rateEnabled} />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Flags members who repeat the same text or identical attachment-only image sets
                  across many channels in a short period. Legitimate repeated sharing can trigger a
                  flag; review flags and use trusted-role exclusions.
                </p>
              </div>
              <Switch
                checked={rateEnabled}
                disabled={!paidFeaturesAvailable}
                onCheckedChange={setRateEnabled}
                aria-label="Enable Rate Detector"
              />
            </div>

            {rateEnabled ? (
              <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-2">
                {!paidFeaturesAvailable ? (
                  <p className="text-xs text-muted-foreground md:col-span-2">
                    Rate Detector requires a paid plan. Retained settings are dormant and resume
                    after upgrading.
                  </p>
                ) : null}
                <FormField
                  label="Trigger after"
                  htmlFor="bd-rate-threshold"
                  hint="Number of channels receiving the same message before a flag is raised. Start with 5 and tune from review results."
                  error={fieldErrors.rateThreshold ?? undefined}
                >
                  <div className="flex items-center rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
                    <input
                      id="bd-rate-threshold"
                      type="number"
                      min={2}
                      disabled={!paidFeaturesAvailable}
                      className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                      value={rateChannelThreshold}
                      onChange={(event) =>
                        setRateChannelThreshold(Number(event.currentTarget.value))
                      }
                    />
                    <span className="border-l px-3 text-xs text-muted-foreground">channels</span>
                  </div>
                </FormField>
                <FormField
                  label="Within"
                  htmlFor="bd-rate-window"
                  hint="Trailing time window. Start with 60 seconds and tune from review results."
                  error={fieldErrors.rateWindow ?? undefined}
                >
                  <div className="flex items-center rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
                    <input
                      id="bd-rate-window"
                      type="number"
                      min={1}
                      disabled={!paidFeaturesAvailable}
                      className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                      value={rateWindowSeconds}
                      onChange={(event) => setRateWindowSeconds(Number(event.currentTarget.value))}
                    />
                    <span className="border-l px-3 text-xs text-muted-foreground">seconds</span>
                  </div>
                </FormField>
                <div className="md:col-span-2">
                  <DetectorActionFields
                    detector="Rate"
                    warnUser={rateWarnUser}
                    deleteMessage={rateDeleteMessage}
                    onWarnUserChange={setRateWarnUser}
                    onDeleteMessageChange={setRateDeleteMessage}
                    disabled={!paidFeaturesAvailable}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </SettingsBlock>

        <SettingsBlock className="admin-bot-defense-panel admin-bot-defense-review">
          <SectionHeader
            title="2. Route flags for review"
            description="Send each flag to one staff channel with the evidence needed to confirm or dismiss it."
          />
          <FormField
            label="Review queue channel"
            htmlFor="bd-mod-queue-channel"
            hint="New flags are posted here with Confirm and Dismiss actions."
          >
            <ChannelSelect
              id="bd-mod-queue-channel"
              value={modQueueChannelId}
              onChange={setModQueueChannelId}
              channels={resources?.textChannels ?? []}
              placeholder="Select a channel"
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "bot_defense",
                dependencyKey: "mod_queue_channel",
                label: "review queue channel",
                recommendedName: "bot-defense-queue",
                accessRoleIds: modRoleIds,
              }}
            />
          </FormField>
          <FormField
            label="Review roles"
            htmlFor="bd-mod-roles"
            hint="These staff roles can confirm or dismiss flags. Leave empty to restrict actions to guild admins."
          >
            <MultiRoleSelect
              id="bd-mod-roles"
              value={modRoleIds}
              onChange={setModRoleIds}
              roles={resources?.roles ?? []}
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "bot_defense",
                dependencyKey: "mod_role",
                label: "review role",
                recommendedName: "Bot Defense Moderator",
                accessChannelIds: modQueueChannelId ? [modQueueChannelId] : [],
              }}
            />
          </FormField>

          <div className="space-y-4 border-t pt-4">
            <div className="space-y-1">
              <h3 className="font-display text-sm font-semibold">Exclusions and notifications</h3>
              <p className="text-xs text-muted-foreground">
                Keep trusted roles out of detection and choose whether reviewers are notified.
              </p>
            </div>
            <FormField
              label="Excluded roles"
              htmlFor="bd-excluded-roles"
              hint="Members with any of these roles are never tracked or flagged by either detector."
            >
              <MultiRoleSelect
                id="bd-excluded-roles"
                value={excludedRoleIds}
                onChange={setExcludedRoleIds}
                roles={resources?.roles ?? []}
              />
            </FormField>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Notify review roles</p>
                <p className="text-xs text-muted-foreground">
                  Mention configured review roles when a new flag reaches the queue.
                </p>
              </div>
              <Switch
                checked={pingOnQueuePost}
                onCheckedChange={setPingOnQueuePost}
                disabled={modRoleIds.length === 0}
                aria-label="Notify review roles when a flag is posted"
              />
            </div>
          </div>
        </SettingsBlock>
      </div>

      <PageFeedback error={api.error} />
      <AdminBottomActionBar
        actions={[
          {
            label: "Discard changes",
            variant: "outline",
            onClick: discardChanges,
            disabled: !hasUnsavedChanges,
          },
          {
            label: "Save",
            loadingLabel: "Saving...",
            loading: saving,
            success: savedSuccessfully,
            successLabel: "Saved",
            onClick: saveConfig,
          },
        ]}
      />
    </div>
  );
}

function StatusItem({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          ready ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground"
        }`}
      >
        {ready ? <CheckIcon className="h-4 w-4" /> : <ShieldIcon className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}

function DetectorState({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        enabled ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground"
      }`}
    >
      {enabled ? "On" : "Off"}
    </span>
  );
}

function DetectorActionFields({
  detector,
  warnUser,
  deleteMessage,
  onWarnUserChange,
  onDeleteMessageChange,
  disabled = false,
}: {
  detector: "Honeypot" | "Rate";
  warnUser: boolean;
  deleteMessage: boolean;
  onWarnUserChange: (checked: boolean) => void;
  onDeleteMessageChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-[4px] border p-3">
      <legend className="px-1 text-sm font-medium">Actions</legend>
      <p className="text-xs text-muted-foreground">
        Applied automatically every time the {detector} Detector trips, even if a flag is already
        open.
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={warnUser}
            onCheckedChange={(checked) => onWarnUserChange(checked === true)}
          />
          Reply with warning
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={deleteMessage}
            onCheckedChange={(checked) => onDeleteMessageChange(checked === true)}
          />
          Automatically delete every triggering message
        </label>
      </div>
    </fieldset>
  );
}

function ConfigurationNotice({ children }: { children: ReactNode }) {
  return (
    <div className="admin-bot-defense-notice flex gap-3 rounded-md border border-amber-400/35 bg-amber-400/10 px-4 py-3 text-sm text-foreground">
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
      <p>{children}</p>
    </div>
  );
}
