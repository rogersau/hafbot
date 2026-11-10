import { useRef, useState } from "react";

import {
  AUDIT_EVENT_GROUP_LABELS,
  AUDIT_EVENT_GROUP_MEMBERS,
  AUDIT_EVENT_LABELS,
  type AuditEventGroupId,
  type AuditEventId,
  type AuditEventStates,
} from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { AdminBottomActionBar } from "./admin-bottom-action-bar";
import { ChannelSelect, MultiChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData, requireAdminRouteRefresh } from "../lib/mutation-reconciliation";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { GuildAuditLogLoaderData } from "../lib/admin-route-loaders";
import { ConfigurationHistoryCard } from "./configuration-history-card";
import type { GuildEntitlementTier } from "../../types";
import { Button } from "./ui/button";

const AUDIT_LOG_GROUPS: AuditEventGroupId[] = [
  "member",
  "message",
  "guild-structure",
  "reaction-rule",
  "timed-role",
  "ticket",
  "lfg",
  "clan-management",
  "marketplace",
  "evidence-vault",
  "platform-link",
  "image-rule",
  "member-verification",
];

export function AdminAuditLogPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
  tier,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: GuildAuditLogLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
  tier?: GuildEntitlementTier | null;
}) {
  const trimmedGuildId = selectedGuildId.trim();
  const [editorGeneration, setEditorGeneration] = useState(0);
  const editorHasUnsavedChanges = useRef(false);

  return (
    <section className="admin-feature-page admin-page-data space-y-6">
      <AdminPageHeader
        title="Guild Audit Log"
        description="Configure the default Audit Destination and event groups for this guild. Each event group can optionally post to its own channel."
        readinessFeature="guild-audit-log"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Guild Audit Log" />
      ) : (
        <>
          <AuditLogEditor
            key={editorGeneration}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={trimmedGuildId}
            initialData={initialData}
            onRouteDataRefresh={onRouteDataRefresh}
            onUnsavedChangesChange={(hasChanges) => {
              editorHasUnsavedChanges.current = hasChanges;
            }}
          />
          <ConfigurationHistoryCard
            guildId={trimmedGuildId}
            workspaceId={selectedWorkspaceId}
            feature="guild-audit-log"
            enabled={tier !== null && tier !== undefined && tier !== "free"}
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

function AuditLogEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
  onUnsavedChangesChange,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: GuildAuditLogLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
  onUnsavedChangesChange?: (hasChanges: boolean) => void;
}) {
  const config = initialData?.config;
  const [auditChannelId, setAuditChannelId] = useState(config?.auditChannelId ?? "");
  const [groupChannelIds, setGroupChannelIds] = useState<Record<string, string>>(
    () => config?.groupChannelIds ?? {},
  );
  const [groupStates, setGroupStates] = useState<Record<string, boolean>>(
    () => config?.eventStates?.groups ?? {},
  );
  const [eventOverrides, setEventOverrides] = useState<Record<string, boolean>>(
    () => config?.eventStates?.overrides ?? {},
  );
  const [excludedChannelIds, setExcludedChannelIds] = useState<string[]>(
    () => config?.excludedChannelIds ?? [],
  );
  const [excludedRoleIds, setExcludedRoleIds] = useState<string[]>(
    () => config?.excludedRoleIds ?? [],
  );
  const [groupOpen, setGroupOpen] = useState<Partial<Record<AuditEventGroupId, boolean>>>({});
  const [eventSearch, setEventSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const canWrite = initialData?.canWrite ?? false;
  function isEventEnabled(eventId: AuditEventId): boolean {
    if (eventId in eventOverrides) return eventOverrides[eventId];
    const group = AUDIT_LOG_GROUPS.find((g) => AUDIT_EVENT_GROUP_MEMBERS[g].includes(eventId));
    if (group && group in groupStates) return groupStates[group];
    return true;
  }

  function toggleGroup(groupId: AuditEventGroupId) {
    setGroupStates((prev) => {
      const current = prev[groupId] ?? true;
      const next = !current;
      return { ...prev, [groupId]: next };
    });
  }

  function toggleEvent(eventId: AuditEventId) {
    setEventOverrides((prev) => {
      const current = prev[eventId] ?? isEventEnabled(eventId);
      return { ...prev, [eventId]: !current };
    });
  }

  function clearEventOverride(eventId: AuditEventId) {
    setEventOverrides((prev) => {
      if (!(eventId in prev)) return prev;
      const next = { ...prev };
      delete next[eventId];
      return next;
    });
  }

  async function resetGroupOverrides(groupId: AuditEventGroupId) {
    const events = AUDIT_EVENT_GROUP_MEMBERS[groupId];
    const overrideCount = events.filter((eventId) => eventId in eventOverrides).length;
    if (overrideCount === 0) return;
    const confirmed = await confirm({
      title: `Reset ${AUDIT_EVENT_GROUP_LABELS[groupId]} event overrides?`,
      description: `This removes ${overrideCount} explicit event override${overrideCount === 1 ? "" : "s"} and returns those events to the group setting.`,
      confirmLabel: "Reset overrides",
      variant: "destructive",
    });
    if (!confirmed) return;
    setEventOverrides((prev) => {
      const next = { ...prev };
      for (const eventId of events) delete next[eventId];
      return next;
    });
  }

  function setGroupChannelId(groupId: AuditEventGroupId, channelId: string) {
    setGroupChannelIds((prev) => {
      const next = { ...prev };
      if (channelId) {
        next[groupId] = channelId;
      } else {
        delete next[groupId];
      }
      return next;
    });
  }

  function hasChanges(): boolean {
    const saved = config;
    if (!saved) {
      return (
        auditChannelId !== "" ||
        Object.keys(groupChannelIds).length > 0 ||
        Object.keys(groupStates).length > 0 ||
        Object.keys(eventOverrides).length > 0 ||
        excludedChannelIds.length > 0 ||
        excludedRoleIds.length > 0
      );
    }
    return (
      auditChannelId !== saved.auditChannelId ||
      JSON.stringify(groupChannelIds) !== JSON.stringify(saved.groupChannelIds ?? {}) ||
      JSON.stringify(groupStates) !== JSON.stringify(saved.eventStates.groups) ||
      JSON.stringify(eventOverrides) !== JSON.stringify(saved.eventStates.overrides) ||
      JSON.stringify(excludedChannelIds) !== JSON.stringify(saved.excludedChannelIds ?? []) ||
      JSON.stringify(excludedRoleIds) !== JSON.stringify(saved.excludedRoleIds ?? [])
    );
  }

  function discardChanges() {
    setAuditChannelId(config?.auditChannelId ?? "");
    setGroupChannelIds(config?.groupChannelIds ?? {});
    setGroupStates(config?.eventStates?.groups ?? {});
    setEventOverrides(config?.eventStates?.overrides ?? {});
    setExcludedChannelIds(config?.excludedChannelIds ?? []);
    setExcludedRoleIds(config?.excludedRoleIds ?? []);
    setSaved(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Guild Audit Log changes?",
      description: "This restores the last saved Guild Audit Log settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    setSaved(false);
    api.setError(null);
    setSaving(true);

    const eventStates: AuditEventStates = { groups: groupStates, overrides: eventOverrides };

    setSaving(true);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/guild-audit-log/config",
        {
          auditChannelId: auditChannelId.trim(),
          groupChannelIds,
          eventStates,
          excludedChannelIds,
          excludedRoleIds,
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      await refreshAdminRouteData(onRouteDataRefresh);
      toast.success("Saved Guild Audit Log configuration.");
      setSaved(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Guild Audit Log.");
    } finally {
      setSaving(false);
    }
  }

  const hasUnsavedChanges = hasChanges();
  onUnsavedChangesChange?.(hasUnsavedChanges);
  const savedSuccessfully = !hasUnsavedChanges && saved;
  const normalizedSearch = eventSearch.trim().toLocaleLowerCase();

  function isGroupUnsaved(groupId: AuditEventGroupId) {
    const savedGroupChannels = config?.groupChannelIds ?? {};
    const savedGroups = config?.eventStates?.groups ?? {};
    const savedOverrides = config?.eventStates?.overrides ?? {};
    const currentChannel = groupChannelIds[groupId] ?? "";
    const savedChannel = savedGroupChannels[groupId] ?? "";
    if (currentChannel !== savedChannel) return true;
    if ((groupStates[groupId] ?? true) !== (savedGroups[groupId] ?? true)) return true;
    return AUDIT_EVENT_GROUP_MEMBERS[groupId].some(
      (eventId) => (eventOverrides[eventId] ?? null) !== (savedOverrides[eventId] ?? null),
    );
  }

  function hasGroupValidationError(groupId: AuditEventGroupId) {
    const channelId = groupChannelIds[groupId];
    return Boolean(
      channelId && resources && !resources.textChannels.some((channel) => channel.id === channelId),
    );
  }

  return (
    <div className="space-y-4">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <SettingsBlock>
        <SectionHeader
          title="Guild Audit Log configuration"
          description="Choose the channel used for audit events that do not have their own feature-specific log channel."
        />
        <FormField
          label="Default audit channel"
          htmlFor="audit-destination"
          hint="Leave empty to disable the shared audit destination. Feature-specific log channels can still receive their own events."
        >
          <ChannelSelect
            allowClear
            id="audit-destination"
            channels={resources?.textChannels ?? []}
            value={auditChannelId}
            onChange={setAuditChannelId}
            disabled={!canWrite}
            placeholder="Select a channel..."
            creation={{
              guildId: selectedGuildId,
              workspaceId: selectedWorkspaceId,
              surfaceKey: "guild_audit_log",
              dependencyKey: "audit_channel",
              label: "audit channel",
              recommendedName: "guild-audit-log",
            }}
          />
        </FormField>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Audit Exclusion Policy"
          description="Suppress eligible Discord Audit Events from these channels or members holding any of these roles. HAF Audit Events and protected lifecycle events remain visible."
        />
        <div className="space-y-4">
          <FormField
            label="Excluded channels"
            htmlFor="audit-excluded-channels"
            hint="Message and invite events in selected text or Forum channels are suppressed. Threads and Forum posts inherit their parent channel."
          >
            <MultiChannelSelect
              id="audit-excluded-channels"
              channels={[
                ...(resources?.textChannels ?? []),
                ...(resources?.forumChannels ?? []),
                ...(resources?.voiceChannels ?? []),
                ...(resources?.stageChannels ?? []),
              ]}
              value={excludedChannelIds}
              onChange={setExcludedChannelIds}
              disabled={!canWrite}
            />
          </FormField>
          <FormField
            label="Excluded roles"
            htmlFor="audit-excluded-roles"
            hint="Attributable message, nickname, and role-change events are suppressed when the member currently holds any selected role."
          >
            <MultiRoleSelect
              id="audit-excluded-roles"
              roles={resources?.roles ?? []}
              value={excludedRoleIds}
              onChange={setExcludedRoleIds}
              disabled={!canWrite}
            />
          </FormField>
        </div>
      </SettingsBlock>

      <SectionHeader
        title="Audit events"
        description="Choose which categories and individual events should be posted to the audit channel."
      />

      <FormField
        label="Search audit events"
        htmlFor="audit-event-search"
        hint="Search event names and group names. Matching groups open automatically."
      >
        <input
          id="audit-event-search"
          type="search"
          value={eventSearch}
          onChange={(event) => setEventSearch(event.target.value)}
          placeholder="Search event or group name"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
      </FormField>

      {AUDIT_LOG_GROUPS.map((groupId) => {
        const groupEnabled = groupStates[groupId] ?? true;
        const events = AUDIT_EVENT_GROUP_MEMBERS[groupId];
        const groupLabel = AUDIT_EVENT_GROUP_LABELS[groupId];
        const groupMatches =
          normalizedSearch.length > 0 && groupLabel.toLocaleLowerCase().includes(normalizedSearch);
        const matchingEvents = normalizedSearch
          ? events.filter((eventId) =>
              AUDIT_EVENT_LABELS[eventId].toLocaleLowerCase().includes(normalizedSearch),
            )
          : events;
        const matchesSearch = !normalizedSearch || groupMatches || matchingEvents.length > 0;
        const groupUnsaved = isGroupUnsaved(groupId);
        const groupValidationError = hasGroupValidationError(groupId);
        const forceOpen =
          groupUnsaved ||
          groupValidationError ||
          (normalizedSearch.length > 0 && (groupMatches || matchingEvents.length > 0));
        if (normalizedSearch && !matchesSearch && !groupUnsaved && !groupValidationError)
          return null;
        const open = forceOpen || groupOpen[groupId] === true;
        const enabledCount = events.filter((eventId) => isEventEnabled(eventId)).length;
        const overrideCount = events.filter((eventId) => eventId in eventOverrides).length;
        const dedicatedChannelId = groupChannelIds[groupId] ?? "";
        const dedicatedChannelName = resources?.textChannels.find(
          (channel) => channel.id === dedicatedChannelId,
        )?.name;
        const destination = dedicatedChannelId
          ? `#${dedicatedChannelName ?? "dedicated-channel"}`
          : "Default destination";
        const visibleEvents = normalizedSearch && !groupMatches ? matchingEvents : events;

        return (
          <SettingsBlock
            key={groupId}
            className={groupValidationError ? "border-destructive/60" : undefined}
          >
            <details
              open={open}
              onToggle={(event) => {
                if (forceOpen) return;
                const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                setGroupOpen((previous) => ({ ...previous, [groupId]: nextOpen }));
              }}
              className="group/audit-disclosure"
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-3 marker:hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <span className="min-w-0 space-y-1">
                  <span className="block font-display text-base font-semibold tracking-tight text-foreground">
                    {groupLabel}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {groupEnabled ? "Enabled" : "Disabled"} · {enabledCount} of {events.length}{" "}
                    events enabled · {destination} · {overrideCount} explicit override
                    {overrideCount === 1 ? "" : "s"}
                  </span>
                  {groupUnsaved ? (
                    <span className="block text-xs font-medium text-accent">Unsaved changes</span>
                  ) : null}
                  {groupValidationError ? (
                    <span className="block text-xs font-medium text-destructive">
                      Dedicated channel is unavailable.
                    </span>
                  ) : null}
                </span>
                <span
                  className="shrink-0 pt-1 text-xs font-medium text-muted-foreground"
                  aria-hidden="true"
                >
                  {open ? "Hide" : "Show"}
                </span>
              </summary>
              <div className="mt-4 space-y-4">
                <FormField
                  label="Channel"
                  htmlFor={`audit-channel-${groupId}`}
                  hint="Leave empty to use the default audit channel."
                >
                  <ChannelSelect
                    allowClear
                    id={`audit-channel-${groupId}`}
                    channels={resources?.textChannels ?? []}
                    value={groupChannelIds[groupId] ?? ""}
                    onChange={(value) => setGroupChannelId(groupId, value)}
                    disabled={!canWrite}
                    placeholder="Use default audit channel"
                    creation={{
                      guildId: selectedGuildId,
                      workspaceId: selectedWorkspaceId,
                      surfaceKey: "guild_audit_log",
                      dependencyKey: "audit_channel",
                      label: `${AUDIT_EVENT_GROUP_LABELS[groupId]} channel`,
                      recommendedName: `audit-${groupId}`,
                    }}
                  />
                </FormField>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={groupEnabled}
                    onChange={() => toggleGroup(groupId)}
                    disabled={!canWrite}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Enable all {AUDIT_EVENT_GROUP_LABELS[groupId]}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canWrite || overrideCount === 0}
                    onClick={() => void resetGroupOverrides(groupId)}
                  >
                    Reset event overrides{overrideCount > 0 ? ` (${overrideCount})` : ""}
                  </Button>
                  {normalizedSearch && !matchesSearch ? (
                    <span className="text-xs text-muted-foreground">
                      No matching events; showing this changed group.
                    </span>
                  ) : null}
                </div>
                <div
                  className="ml-1 space-y-2"
                  role="group"
                  aria-label={`${groupLabel} individual events`}
                >
                  {visibleEvents.map((eventId) => {
                    const hasOverride = eventId in eventOverrides;
                    const eventEnabled = isEventEnabled(eventId);

                    return (
                      <div
                        key={eventId}
                        className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm ${hasOverride ? "border-accent/50 bg-accent/5" : "border-border/60"}`}
                      >
                        <label className="flex min-w-0 flex-1 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={eventEnabled}
                            onChange={() => toggleEvent(eventId)}
                            disabled={!canWrite}
                            className="h-4 w-4 shrink-0 rounded border-gray-300"
                          />
                          <span>{AUDIT_EVENT_LABELS[eventId]}</span>
                        </label>
                        <span
                          className={`text-xs ${hasOverride ? "font-medium text-accent" : "text-muted-foreground"}`}
                        >
                          {hasOverride
                            ? "Explicit override"
                            : `Uses group setting · ${groupEnabled ? "Enabled" : "Disabled"}`}
                        </span>
                        {hasOverride ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={!canWrite}
                            onClick={() => clearEventOverride(eventId)}
                          >
                            Use group setting
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>
          </SettingsBlock>
        );
      })}

      <PageFeedback error={api.error} />
      {canWrite ? (
        <AdminBottomActionBar
          actions={[
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
            {
              label: "Discard changes",
              disabled: !hasUnsavedChanges || saving,
              variant: "outline",
              onClick: () => void handleDiscardChanges(),
            },
          ]}
        />
      ) : null}
    </div>
  );
}
