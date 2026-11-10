import { useState } from "react";

import type { ImageRulesConfig } from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock, AdvancedSection } from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect, MultiChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { PaidPlanLockedCard } from "./paid-plan-locked-card";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Switch } from "./ui/switch";
import { InfoTooltip } from "./ui/info-tooltip";
import { useToast } from "./toast";
import { useAdminApi } from "../hooks/use-admin-api";
import { useAutoSaveToggle } from "../hooks/use-auto-save-toggle";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import { adminRefreshWarning, reconcileAdminMutation } from "../lib/mutation-reconciliation";
import type { ImageRulesLoaderData } from "../lib/admin-route-loaders";

type SensitivityPreset = "lax" | "balanced" | "strict" | "custom";
type ImageRulesAutoSaveKey = "pingOnQueuePost" | "reactOnTopic" | "auditOnTopic";

interface ImageRulesConfigSnapshot {
  enabled: boolean;
  topicDescription: string;
  targetChannelIds: string[];
  excludedRoleIds: string[];
  autoDeleteThreshold: number;
  modReviewThreshold: number;
  modQueueChannelId: string;
  modRoleIds: string[];
  pingOnQueuePost: boolean;
  reactOnTopic: boolean;
  auditOnTopic: boolean;
  dryRun: boolean;
}

const SENSITIVITY_PRESETS: Record<
  Exclude<SensitivityPreset, "custom">,
  { label: string; autoDeleteThreshold: number; modReviewThreshold: number }
> = {
  lax: { label: "Lax", autoDeleteThreshold: 0.75, modReviewThreshold: 0.55 },
  balanced: { label: "Balanced", autoDeleteThreshold: 0.85, modReviewThreshold: 0.65 },
  strict: { label: "Strict", autoDeleteThreshold: 0.9, modReviewThreshold: 0.75 },
};

const DEFAULT_IMAGE_RULES_CONFIG: ImageRulesConfigSnapshot = {
  enabled: false,
  topicDescription: "",
  targetChannelIds: [],
  excludedRoleIds: [],
  autoDeleteThreshold: SENSITIVITY_PRESETS.balanced.autoDeleteThreshold,
  modReviewThreshold: SENSITIVITY_PRESETS.balanced.modReviewThreshold,
  modQueueChannelId: "",
  modRoleIds: [],
  pingOnQueuePost: true,
  reactOnTopic: false,
  auditOnTopic: false,
  dryRun: false,
};

const TOPIC_SUGGESTIONS = [
  {
    label: "DayZ gameplay screenshots",
    value:
      "Screenshots of DayZ gameplay, including first-person or third-person in-game scenes, bases, inventories, maps, vehicles, characters, combat, UI/HUD, and server moments. Desktop screenshots are on-topic when DayZ gameplay, DayZ menus, or DayZ-related content is visible.",
  },
  {
    label: "PC desktop screenshots",
    value:
      "Screenshots taken from a PC or computer desktop, including Windows desktops, taskbars, icons, application windows, terminal windows, browser windows, settings screens, launchers, and wallpapers.",
  },
  {
    label: "Game screenshots",
    value:
      "Screenshots of gameplay or game-related content, including in-game scenes, HUD/UI, menus, inventories, maps, scoreboards, character screens, launchers, and desktop screenshots where the game or game-related content is visible.",
  },
];

function resolvePresetFromThresholds(
  autoDeleteThreshold: number,
  modReviewThreshold: number,
): SensitivityPreset {
  for (const [key, preset] of Object.entries(SENSITIVITY_PRESETS)) {
    if (
      preset.autoDeleteThreshold === autoDeleteThreshold &&
      preset.modReviewThreshold === modReviewThreshold
    ) {
      return key as Exclude<SensitivityPreset, "custom">;
    }
  }
  return "custom";
}

