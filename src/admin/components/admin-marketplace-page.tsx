import { ConfigurationActions } from "./configuration-actions";
import { useMemo, useState } from "react";

import type {
  MarketplaceAdditionalChoice,
  MarketplaceBusinessLog,
  MarketplaceConfig,
  MarketplacePost,
} from "../../types";
import { DEFAULT_MARKETPLACE_NOTICE_EMBED } from "../../marketplace-config";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect } from "./guild-resource-select";
import { EmojiPicker } from "./emoji-picker";
import { ServerOptionsEditor } from "./server-options-editor";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { DiscordMessagePreview } from "./discord-message-preview";
import { Input } from "./ui/input";
import { ColorInput, formatHexColor } from "./ui/color-input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { MarketplaceLoaderData } from "../lib/admin-route-loaders";
import { NOTICEBOARD_SAVE_SUCCESS_MESSAGE } from "../lib/noticeboard-copy";
import { copyTextToClipboard } from "../lib/clipboard";

interface MarketplaceResource {
  config: MarketplaceConfig;
  posts: MarketplacePost[];
  logs: MarketplaceBusinessLog[];
}

export const MARKETPLACE_MAX_ADDITIONAL_CHOICES = 10;
export const MARKETPLACE_MAX_OPTIONS_PER_CHOICE = 25;

const MARKETPLACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateAdditionalChoices(choices: MarketplaceAdditionalChoice[]): string[] {
  const errors: string[] = [];
  const choiceIds = new Set<string>();
  choices.forEach((choice, choiceIndex) => {
    const question = choice.label.trim() || `Question ${choiceIndex + 1}`;
    if (!choice.id.trim()) errors.push(`${question}: ID is required.`);
    else if (!MARKETPLACE_ID_PATTERN.test(choice.id)) {
      errors.push(`${question}: ID may contain only letters, numbers, hyphens, and underscores.`);
    }
    if (choiceIds.has(choice.id)) errors.push(`${question}: duplicate question ID "${choice.id}".`);
    choiceIds.add(choice.id);
    const optionIds = new Set<string>();
    choice.options.forEach((option, optionIndex) => {
      const optionName = option.label.trim() || `Option ${optionIndex + 1}`;
      if (!option.id.trim()) errors.push(`${question} / ${optionName}: ID is required.`);
      else if (!MARKETPLACE_ID_PATTERN.test(option.id)) {
        errors.push(
          `${question} / ${optionName}: ID may contain only letters, numbers, hyphens, and underscores.`,
        );
      }
      if (optionIds.has(option.id)) errors.push(`${question}: duplicate option ID "${option.id}".`);
      optionIds.add(option.id);
    });
  });
  return errors;
}

