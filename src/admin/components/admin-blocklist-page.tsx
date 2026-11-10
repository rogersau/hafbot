import { ConfigurationAvailabilityActions } from "./configuration-availability-actions";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { AdminTabs } from "./admin-tabs";
import { AdminPageHeader } from "./admin-page-header";
import {
  FormField,
  SectionHeader,
  SettingsBlock,
  SettingsPanel,
  AdvancedSection,
} from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect, MultiChannelSelect, RoleSelect } from "./guild-resource-select";
import { BlocklistEmojiField } from "./blocklist-emoji-field";
import { NoGuildSelected } from "./no-guild-selected";
import { Button } from "./ui/button";
import { XIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { DurationInput } from "./ui/duration-input";
import { PresetNumberInput } from "./ui/preset-number-input";
import { Switch } from "./ui/switch";
import { InfoTooltip } from "./ui/info-tooltip";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData, adminRefreshWarning } from "../lib/mutation-reconciliation";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { useAdminApi } from "../hooks/use-admin-api";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useGuildResources } from "../hooks/use-guild-resources";
import { useUnsavedChanges } from "../hooks/use-unsaved-changes";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { ReactionRulesTab } from "../lib/admin-route-state";
import { buildReactionRulesTabHref } from "../lib/admin-route-state";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { UpgradeBanner } from "./upgrade-banner";
import type { BlocklistLoaderData } from "../lib/admin-route-loaders";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { BlocklistSetupWizard } from "./blocklist-setup-wizard";
import { useAdminRouteContext } from "../routes/page-context";

type ReactionRuleTab = "blocklist" | "limits";
const REACTION_RULE_TABS: Array<{ id: ReactionRuleTab; label: string }> = [
  { id: "blocklist", label: "Blocklist" },
  { id: "limits", label: "Limits" },
];
type ChannelFilterMode = "include" | "exclude";
type ReactionLimitResourceConfig = NonNullable<BlocklistLoaderData["reactionLimits"]>["config"];

interface ChannelFilterForm {
  channelMode: ChannelFilterMode;
  channelIds: string[];
}

interface ReactionLimitConfigForm {
  limitsEnabled: boolean;
  maxReactionsPerMessage: string;
  maxReactionsPerUserPerMessage: string;
  breachThreshold: string;
  breachRoleId: string;
  breachRoleDurationMs: string;
  breachDmText: string;
}

export interface ReactionRulesSavedSnapshot {
  blocklistChannelFilter: ChannelFilterForm;
  notificationChannelId: string;
  limitForm: ReactionLimitConfigForm;
  limitChannelFilter: ChannelFilterForm;
}

export type ReactionRulesSaveSection =
  | "blocklistChannelFilter"
  | "notificationChannelId"
  | "reactionLimits";

const REACTION_RULES_SAVE_SECTION_LABELS: Record<ReactionRulesSaveSection, string> = {
  blocklistChannelFilter: "Blocklist channel filter",
  notificationChannelId: "Moderation log channel",
  reactionLimits: "Reaction limits",
};

