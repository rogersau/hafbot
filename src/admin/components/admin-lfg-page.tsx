import { ConfigurationActions } from "./configuration-actions";
import { useState } from "react";

import type { LfgConfig, LfgPost } from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { InfoTooltip } from "./ui/info-tooltip";
import { ChannelSelect, RoleSelect } from "./guild-resource-select";
import { ServerOptionsEditor } from "./server-options-editor";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { Button } from "./ui/button";
import { DiscordMessagePreview } from "./discord-message-preview";
import { Checkbox } from "./ui/checkbox";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Input } from "./ui/input";
import { ColorInput, formatHexColor } from "./ui/color-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import { adminRefreshWarning, reconcileAdminMutation } from "../lib/mutation-reconciliation";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { LfgLoaderData } from "../lib/admin-route-loaders";
import { NOTICEBOARD_SAVE_SUCCESS_MESSAGE } from "../lib/noticeboard-copy";

interface LfgResource {
  config: LfgConfig;
  posts: LfgPost[];
}

export function AdminLfgPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: LfgLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="LFG"
        description="Configure looking-for-group noticeboards, server choices, and active post management."
        readinessFeature="lfg"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="LFG" />
      ) : (
        <LfgEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function LfgEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: LfgLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resource, setResource] = useState<LfgResource | null>(initialData ?? null);
  const [savedConfig, setSavedConfig] = useState<LfgConfig | null>(initialData?.config ?? null);
  const [saving, setSaving] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const api = useAdminApi();
  const toast = useToast();

  async function reconcile(action: string) {
    const { refreshError: error } = await reconcileAdminMutation(
      async () => undefined,
      onRouteDataRefresh,
    );
    if (error) {
      setRefreshError(error);
      toast.info(adminRefreshWarning(action, error));
    } else {
      setRefreshError(null);
    }
  }
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
      title: "Discard LFG changes?",
      description: "This restores the last saved LFG settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    if (!resource) return;
    setSaved(false);
    api.setError(null);
    setSaving(true);
    try {
      await createAdminLoaderClient().postJson("/admin/api/lfg/config", resource.config, {
        workspaceId: selectedWorkspaceId,
      });
      setSavedConfig(resource.config);
      toast.success(NOTICEBOARD_SAVE_SUCCESS_MESSAGE);
      setSaved(true);
      await reconcile("LFG configuration save");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save LFG config.");
    } finally {
      setSaving(false);
    }
  }

  async function disableFeature() {
    if (disabling || saving || publishing) return;
    const confirmed = await confirm({
      title: "Disable LFG?",
      description:
        "This stops new posts and removes the noticeboard. Existing posts, channels, roles, and saved settings are kept. Unsaved changes on this page will be discarded.",
      confirmLabel: "Disable LFG",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    setDisabling(true);
    try {
      const result = await createAdminLoaderClient().postJson<{
        config: LfgConfig;
        noticeRemoved: boolean;
      }>(
        "/admin/api/lfg/disable",
        {},
        {
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
        },
      );
      setResource((current) => (current ? { ...current, config: result.config } : current));
      setSavedConfig(result.config);
      setSaved(false);
      toast.success("LFG disabled.");
      if (!result.noticeRemoved) {
        toast.info(
          "The old noticeboard could not be removed. You can delete it in Discord; its create button no longer accepts new posts.",
        );
      }
      await reconcile("LFG disable");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable LFG.");
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
        "/admin/api/lfg/publish",
        {
          channelId: resource.config.noticeChannelId,
        },
        { guildId: resource.config.guildId },
      );
      toast.success("LFG noticeboard published successfully.");
      await reconcile("LFG noticeboard publish");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to publish LFG noticeboard.");
    } finally {
      setPublishing(false);
    }
  }

  async function closePost(post: LfgPost) {
    const confirmed = await confirm({
      title: "Close LFG post?",
      description:
        "This closes the selected post in the noticeboard. The owner can repost if they still need a group.",
      confirmLabel: "Close post",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/lfg/post/close",
        {
          postId: post.id,
          closedByUserId: "admin-dashboard",
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      toast.success(`Closed LFG post ${post.id}.`);
      await reconcile("LFG post close");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close LFG post.");
    }
  }

  if (!resource) {
    return (
      <p className="text-sm text-muted-foreground">
        {api.loading ? "Loading LFG…" : "LFG not loaded."}
      </p>
    );
  }

  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(resource.config, savedConfig);

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      <AdminRefreshNotice action="LFG" error={refreshError} refresh={onRouteDataRefresh} />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <SettingsBlock>
        <SectionHeader
          title="LFG configuration"
          description="Set up the noticeboard channel, roles, and server options."
          actions={
            <ConfigurationActions
              label="LFG"
              enabled={Boolean(savedConfig?.noticeChannelId) && savedConfig?.enabled !== false}
              actions={[
                {
                  label:
                    savedConfig?.noticeChannelId && savedConfig.enabled !== false
                      ? "Disable LFG"
                      : "Enable LFG",
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
            LFG is disabled. Use More actions to enable it again.
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="Noticeboard channel"
            htmlFor="lfg-notice-channel"
            hint="Channel where the public LFG panel is posted. Members use this panel to create LFG posts."
          >
            <ChannelSelect
              allowClear
              id="lfg-notice-channel"
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
                surfaceKey: "lfg",
                dependencyKey: "notice_channel",
                label: "noticeboard channel",
                recommendedName: "looking-for-group",
              }}
            />
          </FormField>
          <FormField
            label="Notification role"
            htmlFor="lfg-notification-role"
            hint="Optional role the bot can mention when a new LFG post is created."
          >
            <RoleSelect
              allowClear
              id="lfg-notification-role"
              roles={resources?.roles ?? []}
              value={resource.config.notificationRoleId ?? ""}
              onChange={(value) =>
                setResource({
                  ...resource,
                  config: {
                    ...resource.config,
                    notificationRoleId: value || null,
                  },
                })
              }
              placeholder="Optional LFG alerts role"
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "lfg",
                dependencyKey: "notification_role",
                label: "notification role",
                recommendedName: "LFG Notifications",
              }}
            />
          </FormField>
          <FormField
            label="Noticeboard embed colour"
            htmlFor="lfg-notice-color"
            hint="Side colour used by the published LFG Noticeboard embed."
          >
            <ColorInput
              id="lfg-notice-color"
              value={resource.config.noticeColor ?? 0x2b2d31}
              onChange={(noticeColor) =>
                setResource({
                  ...resource,
                  config: { ...resource.config, noticeColor },
                })
              }
            />
          </FormField>
        </div>
        <details
          className="group rounded-md border p-4"
          open={Boolean(
            resource.config.counterVoiceChannelId ||
            resource.config.approvalFlowEnabled ||
            resource.config.approvalAuditChannelId ||
            resource.config.approvalVoiceCategoryId ||
            resource.config.expiryDurationHours !== 24 ||
            resource.config.expiryAction !== "close",
          )}
        >
          <summary className="cursor-pointer list-none font-medium">
            Advanced automation
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {resource.config.approvalFlowEnabled
                ? "Approval required · private rooms enabled"
                : "Counters, approvals, expiry and audit"}
            </span>
          </summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <FormField
              label="Counter voice channel"
              htmlFor="lfg-counter-voice-channel"
              hint="Optional voice channel whose name shows the current number of active LFG posts."
            >
              <ChannelSelect
                allowClear
                id="lfg-counter-voice-channel"
                channels={resources?.voiceChannels ?? []}
                value={resource.config.counterVoiceChannelId ?? ""}
                onChange={(value) =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      counterVoiceChannelId: value || null,
                    },
                  })
                }
                placeholder="Optional LFG counter channel"
                creation={{
                  guildId: selectedGuildId,
                  workspaceId: selectedWorkspaceId,
                  surfaceKey: "lfg",
                  dependencyKey: "counter_voice_channel",
                  label: "counter voice channel",
                  recommendedName: "LFG (0)",
                }}
              />
            </FormField>
            {resource.config.counterVoiceChannelId ? (
              <FormField
                label="Counter display format"
                htmlFor="lfg-counter-display-format"
                hint="Name format for the counter voice channel. Use {count} where the active post count should appear."
              >
                <Input
                  id="lfg-counter-display-format"
                  value={resource.config.counterDisplayFormat}
                  onChange={(event) =>
                    setResource({
                      ...resource,
                      config: {
                        ...resource.config,
                        counterDisplayFormat: event.target.value,
                      },
                    })
                  }
                  placeholder="LFG ({count})"
                />
              </FormField>
            ) : null}
            <FormField
              label="Approval flow"
              htmlFor="lfg-approval-flow-enabled"
              hint="Require the LFG post owner to approve someone before a private voice room is shared."
            >
              <label className="flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                <Checkbox
                  id="lfg-approval-flow-enabled"
                  checked={resource.config.approvalFlowEnabled}
                  onCheckedChange={(checked) =>
                    setResource({
                      ...resource,
                      config: {
                        ...resource.config,
                        approvalFlowEnabled: checked === true,
                      },
                    })
                  }
                />
                Require poster approval before sharing a private voice room
              </label>
            </FormField>
            {resource.config.approvalFlowEnabled ? (
              <FormField
                label="LFG audit channel"
                htmlFor="lfg-approval-audit-channel"
                hint="Optional channel where LFG approvals and private room actions are logged."
              >
                <ChannelSelect
                  allowClear
                  id="lfg-approval-audit-channel"
                  channels={resources?.textChannels ?? []}
                  value={resource.config.approvalAuditChannelId ?? ""}
                  onChange={(value) =>
                    setResource({
                      ...resource,
                      config: {
                        ...resource.config,
                        approvalAuditChannelId: value || null,
                      },
                    })
                  }
                  placeholder="Optional LFG audit channel"
                  creation={{
                    guildId: selectedGuildId,
                    workspaceId: selectedWorkspaceId,
                    surfaceKey: "lfg",
                    dependencyKey: "approval_audit_channel",
                    label: "audit channel",
                    recommendedName: "lfg-approvals",
                  }}
                />
              </FormField>
            ) : null}
            {resource.config.approvalFlowEnabled ? (
              <FormField
                label="Private voice category"
                htmlFor="lfg-approval-voice-category"
                hint="Category where the bot creates temporary private voice rooms."
              >
                <ChannelSelect
                  id="lfg-approval-voice-category"
                  channels={resources?.categories ?? []}
                  value={resource.config.approvalVoiceCategoryId ?? ""}
                  onChange={(value) =>
                    setResource({
                      ...resource,
                      config: {
                        ...resource.config,
                        approvalVoiceCategoryId: value || null,
                      },
                    })
                  }
                  placeholder="Category for private rooms"
                  creation={{
                    guildId: selectedGuildId,
                    workspaceId: selectedWorkspaceId,
                    surfaceKey: "lfg",
                    dependencyKey: "approval_voice_category",
                    label: "voice category",
                    recommendedName: "LFG Voice",
                  }}
                />
              </FormField>
            ) : null}
            <FormField
              label="Post expiry time"
              htmlFor="lfg-expiry-duration-hours"
              hint="How many hours an LFG post stays active before the expiry action runs. Minimum 1, maximum 168."
            >
              <Input
                id="lfg-expiry-duration-hours"
                type="number"
                min={1}
                max={168}
                value={resource.config.expiryDurationHours}
                onChange={(event) =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      expiryDurationHours: Math.max(
                        1,
                        Math.min(168, Number.parseInt(event.target.value || "24", 10) || 24),
                      ),
                    },
                  })
                }
              />
            </FormField>
            <FormField
              label={
                <span className="inline-flex items-center gap-1.5">
                  Expiry action
                  <InfoTooltip
                    content="Decides what happens to an LFG post when it expires. Members see the action before it takes effect."
                    learnMoreHref="https://docs.hafbot.xyz/features/lfg"
                  />
                </span>
              }
              htmlFor="lfg-expiry-action"
            >
              <Select
                value={resource.config.expiryAction}
                onValueChange={(value: "close" | "delete" | "nothing") =>
                  setResource({
                    ...resource,
                    config: {
                      ...resource.config,
                      expiryAction: value,
                    },
                  })
                }
              >
                <SelectTrigger id="lfg-expiry-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="close">Close in place</SelectItem>
                  <SelectItem value="delete">Delete message</SelectItem>
                  <SelectItem value="nothing">Leave alone</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <p className="text-xs text-muted-foreground">Counter placeholder: {"{count}"}.</p>
        </details>
        <details className="rounded-md border p-3" open>
          <summary className="cursor-pointer font-medium">
            Server choices ({resource.config.serverOptions.length})
          </summary>
          <div className="mt-3">
            <ServerOptionsEditor
              options={resource.config.serverOptions}
              emojis={resources?.emojis ?? []}
              onChange={(serverOptions) =>
                setResource({ ...resource, config: { ...resource.config, serverOptions } })
              }
            />
          </div>
        </details>
      </SettingsBlock>

      <LfgNoticeboardPreview
        notificationRoleId={resource.config.notificationRoleId}
        noticeColor={resource.config.noticeColor ?? 0x2b2d31}
      />

      <SettingsBlock>
        <SectionHeader
          title="Active posts"
          description="Review current LFG posts and close stale requests."
        />
        <LfgPostsTable posts={resource.posts} onClose={closePost} />
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
            label: "Save LFG config",
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