export function AdminMarketplacePage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: MarketplaceLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Marketplace"
        description="Configure the marketplace noticeboard, server choices, and post management."
        readinessFeature="marketplace"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="marketplace" />
      ) : (
        <MarketplaceEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function MarketplaceEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: MarketplaceLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resource, setResource] = useState<MarketplaceResource | null>(initialData ?? null);
  const [savedConfig, setSavedConfig] = useState<MarketplaceConfig | null>(
    initialData?.config ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [closingPostId, setClosingPostId] = useState<string | null>(null);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  function discardChanges() {
    if (!savedConfig) return;
    setResource((current) => (current ? { ...current, config: savedConfig } : current));
    setSaved(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Marketplace changes?",
      description: "This restores the last saved Marketplace settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    if (!resource) return;
    const choiceErrors = validateAdditionalChoices(resource.config.additionalChoices ?? []);
    const savedChoices = savedConfig?.additionalChoices ?? [];
    const savedIds = new Set(
      savedChoices.flatMap((choice) => [choice.id, ...choice.options.map((option) => option.id)]),
    );
    const changedInvalidId = (resource.config.additionalChoices ?? []).some((choice) => {
      const choiceInvalid =
        Boolean(choice.id && !MARKETPLACE_ID_PATTERN.test(choice.id)) && !savedIds.has(choice.id);
      const optionInvalid = choice.options.some((option) => {
        return (
          Boolean(option.id && !MARKETPLACE_ID_PATTERN.test(option.id)) && !savedIds.has(option.id)
        );
      });
      return choiceInvalid || optionInvalid;
    });
    const blockingChoiceErrors = choiceErrors.filter(
      (error) => !error.includes("ID may contain") || changedInvalidId,
    );
    if (blockingChoiceErrors.length > 0) {
      api.setError(`Fix Additional Choices before saving: ${blockingChoiceErrors[0]}`);
      return;
    }
    setSaved(false);
    api.setError(null);
    setSaving(true);
    try {
      await createAdminLoaderClient().postJson("/admin/api/marketplace/config", resource.config, {
        workspaceId: selectedWorkspaceId,
      });
      setSavedConfig(resource.config);
      toast.success(NOTICEBOARD_SAVE_SUCCESS_MESSAGE);
      setSaved(true);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save marketplace config.");
    } finally {
      setSaving(false);
    }
  }

  async function disableFeature() {
    if (disabling || saving || publishing) return;
    const confirmed = await confirm({
      title: "Disable Marketplace?",
      description:
        "This stops new posts and removes the noticeboard. Existing posts, channels, roles, and saved settings are kept. Unsaved changes on this page will be discarded.",
      confirmLabel: "Disable Marketplace",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    setDisabling(true);
    try {
      const result = await createAdminLoaderClient().postJson<{
        config: MarketplaceConfig;
        noticeRemoved: boolean;
      }>(
        "/admin/api/marketplace/disable",
        {},
        {
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
        },
      );
      setResource((current) => (current ? { ...current, config: result.config } : current));
      setSavedConfig(result.config);
      setSaved(false);
      toast.success("Marketplace disabled.");
      if (!result.noticeRemoved) {
        toast.info(
          "The old noticeboard could not be removed. You can delete it in Discord; its create button no longer accepts new posts.",
        );
      }
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable Marketplace.");
    } finally {
      setDisabling(false);
    }
  }

  async function handlePublish() {
    if (!resource) return;
    api.setError(null);
    setPublishing(true);

    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/marketplace/publish",
        {
          channelId: resource.config.noticeChannelId,
        },
        { guildId: resource.config.guildId },
      );
      toast.success("Marketplace noticeboard published successfully.");
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to publish marketplace noticeboard.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function closePost(post: MarketplacePost) {
    if (closingPostId) return;
    const confirmed = await confirm({
      title: "Close marketplace post?",
      description: `Close ${post.ownerDisplayName}'s ${post.tradeType} post (${post.have} → ${post.want}), created ${formatAge(post.createdAtMs)} ago? The owner can repost if they still want to trade.`,
      confirmLabel: "Close post",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    setClosingPostId(post.id);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/marketplace/post/close",
        {
          postId: post.id,
          closedByUserId: "admin-dashboard",
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      toast.success(`Closed marketplace post ${post.id}.`);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close marketplace post.");
    } finally {
      setClosingPostId(null);
    }
  }

  if (!resource) {
    return (
      <p className="text-sm text-muted-foreground">
        {api.loading ? "Loading marketplace…" : "Marketplace not loaded."}
      </p>
    );
  }

  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(resource.config, savedConfig);
  const noticeEmbed = resource.config.noticeEmbed ?? DEFAULT_MARKETPLACE_NOTICE_EMBED;
  const additionalChoiceErrors = validateAdditionalChoices(resource.config.additionalChoices ?? []);

  function updateAdditionalChoice(index: number, patch: Partial<MarketplaceAdditionalChoice>) {
    const additionalChoices = [...(resource?.config.additionalChoices ?? [])];
    additionalChoices[index] = { ...additionalChoices[index]!, ...patch };
    setResource((current) =>
      current ? { ...current, config: { ...current.config, additionalChoices } } : current,
    );
  }

  async function removeAdditionalChoice(index: number) {
    const current = resource;
    if (!current) return;
    const choices = current.config.additionalChoices ?? [];
    const choice = choices[index];
    if (!choice) return;
    if (choice.options.length > 0) {
      const confirmed = await confirm({
        title: `Remove "${choice.label || `Question ${index + 1}`}"?`,
        description: `This removes the question and its ${choice.options.length} configured option${choice.options.length === 1 ? "" : "s"}. This cannot be undone after saving.`,
        confirmLabel: "Remove question",
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    setResource({
      ...current,
      config: { ...current.config, additionalChoices: choices.filter((_, i) => i !== index) },
    });
  }

  function moveChoice(choiceIndex: number, direction: -1 | 1) {
    const current = resource;
    if (!current) return;
    const choices = [...(current.config.additionalChoices ?? [])];
    const target = choiceIndex + direction;
    if (target < 0 || target >= choices.length) return;
    [choices[choiceIndex], choices[target]] = [choices[target]!, choices[choiceIndex]!];
    setResource({ ...current, config: { ...current.config, additionalChoices: choices } });
  }

  function moveOption(choiceIndex: number, optionIndex: number, direction: -1 | 1) {
    const current = resource;
    if (!current) return;
    const choices = [...(current.config.additionalChoices ?? [])];
    const choice = choices[choiceIndex];
    if (!choice) return;
    const options = [...choice.options];
    const target = optionIndex + direction;
    if (target < 0 || target >= options.length) return;
    [options[optionIndex], options[target]] = [options[target]!, options[optionIndex]!];
    choices[choiceIndex] = { ...choice, options };
    setResource({ ...current, config: { ...current.config, additionalChoices: choices } });
  }

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <SettingsBlock>
        <SectionHeader
          title="Marketplace configuration"
          description="Set up the noticeboard channel and server options."
          actions={
            <ConfigurationActions
              label="Marketplace"
              enabled={Boolean(savedConfig?.noticeChannelId) && savedConfig?.enabled !== false}
              actions={[
                {
                  label:
                    savedConfig?.noticeChannelId && savedConfig.enabled !== false
                      ? "Disable Marketplace"
                      : "Enable Marketplace",
                  disabled:
                    saving ||
                    publishing ||
                    disabling ||
                    hasUnsavedChanges ||
                    !savedConfig?.noticeChannelId,
                  onSelect: () =>
                    void (savedConfig?.enabled === false ? handlePublish() : disableFeature()),
                },
              ]}
            />
          }
        />
        {savedConfig?.enabled === false ? (
          <p className="text-sm text-muted-foreground">
            Marketplace is disabled. Use More actions to enable it again.
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="Noticeboard channel"
            htmlFor="mp-notice-channel"
            hint="Channel where the public Marketplace panel is posted. Members use this panel to create Marketplace Posts."
          >
            <ChannelSelect
              allowClear
              id="mp-notice-channel"
              channels={resources?.textChannels ?? []}
              value={resource.config.noticeChannelId ?? ""}
              onChange={(value) =>
                setResource({
                  ...resource,
                  config: {
                    ...resource.config,
                    noticeChannelId: value || null,
                  },
                })
              }
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "marketplace",
                dependencyKey: "notice_channel",
                label: "noticeboard channel",
                recommendedName: "marketplace",
              }}
            />
          </FormField>
          <FormField
            label="Log channel"
            htmlFor="mp-log-channel"
            hint="Optional channel where Marketplace Posts, buyer contact attempts, and delivery failures are logged."
          >
            <ChannelSelect
              allowClear
              id="mp-log-channel"
              channels={resources?.textChannels ?? []}
              value={resource.config.logChannelId ?? ""}
              onChange={(value) =>
                setResource({
                  ...resource,
                  config: {
                    ...resource.config,
                    logChannelId: value || null,
                  },
                })
              }
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "marketplace",
                dependencyKey: "log_channel",
                label: "log channel",
                recommendedName: "marketplace-log",
              }}
            />
          </FormField>
        </div>
        <div className="space-y-4 rounded-md border p-4">
          <SectionHeader
            title="Noticeboard embed"
            description="Customize the public embed and the button members use to start a Marketplace Post."
          />
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Embed title" htmlFor="mp-embed-title">
              <Input
                id="mp-embed-title"
                value={noticeEmbed.title}
                onChange={(event) =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      noticeEmbed: { ...noticeEmbed, title: event.target.value },
                    },
                  })
                }
              />
            </FormField>
            <FormField label="Embed color" htmlFor="mp-embed-color">
              <ColorInput
                key={noticeEmbed.color}
                id="mp-embed-color"
                value={noticeEmbed.color}
                onChange={(color) =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      noticeEmbed: { ...noticeEmbed, color },
                    },
                  })
                }
              />
            </FormField>
          </div>
          <FormField label="Embed description" htmlFor="mp-embed-description">
            <Textarea
              id="mp-embed-description"
              value={noticeEmbed.description}
              onChange={(event) =>
                setResource({
                  ...resource,
                  config: {
                    ...resource.config,
                    noticeEmbed: { ...noticeEmbed, description: event.target.value },
                  },
                })
              }
            />
          </FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Create button label" htmlFor="mp-button-label">
              <Input
                id="mp-button-label"
                value={noticeEmbed.buttonLabel}
                onChange={(event) =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      noticeEmbed: { ...noticeEmbed, buttonLabel: event.target.value },
                    },
                  })
                }
              />
            </FormField>
            <FormField label="Create button emoji">
              <EmojiPicker
                emojis={resources?.emojis ?? []}
                selectedValue={noticeEmbed.buttonEmoji}
                onSelect={(selection) =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      noticeEmbed: { ...noticeEmbed, buttonEmoji: selection.value },
                    },
                  })
                }
              />
            </FormField>
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable server choice</p>
              <p className="text-xs text-muted-foreground">
                Ask members to choose a server before continuing their Marketplace Post.
              </p>
            </div>
            <Switch
              checked={resource.config.serverChoiceEnabled ?? true}
              onCheckedChange={(checked) =>
                setResource({
                  ...resource,
                  config: { ...resource.config, serverChoiceEnabled: checked },
                })
              }
              aria-label="Enable marketplace server choice"
            />
          </div>
          {(resource.config.serverChoiceEnabled ?? true) ? (
            <>
              <p className="text-sm font-medium text-foreground">Server choices</p>
              <p className="text-xs text-muted-foreground">
                Options members can choose from when creating a Marketplace Post. The ID is stored
                internally; the label is shown to members.
              </p>
              <ServerOptionsEditor
                options={resource.config.serverOptions}
                emojis={resources?.emojis ?? []}
                onChange={(serverOptions) =>
                  setResource({ ...resource, config: { ...resource.config, serverOptions } })
                }
              />
            </>
          ) : null}
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable additional choices</p>
              <p className="text-xs text-muted-foreground">
                Add ordered option steps after the optional server choice.
              </p>
            </div>
            <Switch
              checked={resource.config.additionalChoicesEnabled ?? false}
              onCheckedChange={(checked) =>
                setResource({
                  ...resource,
                  config: { ...resource.config, additionalChoicesEnabled: checked },
                })
              }
              aria-label="Enable marketplace additional choices"
            />
          </div>
          {(resource.config.additionalChoicesEnabled ?? false) ? (
            <>
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">Additional Choices question builder</span>
                  <span className="text-xs text-muted-foreground">
                    {(resource.config.additionalChoices ?? []).length}/
                    {MARKETPLACE_MAX_ADDITIONAL_CHOICES} questions · up to{" "}
                    {MARKETPLACE_MAX_OPTIONS_PER_CHOICE} options each
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Questions run in the order shown. Members see the question and option labels; IDs
                  are only used to retain saved post metadata.
                </p>
              </div>
              {additionalChoiceErrors.length > 0 ? (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                  role="alert"
                >
                  {additionalChoiceErrors[0]} Fix the highlighted IDs before saving.
                </p>
              ) : null}
              {(resource.config.additionalChoices ?? []).map((choice, choiceIndex) => (
                <div
                  key={`${choice.id}-${choiceIndex}`}
                  className="space-y-3 rounded-md border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Question {choiceIndex + 1}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {choice.options.length}/{MARKETPLACE_MAX_OPTIONS_PER_CHOICE} options
                        configured
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={choiceIndex === 0}
                        aria-label={`Move question ${choiceIndex + 1} up`}
                        onClick={() => moveChoice(choiceIndex, -1)}
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          choiceIndex === (resource.config.additionalChoices ?? []).length - 1
                        }
                        aria-label={`Move question ${choiceIndex + 1} down`}
                        onClick={() => moveChoice(choiceIndex, 1)}
                      >
                        Move down
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void removeAdditionalChoice(choiceIndex)}
                      >
                        Remove question
                      </Button>
                    </div>
                  </div>
                  <FormField
                    label="Question for members"
                    htmlFor={`mp-choice-label-${choiceIndex}`}
                  >
                    <Input
                      id={`mp-choice-label-${choiceIndex}`}
                      aria-label={`Question ${choiceIndex + 1}`}
                      value={choice.label}
                      onChange={(event) =>
                        updateAdditionalChoice(choiceIndex, { label: event.target.value })
                      }
                      placeholder="What kind of listing is this?"
                    />
                  </FormField>
                  <details className="rounded-md border bg-muted/10 p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Advanced · internal question ID
                    </summary>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Changing an ID can affect metadata on existing posts.
                    </p>
                    <Input
                      className="mt-2"
                      aria-label={`Question ${choiceIndex + 1} ID`}
                      value={choice.id}
                      onChange={(event) =>
                        updateAdditionalChoice(choiceIndex, { id: event.target.value })
                      }
                      placeholder="listing-type"
                    />
                  </details>
                  {choice.options.map((option, optionIndex) => (
                    <div
                      key={`${option.id}-${optionIndex}`}
                      className="space-y-2 rounded-md border border-dashed p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Option {optionIndex + 1}
                        </span>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={optionIndex === 0}
                            aria-label={`Move option ${optionIndex + 1} up`}
                            onClick={() => moveOption(choiceIndex, optionIndex, -1)}
                          >
                            Move up
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={optionIndex === choice.options.length - 1}
                            aria-label={`Move option ${optionIndex + 1} down`}
                            onClick={() => moveOption(choiceIndex, optionIndex, 1)}
                          >
                            Move down
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={choice.options.length <= 2}
                            onClick={() =>
                              updateAdditionalChoice(choiceIndex, {
                                options: choice.options.filter((_, index) => index !== optionIndex),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-[1.5fr_0.7fr]">
                        <Input
                          aria-label={`Option ${optionIndex + 1} label`}
                          value={option.label}
                          onChange={(event) => {
                            const options = [...choice.options];
                            options[optionIndex] = { ...option, label: event.target.value };
                            updateAdditionalChoice(choiceIndex, { options });
                          }}
                          placeholder="Vehicle"
                        />
                        <EmojiPicker
                          emojis={resources?.emojis ?? []}
                          selectedValue={option.emoji}
                          onSelect={(selection) => {
                            const options = [...choice.options];
                            options[optionIndex] = { ...option, emoji: selection.value };
                            updateAdditionalChoice(choiceIndex, { options });
                          }}
                        />
                      </div>
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Advanced · internal option ID
                        </summary>
                        <Input
                          className="mt-2"
                          aria-label={`Option ${optionIndex + 1} ID`}
                          value={option.id}
                          onChange={(event) => {
                            const options = [...choice.options];
                            options[optionIndex] = { ...option, id: event.target.value };
                            updateAdditionalChoice(choiceIndex, { options });
                          }}
                          placeholder="vehicle"
                        />
                      </details>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={choice.options.length >= MARKETPLACE_MAX_OPTIONS_PER_CHOICE}
                    onClick={() => {
                      const optionId = nextAvailableId(
                        "option",
                        choice.options.map((option) => option.id),
                      );
                      updateAdditionalChoice(choiceIndex, {
                        options: [
                          ...choice.options,
                          {
                            id: optionId,
                            label: `Option ${optionId.slice("option-".length)}`,
                            emoji: null,
                          },
                        ],
                      });
                    }}
                  >
                    Add option
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                disabled={
                  (resource.config.additionalChoices ?? []).length >=
                  MARKETPLACE_MAX_ADDITIONAL_CHOICES
                }
                onClick={() => {
                  const choiceId = nextAvailableId(
                    "choice",
                    (resource.config.additionalChoices ?? []).map((choice) => choice.id),
                  );
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      additionalChoices: [
                        ...(resource.config.additionalChoices ?? []),
                        {
                          id: choiceId,
                          label: `Choice ${choiceId.slice("choice-".length)}`,
                          options: [
                            { id: "option-1", label: "Option 1", emoji: null },
                            { id: "option-2", label: "Option 2", emoji: null },
                          ],
                        },
                      ],
                    },
                  });
                }}
              >
                Add choice
              </Button>
            </>
          ) : null}
        </div>
      </SettingsBlock>

      <MarketplaceNoticeboardPreview config={resource.config} />
      <MarketplaceMemberFlowPreview config={resource.config} />

      <SettingsBlock>
        <SectionHeader
          title="Marketplace posts"
          description="Search, inspect, and close Marketplace Posts. Newest posts appear first."
        />
        <MarketplacePostsTable
          posts={resource.posts}
          onClose={closePost}
          closingPostId={closingPostId}
        />
      </SettingsBlock>
      <SettingsBlock>
        <SectionHeader
          title="Business logs"
          description="Track buyer contact attempts and marketplace message delivery."
        />
        <MarketplaceLogsTable logs={resource.logs} posts={resource.posts} />
      </SettingsBlock>

      <PageFeedback error={api.error} />
      <AdminBottomActionBar
        actions={[
          {
            label: "Discard changes",
            disabled: !hasUnsavedChanges || saving || publishing || disabling,
            variant: "outline",
            onClick: () => void handleDiscardChanges(),
          },
          {
            label: resource.config.noticeMessageId ? "Update noticeboard" : "Publish noticeboard",
            loadingLabel: "Publishing...",
            loading: publishing,
            disabled:
              publishing ||
              saving ||
              disabling ||
              hasUnsavedChanges ||
              !resource.config.noticeChannelId,
            variant: "secondary",
            onClick: () => void handlePublish(),
          },
          {
            label: "Save marketplace config",
            loadingLabel: "Saving...",
            loading: saving,
            successLabel: "Saved",
            success: !hasUnsavedChanges && saved,
            disabled: !hasUnsavedChanges || saving || publishing || disabling,
            variant: "accent",
            onClick: () => void saveConfig(),
          },
        ]}
      />
      {hasUnsavedChanges ? (
        <p className="text-right text-xs text-muted-foreground">
          Save changes before publishing the noticeboard.
        </p>
      ) : null}
    </div>
  );
}

function MarketplaceNoticeboardPreview({ config }: { config: MarketplaceConfig }) {
  const embed = config.noticeEmbed ?? DEFAULT_MARKETPLACE_NOTICE_EMBED;
  return (
    <SettingsBlock>
      <SectionHeader title="Panel preview" />
      <DiscordMessagePreview
        embedTitle={embed.title}
        embedDescription={embed.description}
        embedColor={formatHexColor(embed.color)}
        buttons={[
          {
            label: embed.buttonLabel,
            emoji: embed.buttonEmoji ?? undefined,
            variant: "primary",
          },
        ]}
      />
    </SettingsBlock>
  );
}

function MarketplaceMemberFlowPreview({ config }: { config: MarketplaceConfig }) {
  const choices = config.additionalChoicesEnabled ? (config.additionalChoices ?? []) : [];
  return (
    <SettingsBlock>
      <SectionHeader
        title="Member flow preview"
        description="The order members experience when creating a Marketplace Post."
      />
      <ol className="space-y-2 text-sm" aria-label="Member flow preview">
        {config.serverChoiceEnabled !== false ? (
          <li className="flex items-center gap-2 rounded-md border bg-muted/20 p-3">
            <Badge variant="info">1</Badge>
            <span>Server choice</span>
          </li>
        ) : null}
        {choices.map((choice, index) => (
          <li
            key={`${choice.id}-${index}`}
            className="flex items-center gap-2 rounded-md border bg-muted/20 p-3"
          >
            <Badge variant="default">
              {(config.serverChoiceEnabled !== false ? 2 : 1) + index}
            </Badge>
            <span>{choice.label || `Question ${index + 1}`}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {choice.options.length} options
            </span>
          </li>
        ))}
        {config.serverChoiceEnabled === false && choices.length === 0 ? (
          <li className="rounded-md border border-dashed p-3 text-muted-foreground">
            No member choices configured.
          </li>
        ) : null}
      </ol>
    </SettingsBlock>
  );
}

function nextAvailableId(prefix: string, existingIds: string[]): string {
  const usedIds = new Set(existingIds);
  let suffix = 1;
  while (usedIds.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

function MarketplacePostsTable({
  posts,
  onClose,
  closingPostId,
}: {
  posts: MarketplacePost[];
  onClose: (post: MarketplacePost) => void;
  closingPostId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "closed">("all");
  const filteredPosts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...posts]
      .filter((post) => status === "all" || (status === "active" ? post.active : !post.active))
      .filter((post) => {
        if (!normalized) return true;
        const choices = (post.additionalChoices ?? [])
          .flatMap((choice) => [
            choice.choiceId,
            choice.choiceLabel,
            choice.optionId,
            choice.optionLabel,
          ])
          .join(" ");
        return [
          post.id,
          post.ownerDisplayName,
          post.ownerId,
          post.serverLabel,
          post.have,
          post.want,
          choices,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [posts, query, status]);
  const columns: ResponsiveTableColumn<MarketplacePost>[] = [
    {
      header: "Post",
      cell: (post) => <PostDetails post={post} onClose={onClose} closingPostId={closingPostId} />,
      className: "font-mono text-xs",
    },
    {
      header: "Owner",
      cell: (post) => (
        <span>
          {post.ownerDisplayName}
          <span className="block text-xs text-muted-foreground">
            {formatAge(post.createdAtMs)} ago
          </span>
        </span>
      ),
    },
    {
      header: "Trade",
      cell: (post) => (
        <span>
          {post.have} <span className="text-muted-foreground">→</span> {post.want}
        </span>
      ),
    },
    { header: "Server", cell: (post) => post.serverLabel || "—" },
    {
      header: "Status",
      cell: (post) => (
        <Badge variant={post.active ? "success" : "default"}>
          {post.active ? "Active" : "Closed"}
        </Badge>
      ),
    },
    {
      header: "Action",
      cell: (post) => (
        <Button
          size="sm"
          variant="outline"
          disabled={!post.active || closingPostId === post.id}
          loading={closingPostId === post.id}
          loadingLabel="Closing…"
          onClick={() => onClose(post)}
        >
          Close post
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <Input
          aria-label="Search marketplace posts"
          placeholder="Search post, owner, server, Have, Want, or choices"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter marketplace posts"
          className="admin-input h-9 rounded-md border bg-background px-3 text-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="all">All posts</option>
          <option value="active">Active only</option>
          <option value="closed">Closed only</option>
        </select>
      </div>
      {posts.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No Marketplace Posts yet.
        </p>
      ) : filteredPosts.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No Marketplace Posts match these filters.
        </p>
      ) : (
        <ResponsiveTable rows={filteredPosts} rowKey={(post) => post.id} columns={columns} />
      )}
    </div>
  );
}

function PostDetails({
  post,
  onClose,
  closingPostId,
}: {
  post: MarketplacePost;
  onClose: (post: MarketplacePost) => void;
  closingPostId?: string | null;
}) {
  return (
    <details id={`marketplace-post-${post.id}`} className="min-w-[220px]">
      <summary className="cursor-pointer">
        <span className="font-mono text-xs">{post.id}</span>
        <span className="ml-2 text-xs text-primary">View details</span>
      </summary>
      <div className="mt-3 space-y-2 rounded-md border bg-muted/10 p-3 text-sm font-sans">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{post.ownerDisplayName}</strong>
          <CopyIdButton value={post.ownerId} label="Copy owner ID" />
        </div>
        <p>
          <strong>Discord user ID:</strong> <code>{post.ownerId}</code>
        </p>
        <dl className="grid gap-1 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Have</dt>
            <dd>{post.have || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Want</dt>
            <dd>{post.want || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Extra</dt>
            <dd>{post.extra || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Trade type</dt>
            <dd>{post.tradeType}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Server</dt>
            <dd>{post.serverLabel || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Created</dt>
            <dd>
              {formatDate(post.createdAtMs)} ({formatAge(post.createdAtMs)} ago)
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Closed</dt>
            <dd>{post.closedAtMs ? formatDate(post.closedAtMs) : "Still active"}</dd>
          </div>
          {post.closedByUserId ? (
            <div>
              <dt className="text-xs text-muted-foreground">Closed by</dt>
              <dd>{post.closedByUserId}</dd>
            </div>
          ) : null}
        </dl>
        {(post.additionalChoices ?? []).length > 0 ? (
          <div>
            <p className="text-xs text-muted-foreground">Additional Choices</p>
            <ul className="list-disc pl-5">
              {post.additionalChoices!.map((choice) => (
                <li key={`${choice.choiceId}-${choice.optionId}`}>
                  {choice.choiceLabel}: {choice.optionLabel}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {post.channelId && post.messageId ? (
          <a
            className="text-primary underline"
            href={discordMessageUrl(post.guildId, post.channelId, post.messageId)}
            target="_blank"
            rel="noreferrer"
          >
            Open in Discord
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">Discord message link unavailable.</p>
        )}
        {post.active ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={closingPostId === post.id}
            loading={closingPostId === post.id}
            onClick={() => onClose(post)}
          >
            Close post
          </Button>
        ) : null}
      </div>
    </details>
  );
}

function MarketplaceLogsTable({
  logs,
  posts,
}: {
  logs: MarketplaceBusinessLog[];
  posts: MarketplacePost[];
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "sent" | "failed">("all");
  const filteredLogs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...logs]
      .filter((log) => status === "all" || (status === "sent" ? log.dmSent : !log.dmSent))
      .filter(
        (log) =>
          !normalized ||
          [log.buyerDisplayName, log.buyerId, log.sellerId, log.postId]
            .join(" ")
            .toLowerCase()
            .includes(normalized),
      )
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [logs, query, status]);
  const postIds = new Set(posts.map((post) => post.id));
  const columns: ResponsiveTableColumn<MarketplaceBusinessLog>[] = [
    {
      header: "When",
      cell: (log) => (
        <span>
          {formatDate(log.timestampMs)}
          <span className="block text-xs text-muted-foreground">
            {formatAge(log.timestampMs)} ago
          </span>
        </span>
      ),
    },
    {
      header: "Buyer / Seller",
      cell: (log) => (
        <span>
          {log.buyerDisplayName}
          <span className="block text-xs text-muted-foreground">Seller ID: {log.sellerId}</span>
        </span>
      ),
    },
    {
      header: "Post",
      cell: (log) => (
        <span className="font-mono text-xs">
          {log.postId}
          {postIds.has(log.postId) ? (
            <a className="ml-2 text-primary underline" href={`#marketplace-post-${log.postId}`}>
              View post details
            </a>
          ) : null}
        </span>
      ),
      className: "font-mono text-xs",
    },
    {
      header: "Delivery",
      cell: (log) => (
        <span>
          <Badge variant={log.dmSent ? "success" : "danger"}>
            {log.dmSent ? "Sent" : "Failed"}
          </Badge>
          {!log.dmSent && log.dmError ? (
            <span className="mt-1 block max-w-[260px] text-xs text-destructive">{log.dmError}</span>
          ) : null}
        </span>
      ),
    },
    {
      header: "Details",
      cell: (log) => (
        <details>
          <summary className="cursor-pointer text-primary">View log</summary>
          <div className="mt-2 space-y-1 text-sm">
            <p>
              <strong>Buyer ID:</strong> {log.buyerId}{" "}
              <CopyIdButton value={log.buyerId} label="Copy buyer ID" />
            </p>
            <p>
              <strong>Seller ID:</strong> {log.sellerId}{" "}
              <CopyIdButton value={log.sellerId} label="Copy seller ID" />
            </p>
            <p>
              {log.tradeType} · {log.serverLabel} · {log.have} → {log.want}
            </p>
            {log.channelId && log.messageId ? (
              <a
                className="text-primary underline"
                href={discordMessageUrl(log.guildId, log.channelId, log.messageId)}
                target="_blank"
                rel="noreferrer"
              >
                Open in Discord
              </a>
            ) : null}
          </div>
        </details>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <Input
          aria-label="Search marketplace logs"
          placeholder="Search buyer, seller, or Post ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter marketplace logs"
          className="admin-input h-9 rounded-md border bg-background px-3 text-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="all">All deliveries</option>
          <option value="sent">Sent only</option>
          <option value="failed">Failed only</option>
        </select>
      </div>
      {logs.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No Marketplace contact logs yet.
        </p>
      ) : filteredLogs.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No contact logs match these filters.
        </p>
      ) : (
        <ResponsiveTable rows={filteredLogs} rowKey={(log) => log.id} columns={columns} />
      )}
    </div>
  );
}

function CopyIdButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => void copyTextToClipboard(value).catch(() => undefined)}
    >
      {label}
    </Button>
  );
}

function formatDate(timestampMs: number) {
  return new Date(timestampMs).toLocaleString();
}

export function formatAge(timestampMs: number, nowMs = Date.now()) {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function discordMessageUrl(guildId: string, channelId: string, messageId: string) {
  return `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`;
}