export function AdminBlocklistPage({
  selectedWorkspaceId,
  selectedGuildId,
  activeTab = "blocklist",
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  activeTab?: ReactionRulesTab;
  entitlement?: EntitlementInfo | null;
  initialData?: BlocklistLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const initialSnapshot = createReactionRulesSnapshot(initialData);
  const trimmedGuildId = selectedGuildId.trim();
  const submittingEmojiRef = useRef<string | null>(null);
  const submittingBatchRef = useRef(false);
  const [submittingBatch, setSubmittingBatch] = useState(false);
  const [currentEmojis, setCurrentEmojis] = useState<string[] | null>(
    initialData?.blocklist.emojis ?? null,
  );
  const [enabled, setEnabled] = useState(initialData?.blocklist.enabled !== false);
  const [notificationChannelId, setNotificationChannelId] = useState(
    initialData?.blocklist.notificationChannelId ?? "",
  );
  const [blocklistChannelFilter, setBlocklistChannelFilter] = useState<ChannelFilterForm>(() => ({
    ...initialSnapshot.blocklistChannelFilter,
  }));
  const [limitForm, setLimitForm] = useState<ReactionLimitConfigForm>(
    () => initialSnapshot.limitForm,
  );
  const [limitChannelFilter, setLimitChannelFilter] = useState<ChannelFilterForm>(() => ({
    ...initialSnapshot.limitChannelFilter,
  }));
  const breachCounters = initialData?.reactionLimits?.counters ?? [];
  const [saving, setSaving] = useState(false);
  const [savingSection, setSavingSection] = useState<ReactionRulesSaveSection | null>(null);
  const savingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { resources, loading: resourcesLoading } = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
  );
  const { currentSearch } = useAdminRouteContext();
  const wizardFromUrl = new URLSearchParams(currentSearch).get("wizard") === "1";
  const [showBlocklistWizard, setShowBlocklistWizard] = useState(wizardFromUrl);
  const { dialog: confirmDialog, confirm } = useConfirmDialog();

  const [savedSnapshot, setSavedSnapshot] = useState<ReactionRulesSavedSnapshot>(initialSnapshot);

  const hasBlocklistFilterChanges = !areAdminActionSnapshotsEqual(
    blocklistChannelFilter,
    savedSnapshot.blocklistChannelFilter,
  );
  const hasNotificationChannelChanges =
    notificationChannelId.trim() !== savedSnapshot.notificationChannelId;
  const hasLimitChanges =
    !areAdminActionSnapshotsEqual(limitForm, savedSnapshot.limitForm) ||
    !areAdminActionSnapshotsEqual(limitChannelFilter, savedSnapshot.limitChannelFilter);
  const currentSnapshot = {
    blocklistChannelFilter,
    notificationChannelId: notificationChannelId.trim(),
    limitForm,
    limitChannelFilter,
  };
  const { hasChanges: hasUnsavedChanges } = useUnsavedChanges(currentSnapshot, savedSnapshot);
  const hasSaveableChanges =
    hasBlocklistFilterChanges || hasNotificationChannelChanges || hasLimitChanges;
  const saveDisabled = !hasSaveableChanges || saving;
  const debouncedLimitForm = useDebouncedValue(limitForm);
  const limitFieldErrors = validateReactionLimitFields(debouncedLimitForm);
  const feedbackMessage = saving
    ? `Saving ${savingSection ? REACTION_RULES_SAVE_SECTION_LABELS[savingSection] : "Reaction Rules"}…`
    : null;

  function discardChanges() {
    setBlocklistChannelFilter(savedSnapshot.blocklistChannelFilter);
    setNotificationChannelId(savedSnapshot.notificationChannelId);
    setLimitForm(savedSnapshot.limitForm);
    setLimitChannelFilter(savedSnapshot.limitChannelFilter);
    setSaved(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Reaction Rules changes?",
      description: "This restores the last saved Reaction Rules settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  function handleTabChange(nextTab: ReactionRuleTab) {
    if (typeof window === "undefined") return;
    void navigate({
      to: buildReactionRulesTabHref(
        `${window.location.pathname}${window.location.search}`,
        nextTab,
      ),
    });
  }

  async function handleSave(): Promise<boolean> {
    if (savingRef.current) return false;

    const firstLimitError = Object.values(validateReactionLimitFields(limitForm)).find(Boolean);
    if (firstLimitError) {
      setSaved(false);
      api.setError(firstLimitError);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setSavingSection(null);
    setSaved(false);
    api.setError(null);

    const submissionSnapshot = {
      blocklistChannelFilter: cloneChannelFilter(blocklistChannelFilter),
      notificationChannelId: notificationChannelId.trim(),
      limitForm: { ...limitForm },
      limitChannelFilter: cloneChannelFilter(limitChannelFilter),
    };
    const pendingSections: Array<ReactionRulesSaveSection> = [];
    if (
      !areAdminActionSnapshotsEqual(
        submissionSnapshot.blocklistChannelFilter,
        savedSnapshot.blocklistChannelFilter,
      )
    ) {
      pendingSections.push("blocklistChannelFilter");
    }
    if (submissionSnapshot.notificationChannelId !== savedSnapshot.notificationChannelId) {
      pendingSections.push("notificationChannelId");
    }
    if (
      !areAdminActionSnapshotsEqual(submissionSnapshot.limitForm, savedSnapshot.limitForm) ||
      !areAdminActionSnapshotsEqual(
        submissionSnapshot.limitChannelFilter,
        savedSnapshot.limitChannelFilter,
      )
    ) {
      pendingSections.push("reactionLimits");
    }

    const savedSections: ReactionRulesSaveSection[] = [];
    let currentSavingSection: ReactionRulesSaveSection | null = null;

    const markSectionSaved = (section: ReactionRulesSaveSection) => {
      savedSections.push(section);
      setSavedSnapshot((previous) =>
        reconcileReactionRulesSnapshot(previous, section, submissionSnapshot),
      );
    };

    const saveSection = async (section: ReactionRulesSaveSection, request: () => Promise<void>) => {
      currentSavingSection = section;
      setSavingSection(section);
      await request();
      // Reconcile each independent mutation before attempting the next one. A later
      // failure must not cause an already-persisted section to be retried.
      markSectionSaved(section);
    };

    try {
      const client = createAdminLoaderClient();
      if (pendingSections.includes("blocklistChannelFilter")) {
        await saveSection("blocklistChannelFilter", async () => {
          await client.postJson(
            "/admin/api/blocklist-channel-filter",
            {
              channelMode: submissionSnapshot.blocklistChannelFilter.channelMode,
              channelIds: submissionSnapshot.blocklistChannelFilter.channelIds,
            },
            { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
          );
        });
      }

      if (pendingSections.includes("notificationChannelId")) {
        await saveSection("notificationChannelId", async () => {
          await client.postJson(
            "/admin/api/blocklist-channel",
            {
              notificationChannelId: submissionSnapshot.notificationChannelId || null,
            },
            { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
          );
        });
      }

      if (pendingSections.includes("reactionLimits")) {
        await saveSection("reactionLimits", async () => {
          await client.postJson(
            "/admin/api/reaction-limits/config",
            {
              limitsEnabled: submissionSnapshot.limitForm.limitsEnabled,
              maxReactionsPerMessage: parseOptionalNumber(
                submissionSnapshot.limitForm.maxReactionsPerMessage,
              ),
              maxReactionsPerUserPerMessage: parseOptionalNumber(
                submissionSnapshot.limitForm.maxReactionsPerUserPerMessage,
              ),
              breachThreshold: parseOptionalNumber(submissionSnapshot.limitForm.breachThreshold),
              breachRoleId: submissionSnapshot.limitForm.breachRoleId.trim() || null,
              breachRoleDurationMs: parseOptionalNumber(
                submissionSnapshot.limitForm.breachRoleDurationMs,
              ),
              breachDmText: submissionSnapshot.limitForm.breachDmText.trim() || null,
              channelMode: submissionSnapshot.limitChannelFilter.channelMode,
              channelIds: submissionSnapshot.limitChannelFilter.channelIds,
            },
            { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
          );
        });
      }

      const savedLabels = savedSections.map((section) =>
        REACTION_RULES_SAVE_SECTION_LABELS[section].toLowerCase(),
      );
      const refreshed = await refreshAdminRouteData(onRouteDataRefresh, (refreshError) => {
        const message =
          `Saved ${savedLabels.join(", ")} for ${selectedGuildId}, but the page could not refresh. ` +
          `Your changes are saved; use Retry refresh to verify. ${describeSaveError(refreshError)}`;
        toast.info(message);
      });
      if (!refreshed) {
        setSaved(true);
        return true;
      }

      setSaved(true);
      toast.success(
        savedLabels.length > 0
          ? `Saved ${savedLabels.join(", ")} for ${selectedGuildId}.`
          : "No Reaction Rules changes to save.",
      );
      return true;
    } catch (err) {
      const failedSection = currentSavingSection;
      const failedLabel = failedSection
        ? REACTION_RULES_SAVE_SECTION_LABELS[failedSection]
        : "Reaction Rules";
      const savedLabels = savedSections.map(
        (section) => REACTION_RULES_SAVE_SECTION_LABELS[section],
      );
      const completed = savedLabels.length ? ` ${savedLabels.join(", ")} saved successfully.` : "";
      toast.error(
        `${failedLabel} could not be saved.${completed} ${describeSaveError(err)} Retry to save the remaining changes.`,
      );
      return false;
    } finally {
      setSaving(false);
      setSavingSection(null);
      savingRef.current = false;
    }
  }

  async function handleSubmitBlocklistEmojis(emojis: string[]): Promise<boolean> {
    if (submittingBatchRef.current || emojis.length === 0) return false;
    submittingBatchRef.current = true;
    setSubmittingBatch(true);
    try {
      const response = await createAdminLoaderClient().postJson<{
        added: string[];
        alreadyBlocked: string[];
        blocklist: { emojis: string[] };
      }>(
        "/admin/api/blocklist",
        {
          emojis,
          action: "add",
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      setCurrentEmojis(response.blocklist.emojis);
      await refreshAdminRouteData(onRouteDataRefresh, (error) => {
        toast.info(adminRefreshWarning("Block", error));
      });
      toast.success(
        response.added.length === 1
          ? `Blocked 1 emoji in ${selectedGuildId}`
          : `Blocked ${response.added.length} emojis in ${selectedGuildId}`,
      );
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to block emoji.");
      return false;
    } finally {
      submittingBatchRef.current = false;
      setSubmittingBatch(false);
    }
  }

  async function handleUnblockEmoji(blockedEmoji: string) {
    const submittedEmoji = blockedEmoji.trim();
    if (!submittedEmoji || submittingEmojiRef.current === submittedEmoji) return;
    submittingEmojiRef.current = submittedEmoji;
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/blocklist",
        {
          emoji: submittedEmoji,
          action: "remove",
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      setCurrentEmojis((current) => current?.filter((entry) => entry !== submittedEmoji) ?? []);
      await refreshAdminRouteData(onRouteDataRefresh, (error) => {
        toast.info(adminRefreshWarning("Unblock", error));
      });
      toast.success(`Unblocked ${submittedEmoji} in ${selectedGuildId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to unblock emoji.");
    } finally {
      submittingEmojiRef.current = null;
    }
  }

  async function handleFinishBlocklistSetup() {
    const completed = hasSaveableChanges ? await handleSave() : true;
    if (completed) setShowBlocklistWizard(false);
  }

  async function handleClearCounter(userId: string | null) {
    const confirmed = await confirm({
      title: userId ? "Clear breach counter?" : "Clear all breach counters?",
      description: userId
        ? `This resets reaction limit tracking for user ${userId}.`
        : "This resets reaction limit tracking for every recorded user in this guild.",
      confirmLabel: userId ? "Clear counter" : "Clear all counters",
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/reaction-limits/counter/clear",
        {
          userId,
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      await refreshAdminRouteData(onRouteDataRefresh, (error) => {
        toast.info(adminRefreshWarning("Counter clear", error));
      });
      toast.success(
        userId ? `Cleared breach counter for ${userId}.` : "Cleared all breach counters.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear breach counter.");
    }
  }

  return (
    <section className="admin-feature-page admin-page-settings space-y-6">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      {confirmDialog}
      <AdminPageHeader
        title="Reaction Rules"
        description="Manage blocked emoji reactions, channel filters, logging, and reaction limits from one place."
        actions={<UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />}
        readinessFeature="blocklist"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="blocklist" />
      ) : showBlocklistWizard && activeTab === "blocklist" ? (
        <>
          <PageFeedback message={api.error ? null : feedbackMessage} error={api.error} />
          <BlocklistSetupWizard
            currentEmojis={currentEmojis ?? []}
            resources={resources}
            resourcesLoading={resourcesLoading}
            channelMode={blocklistChannelFilter.channelMode}
            channelIds={blocklistChannelFilter.channelIds}
            notificationChannelId={notificationChannelId}
            saving={saving || submittingBatch}
            onSubmit={handleSubmitBlocklistEmojis}
            onChannelModeChange={(channelMode) =>
              setBlocklistChannelFilter((current) => ({ ...current, channelMode }))
            }
            onChannelIdsChange={(channelIds) =>
              setBlocklistChannelFilter((current) => ({ ...current, channelIds }))
            }
            onNotificationChannelChange={setNotificationChannelId}
            onFinish={() => void handleFinishBlocklistSetup()}
          />
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowBlocklistWizard(false)}>
              Use full settings
            </Button>
          </div>
        </>
      ) : (
        <SettingsPanel data-reaction-rules-tab={activeTab}>
          <PageFeedback message={api.error ? null : feedbackMessage} error={api.error} />

          <AdminTabs
            tabs={REACTION_RULE_TABS}
            activeTab={activeTab}
            ariaLabel="Reaction rules"
            className="-mt-4 mb-4 bg-background md:-mt-7 md:mb-6"
            onTabChange={handleTabChange}
          />

          {activeTab === "blocklist" && currentEmojis?.length === 0 ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowBlocklistWizard(true)}
              >
                Start setup wizard
              </Button>
            </div>
          ) : null}

          <div hidden={activeTab !== "blocklist"} className="space-y-5">
            {entitlement && entitlement.tier === "free" && currentEmojis !== null ? (
              <p className="text-xs text-muted-foreground">
                {currentEmojis.length} / {entitlement.limits.blocklistMaxEmojis} emojis blocked
              </p>
            ) : entitlement && currentEmojis !== null ? (
              <p className="text-xs text-muted-foreground">
                Unlimited Blocklist entries under this plan.
              </p>
            ) : null}

            {entitlement &&
            entitlement.tier === "free" &&
            currentEmojis !== null &&
            typeof entitlement.limits.blocklistMaxEmojis === "number" &&
            currentEmojis.length >= entitlement.limits.blocklistMaxEmojis ? (
              <UpgradeBanner supportInvite={entitlement.supportInvite} />
            ) : null}

            <SettingsBlock>
              <SectionHeader
                title="Blocklist"
                actions={
                  <ConfigurationAvailabilityActions
                    label="Blocklist"
                    enabled={enabled}
                    disabled={saving || api.loading || hasUnsavedChanges}
                    onEnabledChange={async (next) => {
                      await api.run(
                        async () => {
                          await createAdminLoaderClient().postJson(
                            "/admin/api/blocklist/enabled",
                            { enabled: next },
                            { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
                          );
                          await refreshAdminRouteData(onRouteDataRefresh);
                        },
                        () => {
                          setEnabled(next);
                          toast.success(`Blocklist ${next ? "enabled" : "disabled"}.`);
                        },
                      );
                    }}
                  />
                }
                description="Choose emoji that members are not allowed to use as reactions. Blocked reactions are removed automatically."
              />
              <FormField
                label="Emoji"
                hint="Select an emoji to add it to the Blocklist. HAF Bot removes that reaction automatically."
              >
                <BlocklistEmojiField
                  currentEmojis={currentEmojis ?? []}
                  emojis={resources?.emojis ?? []}
                  loading={resourcesLoading && (resources?.emojis?.length ?? 0) === 0}
                  submitting={submittingBatch}
                  onSubmit={handleSubmitBlocklistEmojis}
                />
              </FormField>
            </SettingsBlock>

            <AdvancedSection
              title="Advanced blocklist channel filter"
              description="Choose where blocked emoji should be enforced. Leave the channel list empty to enforce the blocklist everywhere."
            >
              <ChannelFilterSection
                label="Blocklist channel filter"
                mode={blocklistChannelFilter.channelMode}
                channelIds={blocklistChannelFilter.channelIds}
                channels={resources?.textChannels ?? []}
                onModeChange={(channelMode) =>
                  setBlocklistChannelFilter((current) => ({ ...current, channelMode }))
                }
                onChannelIdsChange={(channelIds) =>
                  setBlocklistChannelFilter((current) => ({ ...current, channelIds }))
                }
              />
            </AdvancedSection>

            <SettingsBlock>
              <SectionHeader
                title="Moderation log channel"
                description="Choose where the bot posts reaction rule changes and enforcement messages. Leave empty to disable these log messages."
              />
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_auto] md:items-end">
                <FormField label="Moderation log channel (optional)" htmlFor="bl-log-channel">
                  <ChannelSelect
                    allowClear
                    id="bl-log-channel"
                    channels={resources?.textChannels ?? []}
                    value={notificationChannelId}
                    onChange={(value) => setNotificationChannelId(value)}
                  />
                </FormField>
              </div>
            </SettingsBlock>

            {currentEmojis !== null ? (
              <SettingsBlock>
                {currentEmojis.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No emojis currently blocked in this guild.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Currently blocked:</p>
                    <div className="flex flex-wrap gap-2">
                      {currentEmojis.map((entry) => {
                        const match = (resources?.emojis ?? []).find((g) => g.name === entry);
                        return (
                          <span
                            key={entry}
                            className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                          >
                            {match ? (
                              <img
                                src={`https://cdn.discordapp.com/emojis/${match.id}.${match.animated ? "gif" : "png"}?size=32&quality=lossless`}
                                alt={match.name}
                                className="h-4 w-4 object-contain"
                                loading="lazy"
                              />
                            ) : null}
                            <span className="font-mono">{entry}</span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="-mr-1 h-5 w-5 rounded-sm text-muted-foreground hover:text-foreground"
                              aria-label={`Unblock ${entry}`}
                              title={`Unblock ${entry}`}
                              onClick={() => void handleUnblockEmoji(entry)}
                            >
                              <XIcon className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <p className="mt-2 text-sm text-muted-foreground">
                  {notificationChannelId.trim()
                    ? `Updates will be posted to channel #${resources?.textChannels.find((c) => c.id === notificationChannelId.trim())?.name ?? notificationChannelId.trim()}.`
                    : "Updates are not currently posted to a Discord channel."}
                </p>
              </SettingsBlock>
            ) : null}
          </div>

          <div hidden={activeTab !== "limits"} className="space-y-5">
            <SettingsBlock>
              <SectionHeader
                title="Reaction limits"
                description="Limit how many reactions can be added before the bot starts tracking abuse. Leave a limit blank to disable that limit."
              />
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  label="Reaction limits"
                  hint="Turn this on before the bot enforces the limits below."
                >
                  <div className="flex items-center gap-3 rounded-md border bg-background px-3 py-2">
                    <Switch
                      checked={limitForm.limitsEnabled}
                      onCheckedChange={(checked) =>
                        setLimitForm((current) => ({
                          ...current,
                          limitsEnabled: checked,
                        }))
                      }
                      aria-label="Toggle reaction limits"
                    />
                    <span className="text-sm text-muted-foreground">
                      {limitForm.limitsEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </FormField>
                <FormField
                  label="Max reactions per message"
                  htmlFor="rl-max-message"
                  hint="The total number of reactions allowed on one Discord message. Empty means no per-message limit."
                >
                  <PresetNumberInput
                    id="rl-max-message"
                    value={limitForm.maxReactionsPerMessage}
                    presets={[
                      { label: "5", value: "5" },
                      { label: "10", value: "10" },
                      { label: "No limit", value: "" },
                    ]}
                    onChange={(event) =>
                      setLimitForm((current) => ({
                        ...current,
                        maxReactionsPerMessage: event,
                      }))
                    }
                    placeholder="No limit"
                  />
                  {limitFieldErrors.maxReactionsPerMessage ? (
                    <p className="text-xs text-destructive">
                      {limitFieldErrors.maxReactionsPerMessage}
                    </p>
                  ) : null}
                </FormField>
                <FormField
                  label="Max reactions per user per message"
                  htmlFor="rl-max-user"
                  hint="The number of reactions one member can add to the same message. Empty means no per-user limit."
                >
                  <PresetNumberInput
                    id="rl-max-user"
                    value={limitForm.maxReactionsPerUserPerMessage}
                    presets={[
                      { label: "1", value: "1" },
                      { label: "3", value: "3" },
                      { label: "No limit", value: "" },
                    ]}
                    onChange={(event) =>
                      setLimitForm((current) => ({
                        ...current,
                        maxReactionsPerUserPerMessage: event,
                      }))
                    }
                    placeholder="No limit"
                  />
                  {limitFieldErrors.maxReactionsPerUserPerMessage ? (
                    <p className="text-xs text-destructive">
                      {limitFieldErrors.maxReactionsPerUserPerMessage}
                    </p>
                  ) : null}
                </FormField>
              </div>

              <AdvancedSection
                title="Advanced breach controls"
                description="Configure the timed role, DM, and channel filter applied when a user repeatedly breaches the reaction limits."
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        Breach threshold
                        <InfoTooltip
                          content="When a user exceeds the reaction limits this many times, the breach role is assigned for the configured duration."
                          learnMoreHref="https://docs.hafbot.xyz/features/reaction-rules"
                        />
                      </span>
                    }
                    htmlFor="rl-threshold"
                  >
                    <Input
                      id="rl-threshold"
                      inputMode="numeric"
                      value={limitForm.breachThreshold}
                      onChange={(event) =>
                        setLimitForm((current) => ({
                          ...current,
                          breachThreshold: event.target.value,
                        }))
                      }
                      placeholder="No role assignment"
                    />
                    {limitFieldErrors.breachThreshold ? (
                      <p className="text-xs text-destructive">{limitFieldErrors.breachThreshold}</p>
                    ) : null}
                  </FormField>
                  <FormField
                    label="Breach role"
                    htmlFor="rl-role"
                    hint="Role assigned when a member reaches the breach threshold. Leave empty to only track breaches."
                  >
                    <RoleSelect
                      allowClear
                      id="rl-role"
                      roles={resources?.roles ?? []}
                      value={limitForm.breachRoleId}
                      onChange={(value) =>
                        setLimitForm((current) => ({ ...current, breachRoleId: value }))
                      }
                      placeholder="Select a role"
                    />
                  </FormField>
                  <FormField
                    label="Timed role duration"
                    htmlFor="rl-duration"
                    hint="How long the breach role stays on the member, in milliseconds. Leave empty for no automatic removal."
                  >
                    <DurationInput
                      id="rl-duration"
                      value={limitForm.breachRoleDurationMs}
                      onChange={(value) =>
                        setLimitForm((current) => ({
                          ...current,
                          breachRoleDurationMs: value,
                        }))
                      }
                    />
                    {limitFieldErrors.breachRoleDurationMs ? (
                      <p className="text-xs text-destructive">
                        {limitFieldErrors.breachRoleDurationMs}
                      </p>
                    ) : null}
                  </FormField>
                  <FormField
                    label="Breach DM text"
                    htmlFor="rl-dm"
                    hint="Optional direct message sent to the member when the breach role is assigned."
                  >
                    <Input
                      id="rl-dm"
                      value={limitForm.breachDmText}
                      onChange={(event) =>
                        setLimitForm((current) => ({
                          ...current,
                          breachDmText: event.target.value,
                        }))
                      }
                      placeholder="You have exceeded the reaction limit. Staff have been notified."
                    />
                  </FormField>
                </div>
                <ChannelFilterFields
                  mode={limitChannelFilter.channelMode}
                  channelIds={limitChannelFilter.channelIds}
                  channels={resources?.textChannels ?? []}
                  onModeChange={(channelMode) =>
                    setLimitChannelFilter((current) => ({ ...current, channelMode }))
                  }
                  onChannelIdsChange={(channelIds) =>
                    setLimitChannelFilter((current) => ({ ...current, channelIds }))
                  }
                />
              </AdvancedSection>
            </SettingsBlock>

            <AdvancedSection
              title="Breach counters"
              description="Review accumulated limit breaches and clear counters after staff review."
            >
              <div className="flex items-center justify-end">
                <Button size="sm" variant="outline" onClick={() => void handleClearCounter(null)}>
                  Clear all
                </Button>
              </div>
              {breachCounters.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No reaction limit breaches recorded.
                </p>
              ) : (
                <div className="space-y-2">
                  {breachCounters.map((counter) => (
                    <div
                      key={counter.userId}
                      className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm"
                    >
                      <span className="font-mono">{counter.userId}</span>
                      <span>{counter.breachCount} breaches</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleClearCounter(counter.userId)}
                      >
                        Clear
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </AdvancedSection>
          </div>

          <AdminBottomActionBar
            actions={[
              {
                label: "Discard changes",
                disabled: !hasUnsavedChanges || saving,
                variant: "outline",
                onClick: () => void handleDiscardChanges(),
              },
              {
                label: "Save changes",
                loadingLabel: "Saving…",
                loading: saving,
                successLabel: "Saved",
                success: saved && !hasUnsavedChanges,
                disabled: saveDisabled,
                variant: "accent",
                onClick: () => void handleSave(),
              },
            ]}
          />
        </SettingsPanel>
      )}
    </section>
  );
}

function cloneChannelFilter(filter: ChannelFilterForm): ChannelFilterForm {
  return { channelMode: filter.channelMode, channelIds: [...filter.channelIds] };
}

export function reconcileReactionRulesSnapshot(
  previous: ReactionRulesSavedSnapshot,
  section: ReactionRulesSaveSection,
  values: ReactionRulesSavedSnapshot,
): ReactionRulesSavedSnapshot {
  switch (section) {
    case "blocklistChannelFilter":
      return {
        ...previous,
        blocklistChannelFilter: cloneChannelFilter(values.blocklistChannelFilter),
      };
    case "notificationChannelId":
      return { ...previous, notificationChannelId: values.notificationChannelId };
    case "reactionLimits":
      return {
        ...previous,
        limitForm: { ...values.limitForm },
        limitChannelFilter: cloneChannelFilter(values.limitChannelFilter),
      };
  }
}

function describeSaveError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Try again.";
}

function createReactionRulesSnapshot(
  data: BlocklistLoaderData | null | undefined,
): ReactionRulesSavedSnapshot {
  const blocklistChannelFilter = {
    channelMode: data?.blocklist.channelMode ?? "include",
    channelIds: [...(data?.blocklist.channelIds ?? [])],
  } satisfies ChannelFilterForm;
  const limitConfig = data?.reactionLimits?.config ?? null;
  const limitChannelFilter = {
    channelMode: limitConfig?.channelMode ?? "include",
    channelIds: [...(limitConfig?.channelIds ?? [])],
  } satisfies ChannelFilterForm;
  return {
    blocklistChannelFilter,
    notificationChannelId: (data?.blocklist.notificationChannelId ?? "").trim(),
    limitForm: createReactionLimitForm(limitConfig),
    limitChannelFilter,
  };
}

function createReactionLimitForm(config: ReactionLimitResourceConfig): ReactionLimitConfigForm {
  return {
    limitsEnabled: config?.limitsEnabled ?? false,
    maxReactionsPerMessage: formatOptionalNumber(config?.maxReactionsPerMessage),
    maxReactionsPerUserPerMessage: formatOptionalNumber(config?.maxReactionsPerUserPerMessage),
    breachThreshold: formatOptionalNumber(config?.breachThreshold),
    breachRoleId: config?.breachRoleId ?? "",
    breachRoleDurationMs: formatOptionalNumber(config?.breachRoleDurationMs),
    breachDmText: config?.breachDmText ?? "",
  };
}

export function validateReactionLimitFields(
  form: Pick<
    ReactionLimitConfigForm,
    | "maxReactionsPerMessage"
    | "maxReactionsPerUserPerMessage"
    | "breachThreshold"
    | "breachRoleDurationMs"
  >,
): Record<
  keyof Pick<
    ReactionLimitConfigForm,
    | "maxReactionsPerMessage"
    | "maxReactionsPerUserPerMessage"
    | "breachThreshold"
    | "breachRoleDurationMs"
  >,
  string | null
> {
  return {
    maxReactionsPerMessage: validateOptionalPositiveInteger(
      form.maxReactionsPerMessage,
      "Max reactions per message",
    ),
    maxReactionsPerUserPerMessage: validateOptionalPositiveInteger(
      form.maxReactionsPerUserPerMessage,
      "Max reactions per user per message",
    ),
    breachThreshold: validateOptionalPositiveInteger(form.breachThreshold, "Breach threshold"),
    breachRoleDurationMs: validateOptionalPositiveInteger(
      form.breachRoleDurationMs,
      "Timed role duration",
    ),
  };
}

function validateOptionalPositiveInteger(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isInteger(numeric) || numeric < 1) {
    return `${label} must be a positive whole number.`;
  }
  return null;
}

function ChannelFilterSection({
  label,
  mode,
  channelIds,
  channels,
  onModeChange,
  onChannelIdsChange,
}: {
  label: string;
  mode: ChannelFilterMode;
  channelIds: string[];
  channels: Array<{ id: string; name: string }>;
  onModeChange: (mode: ChannelFilterMode) => void;
  onChannelIdsChange: (channelIds: string[]) => void;
}) {
  return (
    <SettingsBlock>
      <SectionHeader title={label} />
      <ChannelFilterFields
        mode={mode}
        channelIds={channelIds}
        channels={channels}
        onModeChange={onModeChange}
        onChannelIdsChange={onChannelIdsChange}
      />
    </SettingsBlock>
  );
}

function ChannelFilterFields({
  mode,
  channelIds,
  channels,
  disabled,
  onModeChange,
  onChannelIdsChange,
}: {
  mode: ChannelFilterMode;
  channelIds: string[];
  channels: Array<{ id: string; name: string }>;
  disabled?: boolean;
  onModeChange: (mode: ChannelFilterMode) => void;
  onChannelIdsChange: (channelIds: string[]) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,0.55fr)_minmax(0,1fr)]">
        <FormField
          label="Filter mode"
          hint="Include means only selected channels use the rule. Exclude means every channel except the selected ones uses the rule."
        >
          <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-1.5">
            <Button
              type="button"
              size="sm"
              variant={mode === "include" ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onModeChange("include")}
            >
              Include
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "exclude" ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onModeChange("exclude")}
            >
              Exclude
            </Button>
          </div>
        </FormField>
        <FormField label="Channels" hint="Leave empty to apply this rule to every channel.">
          <MultiChannelSelect
            channels={channels}
            value={channelIds}
            disabled={disabled}
            onChange={onChannelIdsChange}
          />
        </FormField>
      </div>
      <p className="text-xs text-muted-foreground">
        {channelIds.length === 0
          ? "No channels selected means all channels are included."
          : mode === "include"
            ? "Only selected channels are included. Switching to include preserves your selection."
            : "Selected channels are excluded; all other channels are included."}
      </p>
    </div>
  );
}

function formatOptionalNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}