function LfgNoticeboardPreview({
  notificationRoleId,
  noticeColor,
}: {
  notificationRoleId: string | null;
  noticeColor: number;
}) {
  return (
    <SettingsBlock>
      <SectionHeader title="Noticeboard preview" />
      <DiscordMessagePreview
        embedTitle="🎮 Looking For Gamers"
        embedDescription="Looking for someone to play with? Click the button below and fill out a quick post."
        embedColor={formatHexColor(noticeColor)}
        buttons={[
          { label: "Create LFG Post", emoji: "🎮", variant: "primary" },
          ...(notificationRoleId
            ? [{ label: "Join / Leave LFG Alerts", emoji: "🔔", variant: "secondary" as const }]
            : []),
        ]}
      />
    </SettingsBlock>
  );
}

function LfgPostsTable({ posts, onClose }: { posts: LfgPost[]; onClose: (post: LfgPost) => void }) {
  const columns: ResponsiveTableColumn<LfgPost>[] = [
    {
      header: "Post",
      cell: (post) => <span className="font-mono text-xs">{post.id}</span>,
      className: "font-mono text-xs",
    },
    { header: "Owner", cell: (post) => post.ownerDisplayName },
    { header: "Server", cell: (post) => post.serverLabel },
    { header: "When", cell: (post) => post.whenPlay },
    { header: "Status", cell: (post) => (post.active ? "Active" : "Closed") },
    {
      header: "Action",
      cell: (post) => (
        <Button size="sm" variant="outline" disabled={!post.active} onClick={() => onClose(post)}>
          Close
        </Button>
      ),
    },
  ];

  return <ResponsiveTable rows={posts} rowKey={(post) => post.id} columns={columns} />;
}