export function AdminImageRulesPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement: EntitlementInfo | null;
  initialData?: ImageRulesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-settings space-y-6">
      <AdminPageHeader
        title="Image Rules"
        description="Classify image attachments against a configured topic and route off-topic uploads."
        readinessFeature="image-rules"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Image Rules" />
      ) : entitlement && entitlement.tier === "free" ? (
        <PaidPlanLockedCard
          feature="Image Rules"
          description="Image Rules classifies image attachments in selected channels against a Guild-defined topic and routes off-topic uploads."
          supportInvite={entitlement.supportInvite}
        />
      ) : (
        <ImageRulesEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

export function validateImageRulesThresholds(config: {
  enabled: boolean;
  targetChannelIds: string[];
  autoDeleteThreshold: number;
  modReviewThreshold: number;
}): { targetChannelIds: string | null; thresholds: string | null } {
  return {
    targetChannelIds:
      config.enabled && config.targetChannelIds.length === 0
        ? "Select at least one target channel when Image Rules is enabled."
        : null,
    thresholds:
      config.modReviewThreshold >= config.autoDeleteThreshold
        ? "Mod review threshold must be lower than the auto-delete threshold."
        : null,
  };
}

export function normalizeImageRulesConfigSnapshot(
  config?: Partial<ImageRulesConfig> | Partial<ImageRulesConfigSnapshot> | null,
): ImageRulesConfigSnapshot {
  return {
    ...DEFAULT_IMAGE_RULES_CONFIG,
    enabled: config?.enabled ?? DEFAULT_IMAGE_RULES_CONFIG.enabled,
    topicDescription: config?.topicDescription ?? DEFAULT_IMAGE_RULES_CONFIG.topicDescription,
    targetChannelIds: config?.targetChannelIds ?? DEFAULT_IMAGE_RULES_CONFIG.targetChannelIds,
    excludedRoleIds: config?.excludedRoleIds ?? DEFAULT_IMAGE_RULES_CONFIG.excludedRoleIds,
    autoDeleteThreshold:
      config?.autoDeleteThreshold ?? DEFAULT_IMAGE_RULES_CONFIG.autoDeleteThreshold,
    modReviewThreshold: config?.modReviewThreshold ?? DEFAULT_IMAGE_RULES_CONFIG.modReviewThreshold,
    modQueueChannelId: config?.modQueueChannelId ?? "",
    modRoleIds: config?.modRoleIds ?? DEFAULT_IMAGE_RULES_CONFIG.modRoleIds,
    pingOnQueuePost: config?.pingOnQueuePost ?? DEFAULT_IMAGE_RULES_CONFIG.pingOnQueuePost,
    reactOnTopic: config?.reactOnTopic ?? DEFAULT_IMAGE_RULES_CONFIG.reactOnTopic,
    auditOnTopic: config?.auditOnTopic ?? DEFAULT_IMAGE_RULES_CONFIG.auditOnTopic,
    dryRun: config?.dryRun ?? DEFAULT_IMAGE_RULES_CONFIG.dryRun,
  };
}

async function postImageRulesConfig(
  config: ImageRulesConfigSnapshot,
  workspaceId: string,
  guildId: string,
) {
  await createAdminLoaderClient().postJson(
    "/admin/api/image-rules/config",
    {
      enabled: config.enabled,
      topicDescription: config.topicDescription.trim(),
      autoDeleteThreshold: config.autoDeleteThreshold,
      modReviewThreshold: config.modReviewThreshold,
      targetChannelIds: config.targetChannelIds,
      excludedRoleIds: config.excludedRoleIds,
      modQueueChannelId: config.modQueueChannelId.trim() || null,
      modRoleIds: config.modRoleIds,
      pingOnQueuePost: config.pingOnQueuePost,
      reactOnTopic: config.reactOnTopic,
      auditOnTopic: config.auditOnTopic,
      dryRun: config.dryRun,
    },
    { workspaceId, guildId },
  );
}

function ImageRulesEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ImageRulesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(initialData?.config?.enabled ?? false);
  const [topicDescription, setTopicDescription] = useState(
    initialData?.config?.topicDescription ?? "",
  );
  const [targetChannelIds, setTargetChannelIds] = useState<string[]>(
    initialData?.config?.targetChannelIds ?? [],
  );
  const [excludedRoleIds, setExcludedRoleIds] = useState<string[]>(
    initialData?.config?.excludedRoleIds ?? [],
  );
  const [autoDeleteThreshold, setAutoDeleteThreshold] = useState(
    initialData?.config?.autoDeleteThreshold ?? SENSITIVITY_PRESETS.balanced.autoDeleteThreshold,
  );
  const [modReviewThreshold, setModReviewThreshold] = useState(
    initialData?.config?.modReviewThreshold ?? SENSITIVITY_PRESETS.balanced.modReviewThreshold,
  );
  const [sensitivityPreset, setSensitivityPreset] = useState<SensitivityPreset>(() =>
    resolvePresetFromThresholds(autoDeleteThreshold, modReviewThreshold),
  );
  const [modQueueChannelId, setModQueueChannelId] = useState(
    initialData?.config?.modQueueChannelId ?? "",
  );
  const [modRoleIds, setModRoleIds] = useState<string[]>(initialData?.config?.modRoleIds ?? []);
  const [pingOnQueuePost, setPingOnQueuePost] = useState(
    initialData?.config?.pingOnQueuePost ?? true,
  );
  const [reactOnTopic, setReactOnTopic] = useState(initialData?.config?.reactOnTopic ?? false);
  const [auditOnTopic, setAuditOnTopic] = useState(initialData?.config?.auditOnTopic ?? false);
  const [dryRun, setDryRun] = useState(initialData?.config?.dryRun ?? false);
  const [showTopicSuggestions, setShowTopicSuggestions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const [savedConfig, setSavedConfig] = useState<ImageRulesConfigSnapshot>(() =>
    normalizeImageRulesConfigSnapshot(initialData?.config),
  );
  const currentConfig = normalizeImageRulesConfigSnapshot({
    enabled,
    topicDescription,
    targetChannelIds,
    excludedRoleIds,
    autoDeleteThreshold,
    modReviewThreshold,
    modQueueChannelId,
    modRoleIds,
    pingOnQueuePost,
    reactOnTopic,
    auditOnTopic,
    dryRun,
  });
  const debouncedConfig = useDebouncedValue(currentConfig);
  const fieldErrors = validateImageRulesThresholds(debouncedConfig);
  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(currentConfig, savedConfig);
  const savedSuccessfully = !hasUnsavedChanges && saved;
  const autoSave = useAutoSaveToggle<ImageRulesAutoSaveKey>({
    onSave: async (key, nextValue) => {
      const nextConfig = { ...currentConfig, [key]: nextValue };
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        () => postImageRulesConfig(nextConfig, selectedWorkspaceId, selectedGuildId),
        onRouteDataRefresh,
      );
      setSavedConfig((current) => ({ ...current, [key]: nextValue }));
      setSaved(true);
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Image Rules preference save", nextRefreshError));
      } else setRefreshError(null);
    },
  });

  function discardChanges() {
    const nextAutoDeleteThreshold = savedConfig.autoDeleteThreshold;
    const nextModReviewThreshold = savedConfig.modReviewThreshold;

    setEnabled(savedConfig.enabled);
    setTopicDescription(savedConfig.topicDescription);
    setTargetChannelIds(savedConfig.targetChannelIds);
    setExcludedRoleIds(savedConfig.excludedRoleIds);
    setAutoDeleteThreshold(nextAutoDeleteThreshold);
    setModReviewThreshold(nextModReviewThreshold);
    setSensitivityPreset(
      resolvePresetFromThresholds(nextAutoDeleteThreshold, nextModReviewThreshold),
    );
    setModQueueChannelId(savedConfig.modQueueChannelId ?? "");
    setModRoleIds(savedConfig.modRoleIds);
    setPingOnQueuePost(savedConfig.pingOnQueuePost);
    setReactOnTopic(savedConfig.reactOnTopic);
    setAuditOnTopic(savedConfig.auditOnTopic);
    setDryRun(savedConfig.dryRun);
    setShowTopicSuggestions(false);
    setSaved(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Image Rules changes?",
      description: "This restores the last saved Image Rules settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  function handlePresetChange(preset: SensitivityPreset) {
    setSensitivityPreset(preset);
    if (preset !== "custom") {
      setAutoDeleteThreshold(SENSITIVITY_PRESETS[preset].autoDeleteThreshold);
      setModReviewThreshold(SENSITIVITY_PRESETS[preset].modReviewThreshold);
    }
  }

  function handleAutoDeleteChange(value: number) {
    setAutoDeleteThreshold(value);
    setSensitivityPreset("custom");
  }

  function handleModReviewChange(value: number) {
    setModReviewThreshold(value);
    setSensitivityPreset("custom");
  }

  async function saveConfig() {
    setSaved(false);
    api.setError(null);

    const errors = validateImageRulesThresholds(currentConfig);
    const firstError = errors.targetChannelIds ?? errors.thresholds ?? null;
    if (firstError) {
      api.setError(firstError);
      return;
    }

    setSaving(true);
    try {
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        () => postImageRulesConfig(currentConfig, selectedWorkspaceId, selectedGuildId),
        onRouteDataRefresh,
      );
      setSavedConfig(normalizeImageRulesConfigSnapshot(currentConfig));
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Image Rules configuration save", nextRefreshError));
      } else setRefreshError(null);
      toast.success("Saved Image Rules configuration.");
      setSaved(true);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Failed to save Image Rules.";
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      <AdminRefreshNotice action="Image Rules" error={refreshError} refresh={onRouteDataRefresh} />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <p className="text-sm text-muted-foreground">
        Image Rules automatically classifies image attachments in selected channels against a topic
        description. Off-topic images can be auto-deleted, and uncertain images can be sent to a mod
        queue for review.
      </p>

      <SettingsBlock>
        <SectionHeader
          title="Image Rules configuration"
          description="Tell the bot what images belong in selected channels, then choose what happens to off-topic uploads."
        />

        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Enable Image Rules</p>
            <p className="text-xs text-muted-foreground">
              Turn on automated image classification for this Guild.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable Image Rules" />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="Topic description"
            htmlFor="ir-topic-description"
            hint="Describe what an allowed image looks like. Clear examples improve classification accuracy."
          >
            <textarea
              id="ir-topic-description"
              className="min-h-[100px] w-full rounded-[3px] border bg-background/60 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={topicDescription}
              onChange={(event) => setTopicDescription(event.currentTarget.value)}
              placeholder="Describe the channel topic. Example: DayZ in-game screenshots..."
            />
            <div className="mt-3 rounded-md border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Topic suggestions</p>
                  <p className="text-xs text-muted-foreground">
                    Example wording for clearer Image Rules topics.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTopicSuggestions((show) => !show)}
                  aria-expanded={showTopicSuggestions}
                >
                  {showTopicSuggestions ? "Hide" : "Show"}
                </Button>
              </div>
              {showTopicSuggestions ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Prefer explicit on-topic examples and edge cases. Use one as a starting point,
                    then adjust it for this Guild.
                  </p>
                  <div className="space-y-2">
                    {TOPIC_SUGGESTIONS.map((suggestion) => (
                      <div key={suggestion.label} className="rounded-md border bg-background p-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-foreground">{suggestion.label}</p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setTopicDescription(suggestion.value)}
                          >
                            Use
                          </Button>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{suggestion.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </FormField>

          <FormField
            label="Target channels"
            htmlFor="ir-target-channels"
            required={enabled}
            error={fieldErrors.targetChannelIds ?? undefined}
          >
            <MultiChannelSelect
              id="ir-target-channels"
              channels={resources?.textChannels ?? []}
              value={targetChannelIds}
              onChange={setTargetChannelIds}
            />
            <p className="text-xs text-muted-foreground">
              The bot checks image attachments only in these channels.
            </p>
          </FormField>

          <FormField
            label="Ignored roles"
            htmlFor="ir-excluded-roles"
            hint="Members with any selected role are ignored by Image Rules. Use this for staff or trusted uploaders."
          >
            <MultiRoleSelect
              id="ir-excluded-roles"
              roles={resources?.roles ?? []}
              value={excludedRoleIds}
              onChange={setExcludedRoleIds}
            />
          </FormField>

          <FormField
            label="Sensitivity preset"
            htmlFor="ir-sensitivity-preset"
            hint="Balanced is a safe starting point. Strict reviews or deletes more images. Lax allows more images through."
          >
            <select
              id="ir-sensitivity-preset"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={sensitivityPreset}
              onChange={(event) =>
                handlePresetChange(event.currentTarget.value as SensitivityPreset)
              }
            >
              <option value="lax">Lax</option>
              <option value="balanced">Balanced</option>
              <option value="strict">Strict</option>
              <option value="custom">Custom</option>
            </select>
          </FormField>

          <FormField
            label={
              <span className="inline-flex items-center gap-1.5">
                {`Auto-delete threshold: ${Math.round(autoDeleteThreshold * 100)}%`}
                <InfoTooltip
                  content="Images scored above this threshold are automatically deleted."
                  learnMoreHref="https://docs.hafbot.xyz/features/image-rules"
                />
              </span>
            }
            htmlFor="ir-auto-delete-threshold"
          >
            <input
              id="ir-auto-delete-threshold"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={autoDeleteThreshold}
              onChange={(event) => handleAutoDeleteChange(Number(event.currentTarget.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
              <span>Send most to review</span>
              <span>Only obvious off-topic</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Images scored above this threshold are automatically deleted.
            </p>
            {fieldErrors.thresholds ? (
              <p className="text-xs text-destructive">{fieldErrors.thresholds}</p>
            ) : null}
          </FormField>

          <FormField
            label={
              <span className="inline-flex items-center gap-1.5">
                {`Mod review threshold: ${Math.round(modReviewThreshold * 100)}%`}
                <InfoTooltip
                  content="Images scored above this threshold but below the auto-delete threshold are sent to the Image Rules Mod Queue for review."
                  learnMoreHref="https://docs.hafbot.xyz/features/image-rules"
                />
              </span>
            }
            htmlFor="ir-mod-review-threshold"
          >
            <input
              id="ir-mod-review-threshold"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={modReviewThreshold}
              onChange={(event) => handleModReviewChange(Number(event.currentTarget.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
              <span>Submit most for review</span>
              <span>Only clear on-topic</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Images scored above this threshold but below the auto-delete threshold are sent to the
              mod queue.
            </p>
            {fieldErrors.thresholds ? (
              <p className="text-xs text-destructive">{fieldErrors.thresholds}</p>
            ) : null}
          </FormField>

          <FormField
            label="Mod queue channel"
            htmlFor="ir-mod-queue-channel"
            hint="Optional channel where uncertain images are posted for staff review."
          >
            <ChannelSelect
              allowClear
              id="ir-mod-queue-channel"
              channels={resources?.textChannels ?? []}
              value={modQueueChannelId}
              onChange={setModQueueChannelId}
              placeholder="Select a mod queue channel"
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "image_rules",
                dependencyKey: "mod_queue_channel",
                label: "mod queue channel",
                recommendedName: "image-rules-queue",
                accessRoleIds: modRoleIds,
              }}
            />
          </FormField>

          <FormField
            label="Mod roles"
            htmlFor="ir-mod-roles"
            hint="Roles that can be mentioned when an image needs review."
          >
            <MultiRoleSelect
              id="ir-mod-roles"
              roles={resources?.roles ?? []}
              value={modRoleIds}
              onChange={setModRoleIds}
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "image_rules",
                dependencyKey: "mod_role",
                label: "mod role",
                recommendedName: "Image Rules Moderator",
                accessChannelIds: modQueueChannelId ? [modQueueChannelId] : [],
              }}
            />
          </FormField>
        </div>

        <AdvancedSection
          title="Advanced Image Rules behaviour"
          description="Optional moderation workflow toggles. Collapse to focus on the basics."
        >
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Ping mod roles on queue post</p>
              <p className="text-xs text-muted-foreground">
                Notify the configured mod roles when an image is queued.
              </p>
            </div>
            <Switch
              checked={pingOnQueuePost}
              loading={autoSave.savingKey === "pingOnQueuePost"}
              success={autoSave.savedKey === "pingOnQueuePost"}
              onCheckedChange={(checked) =>
                void autoSave.saveToggle({
                  key: "pingOnQueuePost",
                  nextValue: checked,
                  previousValue: pingOnQueuePost,
                  applyValue: setPingOnQueuePost,
                  hasUnrelatedChanges: hasUnsavedChanges,
                  successMessage: "Saved ping preference.",
                })
              }
              aria-label="Ping mod roles on queue post"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">React to checked images</p>
              <p className="text-xs text-muted-foreground">
                Add a ✅ reaction when an image is classified as on-topic so staff can see it was
                checked.
              </p>
            </div>
            <Switch
              checked={reactOnTopic}
              loading={autoSave.savingKey === "reactOnTopic"}
              success={autoSave.savedKey === "reactOnTopic"}
              onCheckedChange={(checked) =>
                void autoSave.saveToggle({
                  key: "reactOnTopic",
                  nextValue: checked,
                  previousValue: reactOnTopic,
                  applyValue: setReactOnTopic,
                  hasUnrelatedChanges: hasUnsavedChanges,
                  successMessage: "Saved checked-image reaction preference.",
                })
              }
              aria-label="React to on-topic Image Rules messages"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Audit on-topic images</p>
              <p className="text-xs text-muted-foreground">
                Post successful Image Rules classifications to the Guild Audit Log when the event is
                enabled.
              </p>
            </div>
            <Switch
              checked={auditOnTopic}
              loading={autoSave.savingKey === "auditOnTopic"}
              success={autoSave.savedKey === "auditOnTopic"}
              onCheckedChange={(checked) =>
                void autoSave.saveToggle({
                  key: "auditOnTopic",
                  nextValue: checked,
                  previousValue: auditOnTopic,
                  applyValue: setAuditOnTopic,
                  hasUnrelatedChanges: hasUnsavedChanges,
                  successMessage: "Saved Image Rules audit preference.",
                })
              }
              aria-label="Audit on-topic Image Rules classifications"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                Dry run mode (training)
                <InfoTooltip
                  content="Classifies images and reports what the bot would do in the audit log without deleting messages, sending DMs, or creating mod queue items."
                  learnMoreHref="https://docs.hafbot.xyz/features/image-rules"
                />
              </p>
              <p className="text-xs text-muted-foreground">
                Classify images and report what the bot would do in the audit log, without deleting
                messages, sending DMs, or creating mod queue items.
              </p>
            </div>
            <Switch
              checked={dryRun}
              onCheckedChange={setDryRun}
              aria-label="Enable Image Rules dry run mode"
            />
          </div>
        </AdvancedSection>
      </SettingsBlock>

      <PageFeedback error={api.error} />
      <AdminBottomActionBar
        actions={[
          {
            label: "Discard changes",
            disabled: !hasUnsavedChanges || saving,
            variant: "outline",
            onClick: () => void handleDiscardChanges(),
          },
          {
            label: "Save",
            loadingLabel: "Saving…",
            loading: saving,
            successLabel: "Saved",
            success: savedSuccessfully,
            disabled: !hasUnsavedChanges || saving,
            variant: "accent",
            onClick: () => void saveConfig(),
          },
        ]}
      />
    </div>
  );
}
