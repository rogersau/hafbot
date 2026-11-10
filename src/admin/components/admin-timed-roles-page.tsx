import { ConfigurationAvailabilityActions } from "./configuration-availability-actions";
import { useMemo, useState } from "react";

import type {
  ManualAssignmentTimedRoleConfig,
  NewMemberTimedRoleConfig,
  TimedRoleAutomationRule,
  TimedRoleAssignment,
} from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import {
  EditorActions,
  FormField,
  SectionHeader,
  SettingsBlock,
  SettingsPanel,
} from "./admin-form-layout";
import { ChannelSelect, MultiRoleSelect, RoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { TimedRolesLoaderData } from "../lib/admin-route-loaders";
import { DiscordMessagePreview } from "./discord-message-preview";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { parseTimedRoleDuration } from "../../timed-roles";
import {
  DISCORD_USER_ID_HINT,
  discordUserIdError,
  parseDiscordUserId,
} from "../lib/discord-user-id";

export function AdminTimedRolesPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: TimedRolesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();
  return (
    <section className="admin-feature-page admin-page-settings space-y-6">
      <AdminPageHeader
        title="Timed Roles"
        description="Assign roles for a fixed duration and manage active timed assignments."
        readinessFeature="timed-roles"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="timed roles" />
      ) : (
        <TimedRolesEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={selectedGuildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function TimedRolesEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: TimedRolesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [suspendedRoleIds, setSuspendedRoleIds] = useState<string[]>([]);
  const [duration, setDuration] = useState("1h");
  const [assignments, setAssignments] = useState<TimedRoleAssignment[] | null>(
    initialData?.assignments ?? null,
  );
  const [notificationChannelId, setNotificationChannelId] = useState(
    initialData?.notificationChannelId ?? "",
  );
  const [newMemberRules, setNewMemberRules] = useState<TimedRoleAutomationRule[]>(
    initialData?.newMemberRoleConfig?.roles ?? [],
  );
  const [manualAssignmentRules, setManualAssignmentRules] = useState<TimedRoleAutomationRule[]>(
    initialData?.manualAssignmentRoleConfig?.roles ?? [],
  );
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [savedAction, setSavedAction] = useState<string | null>(null);
  const [manualAssignmentSaveAttempted, setManualAssignmentSaveAttempted] = useState(false);
  const [newMemberSaveAttempted, setNewMemberSaveAttempted] = useState(false);
  const [savedManualAssignmentRules, setSavedManualAssignmentRules] = useState(
    initialData?.manualAssignmentRoleConfig?.roles ?? [],
  );
  const [savedNewMemberRules, setSavedNewMemberRules] = useState(
    initialData?.newMemberRoleConfig?.roles ?? [],
  );
  const [savedNotificationChannelId, setSavedNotificationChannelId] = useState(
    initialData?.notificationChannelId ?? "",
  );
  const [userIdError, setUserIdError] = useState<string | null>(null);
  const trimmedGuildId = selectedGuildId.trim();
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
    "/admin/api/timed-roles/resources",
  );
  const manualAssignmentValidation = validateTimedRoleRulesDetailed(manualAssignmentRules);
  const newMemberValidation = validateTimedRoleRulesDetailed(newMemberRules);
  const manualAssignmentDirty = !areTimedRoleSnapshotsEqual(
    manualAssignmentRules,
    savedManualAssignmentRules,
  );
  const newMemberDirty = !areTimedRoleSnapshotsEqual(newMemberRules, savedNewMemberRules);
  const notificationChannelDirty = notificationChannelId !== savedNotificationChannelId;
  const hasUnsavedChanges = manualAssignmentDirty || newMemberDirty || notificationChannelDirty;

  async function handleSaveNotificationChannel() {
    setSavedAction(null);
    api.setError(null);
    setSavingAction("notification-channel");

    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/timed-role-channel",
        {
          notificationChannelId: notificationChannelId.trim() || null,
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );

      const channelName =
        resources?.textChannels.find((c) => c.id === notificationChannelId.trim())?.name ??
        notificationChannelId.trim();
      toast.success(
        notificationChannelId.trim()
          ? `Saved moderation log channel${channelName ? ` (#${channelName})` : ""}.`
          : `Cleared moderation log channel.`,
      );
      setSavedNotificationChannelId(notificationChannelId.trim());
      setSavedAction("notification-channel");
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save the moderation log channel.",
      );
    } finally {
      setSavingAction(null);
    }
  }

  async function handleSaveNewMemberConfig(nextRules = newMemberRules) {
    setSavedAction(null);
    api.setError(null);

    const validationError = validateTimedRoleRules(nextRules);
    setNewMemberSaveAttempted(true);
    if (validationError) {
      api.setError(validationError);
      return;
    }

    setSavingAction("new-member");
    try {
      const data = await createAdminLoaderClient().postJson<{
        newMemberRoleConfig?: NewMemberTimedRoleConfig;
      }>(
        "/admin/api/timed-roles/new-member-config",
        {
          roles: normalizeTimedRoleRules(nextRules),
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );

      const savedRules = data.newMemberRoleConfig?.roles ?? [];
      setNewMemberRules(savedRules);
      setSavedNewMemberRules(savedRules);
      setNewMemberSaveAttempted(false);
      toast.success(
        savedRules.length > 0
          ? `Saved ${savedRules.length} new member timed role rule${savedRules.length === 1 ? "" : "s"}.`
          : "New member timed role automation is disabled.",
      );
      setSavedAction("new-member");
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the new member timed role.");
    } finally {
      setSavingAction(null);
    }
  }

  async function handleSaveManualAssignmentConfig(nextRules = manualAssignmentRules) {
    setSavedAction(null);
    api.setError(null);

    const validationError = validateTimedRoleRules(nextRules);
    setManualAssignmentSaveAttempted(true);
    if (validationError) {
      api.setError(validationError);
      return;
    }

    setSavingAction("manual-assignment");
    try {
      const data = await createAdminLoaderClient().postJson<{
        manualAssignmentRoleConfig?: ManualAssignmentTimedRoleConfig;
      }>(
        "/admin/api/timed-roles/manual-assignment-config",
        {
          roles: normalizeTimedRoleRules(nextRules),
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );

      const savedRules = data.manualAssignmentRoleConfig?.roles ?? [];
      setManualAssignmentRules(savedRules);
      setSavedManualAssignmentRules(savedRules);
      setManualAssignmentSaveAttempted(false);
      toast.success(
        savedRules.length > 0
          ? `Saved ${savedRules.length} manual-assignment timed role rule${savedRules.length === 1 ? "" : "s"}.`
          : "Manual-assignment timed role automation is disabled.",
      );
      setSavedAction("manual-assignment");
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save the manual-assignment timed role.",
      );
    } finally {
      setSavingAction(null);
    }
  }

  async function setRulesEnabled(kind: "manual-assignment" | "new-member", enabled: boolean) {
    const rules = kind === "manual-assignment" ? savedManualAssignmentRules : savedNewMemberRules;
    const next = rules.map((rule) => ({ ...rule, enabled }));
    if (kind === "manual-assignment") await handleSaveManualAssignmentConfig(next);
    else await handleSaveNewMemberConfig(next);
  }

  function discardManualAssignmentChanges() {
    setManualAssignmentRules(savedManualAssignmentRules);
    setManualAssignmentSaveAttempted(false);
    api.setError(null);
  }

  function discardNewMemberChanges() {
    setNewMemberRules(savedNewMemberRules);
    setNewMemberSaveAttempted(false);
    api.setError(null);
  }

  function discardNotificationChannelChanges() {
    setNotificationChannelId(savedNotificationChannelId);
    api.setError(null);
  }

  async function handleAdd() {
    api.setError(null);

    const parsedUserId = parseDiscordUserId(userId);
    if (!parsedUserId.ok) {
      setUserIdError(parsedUserId.error);
      return;
    }
    setUserIdError(null);
    const durationError = validateDurationInput(duration);
    if (durationError) {
      api.setError(durationError);
      return;
    }

    const roleName = resources?.roles.find((r) => r.id === roleId)?.name ?? roleId;
    const suspendedRoleNames = suspendedRoleIds.map(
      (selectedRoleId) =>
        resources?.roles.find((role) => role.id === selectedRoleId)?.name ?? selectedRoleId,
    );
    const confirmed = await confirm({
      title: "Assign timed role?",
      description:
        suspendedRoleNames.length > 0
          ? `Assign "${roleName}" and temporarily remove only these selected roles: ${suspendedRoleNames.join(", ")}. They will be restored when the timed role ends.`
          : `Assign "${roleName}" without suspending any existing member roles.`,
      confirmLabel: "Assign role",
    });
    if (!confirmed) return;

    try {
      const data = await createAdminLoaderClient().postJson<{
        assignments?: TimedRoleAssignment[];
      }>(
        "/admin/api/timed-roles",
        {
          action: "add",
          userId: parsedUserId.id,
          roleId,
          duration,
          suspendedRoleIds,
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );

      setAssignments(data.assignments ?? []);
      toast.success(`Assigned ${roleName} to ${parsedUserId.id} for ${duration.trim()}.`);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add the timed role.");
    }
  }

  async function handleRemove(assignment: TimedRoleAssignment) {
    const roleName =
      resources?.roles.find((r) => r.id === assignment.roleId)?.name ?? assignment.roleId;
    const confirmed = await confirm({
      title: "Remove timed role?",
      description: `This removes the "${roleName}" role from ${assignment.userId} ahead of its scheduled expiry and restores the roles recorded when it was assigned.`,
      confirmLabel: "Remove role",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);

    try {
      const data = await createAdminLoaderClient().postJson<{
        assignments?: TimedRoleAssignment[];
      }>(
        "/admin/api/timed-roles",
        {
          action: "remove",
          userId: assignment.userId,
          roleId: assignment.roleId,
        },
        { workspaceId: selectedWorkspaceId, guildId: assignment.guildId },
      );

      setAssignments(data.assignments ?? []);
      toast.success(`Removed ${roleName} from ${assignment.userId}.`);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove the timed role.");
    }
  }

  return (
    <SettingsPanel>
      <NavigationGuard
        hasChanges={hasUnsavedChanges}
        onDiscardChanges={() => {
          discardManualAssignmentChanges();
          discardNewMemberChanges();
          discardNotificationChannelChanges();
        }}
      />
      {confirmDialog}
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-sm font-medium">Timed Roles configuration</span>
        <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
        {manualAssignmentDirty ? (
          <span className="text-xs text-amber-200">Manual rules changed</span>
        ) : null}
        {newMemberDirty ? (
          <span className="text-xs text-amber-200">New-member rules changed</span>
        ) : null}
        {notificationChannelDirty ? (
          <span className="text-xs text-amber-200">Log channel changed</span>
        ) : null}
      </div>
      <SettingsBlock>
        <SectionHeader
          title="Manual assignment"
          description="Grant one member a temporary role with an explicit expiry window."
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(8rem,0.8fr)]">
          <FormField
            label="Discord user ID"
            htmlFor="tr-user"
            required
            hint={DISCORD_USER_ID_HINT}
            error={userIdError ?? undefined}
          >
            <Input
              id="tr-user"
              value={userId}
              placeholder="123456789012345678 or <@123456789012345678>"
              onChange={(event) => {
                setUserId(event.target.value);
                setUserIdError(discordUserIdError(event.target.value));
              }}
            />
          </FormField>
          <FormField
            label="Role to assign"
            htmlFor="tr-role"
            required
            hint="The Discord role the bot will add temporarily."
          >
            <RoleSelect
              id="tr-role"
              roles={resources?.roles ?? []}
              value={roleId}
              onChange={(value) => {
                setRoleId(value);
                setSuspendedRoleIds((current) => current.filter((id) => id !== value));
              }}
            />
          </FormField>
          <DurationBuilder
            id="tr-duration"
            value={duration}
            onChange={setDuration}
            error={validateDurationInput(duration) ?? undefined}
          />
          <FormField
            label="Roles to suspend while active"
            htmlFor="tr-suspended-roles"
            hint="Optional. Only the roles selected here are removed; HAF does not infer roles from hierarchy. Access may change until the timed role ends."
          >
            <MultiRoleSelect
              id="tr-suspended-roles"
              roles={(resources?.roles ?? []).filter((role) => role.id !== roleId)}
              value={suspendedRoleIds}
              onChange={setSuspendedRoleIds}
            />
          </FormField>
        </div>
        <ManualAssignmentPreview duration={duration} userId={userId} />
        <EditorActions>
          <Button
            size="sm"
            className="w-full sm:w-auto sm:min-w-[12rem]"
            disabled={
              !trimmedGuildId ||
              Boolean(discordUserIdError(userId)) ||
              !roleId.trim() ||
              Boolean(validateDurationInput(duration))
            }
            onClick={() => void handleAdd()}
          >
            Add timed role
          </Button>
        </EditorActions>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Manual assignment temporary role"
          actions={
            manualAssignmentRules.length ? (
              <ConfigurationAvailabilityActions
                label="manual role rules"
                enabled={manualAssignmentRules.some((rule) => rule.enabled !== false)}
                disabled={manualAssignmentDirty || savingAction !== null}
                description="New assignments from these rules will stop. Rule settings and DM messages are kept; existing timed roles still expire normally."
                onEnabledChange={(enabled) => setRulesEnabled("manual-assignment", enabled)}
              />
            ) : undefined
          }
          description="Watch for staff-applied roles in Discord and expire them automatically."
        />
        <TimedRoleRuleRows
          idPrefix="tr-manual-assignment"
          rules={manualAssignmentRules}
          roles={resources?.roles ?? []}
          defaultDuration="1h"
          emptyText="No manual-assignment watched roles configured."
          saveAttempted={manualAssignmentSaveAttempted}
          validation={manualAssignmentValidation}
          onChange={setManualAssignmentRules}
        />
        <EditorActions>
          <Button
            size="sm"
            className="w-full sm:w-auto sm:min-w-[14rem]"
            variant="outline"
            disabled={
              !trimmedGuildId ||
              savingAction === "manual-assignment" ||
              !manualAssignmentDirty ||
              Boolean(manualAssignmentValidation.firstError)
            }
            loading={savingAction === "manual-assignment"}
            loadingLabel="Saving…"
            success={savedAction === "manual-assignment"}
            successLabel="Saved"
            onClick={() => void handleSaveManualAssignmentConfig()}
          >
            Save manual role rule
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!manualAssignmentDirty}
            onClick={discardManualAssignmentChanges}
          >
            Discard manual changes
          </Button>
        </EditorActions>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="New member temporary role"
          actions={
            newMemberRules.length ? (
              <ConfigurationAvailabilityActions
                label="new member rules"
                enabled={newMemberRules.some((rule) => rule.enabled !== false)}
                disabled={newMemberDirty || savingAction !== null}
                description="New assignments from these rules will stop. Rule settings and DM messages are kept; existing timed roles still expire normally."
                onEnabledChange={(enabled) => setRulesEnabled("new-member", enabled)}
              />
            ) : undefined
          }
          description="Give new arrivals onboarding roles that disappear after the configured duration."
        />
        <TimedRoleRuleRows
          idPrefix="tr-new-member"
          rules={newMemberRules}
          roles={resources?.roles ?? []}
          defaultDuration="1w"
          emptyText="No new member timed roles configured."
          saveAttempted={newMemberSaveAttempted}
          validation={newMemberValidation}
          onChange={setNewMemberRules}
        />
        <EditorActions>
          <Button
            size="sm"
            className="w-full sm:w-auto sm:min-w-[14rem]"
            variant="outline"
            disabled={
              !trimmedGuildId ||
              savingAction === "new-member" ||
              !newMemberDirty ||
              Boolean(newMemberValidation.firstError)
            }
            loading={savingAction === "new-member"}
            loadingLabel="Saving…"
            success={savedAction === "new-member"}
            successLabel="Saved"
            onClick={() => void handleSaveNewMemberConfig()}
          >
            Save new member role
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!newMemberDirty}
            onClick={discardNewMemberChanges}
          >
            Discard new-member changes
          </Button>
        </EditorActions>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Moderation log channel"
          description="Choose where assignment, expiry, and automation updates should be posted."
        />
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_auto] md:items-end">
          <FormField
            label="Moderation log channel"
            htmlFor="tr-log-channel"
            hint="Optional channel where timed role assignments, expirations, and automation updates are posted."
          >
            <ChannelSelect
              allowClear
              id="tr-log-channel"
              channels={resources?.textChannels ?? []}
              value={notificationChannelId}
              onChange={(value) => setNotificationChannelId(value)}
            />
          </FormField>
        </div>
        <EditorActions>
          <Button
            size="sm"
            className="w-full sm:w-auto sm:min-w-[14rem]"
            variant="outline"
            disabled={
              !trimmedGuildId ||
              savingAction === "notification-channel" ||
              !notificationChannelDirty
            }
            loading={savingAction === "notification-channel"}
            loadingLabel="Saving…"
            success={savedAction === "notification-channel"}
            successLabel="Saved"
            onClick={() => void handleSaveNotificationChannel()}
          >
            Save log channel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!notificationChannelDirty}
            onClick={discardNotificationChannelChanges}
          >
            Discard channel change
          </Button>
        </EditorActions>
      </SettingsBlock>

      {assignments !== null ? (
        <SettingsBlock>
          <SectionHeader
            title="Active timed roles"
            description="Audit active temporary assignments and remove them early when needed."
          />
          {assignments.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
              No timed roles are active in this guild.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Suspended roles</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments.map((assignment) => (
                  <TableRow key={`${assignment.guildId}:${assignment.userId}:${assignment.roleId}`}>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">
                        {assignment.userId}
                      </span>
                    </TableCell>
                    <TableCell>
                      {resources?.roles.find((r) => r.id === assignment.roleId)?.name ? (
                        <span>
                          {resources.roles.find((r) => r.id === assignment.roleId)!.name}
                          <span className="ml-1 font-mono text-xs text-muted-foreground">
                            ({assignment.roleId})
                          </span>
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          {assignment.roleId}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span>{humanizeTimedRoleDuration(assignment.durationInput)}</span>
                      <span className="ml-1 font-mono text-xs text-muted-foreground">
                        ({assignment.durationInput})
                      </span>
                    </TableCell>
                    <TableCell>
                      {(assignment.removedRoleIds?.length ?? 0) > 0 ? (
                        <div className="space-y-1 text-xs">
                          {assignment.removedRoleIds!.map((removedRoleId) => (
                            <div key={removedRoleId}>
                              {resources?.roles.find((role) => role.id === removedRoleId)?.name ??
                                removedRoleId}
                              {(assignment.pendingRestorationRoleIds ?? []).includes(removedRoleId)
                                ? " · will restore"
                                : ""}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">None removed</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <time dateTime={new Date(assignment.expiresAtMs).toISOString()}>
                        {new Date(assignment.expiresAtMs).toLocaleString()}
                      </time>
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({relativeExpiry(assignment.expiresAtMs)})
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleRemove(assignment)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SettingsBlock>
      ) : null}

      <PageFeedback error={api.error} />
      {trimmedGuildId && assignments !== null ? (
        <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
          {notificationChannelId.trim()
            ? `Updates will be posted to channel #${resources?.textChannels.find((c) => c.id === notificationChannelId.trim())?.name ?? notificationChannelId.trim()}.`
            : "Updates are not currently posted to a Discord channel."}
        </div>
      ) : null}
    </SettingsPanel>
  );
}

function ManualAssignmentPreview({ duration, userId }: { duration: string; userId: string }) {
  const parsedDuration = parseTimedRoleDuration(duration);
  const parsedUserId = parseDiscordUserId(userId);
  if (!parsedDuration && !parsedUserId.ok) return null;

  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm" aria-live="polite">
      {parsedUserId.ok && parsedUserId.wasMention ? (
        <p>
          Normalized ID: <code className="font-mono">{parsedUserId.id}</code>
        </p>
      ) : null}
      {parsedDuration ? (
        <p>
          Expected expiry in your local timezone:{" "}
          {new Date(parsedDuration.expiresAtMs).toLocaleString()}{" "}
          <span className="text-muted-foreground">
            ({relativeExpiry(parsedDuration.expiresAtMs)})
          </span>
        </p>
      ) : null}
    </div>
  );
}

function TimedRoleRuleRows({
  idPrefix,
  rules,
  roles,
  defaultDuration,
  emptyText,
  saveAttempted,
  validation,
  onChange,
}: {
  idPrefix: string;
  rules: TimedRoleAutomationRule[];
  roles: Array<{ id: string; name: string }>;
  defaultDuration: string;
  emptyText: string;
  saveAttempted?: boolean;
  validation: TimedRoleRulesValidation;
  onChange: (rules: TimedRoleAutomationRule[]) => void;
}) {
  const [openDmRuleIndex, setOpenDmRuleIndex] = useState<number | null>(null);

  function updateRule(index: number, patch: Partial<TimedRoleAutomationRule>) {
    onChange(rules.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)));
  }

  function removeRule(index: number) {
    onChange(rules.filter((_, ruleIndex) => ruleIndex !== index));
  }

  const roleIds = new Set(roles.map((role) => role.id));
  const missingRoleIds = rules
    .flatMap((rule) => [rule.roleId, ...(rule.suspendedRoleIds ?? [])])
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId.length > 0 && !roleIds.has(roleId));

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        rules.map((rule, index) => (
          <div
            key={index}
            className="grid gap-3 rounded-lg border bg-background p-3 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end"
          >
            <FormField
              label="Role"
              htmlFor={`${idPrefix}-role-${index}`}
              required
              hint="The role the bot should watch or assign."
              error={saveAttempted ? (validation.rows[index]?.roleId ?? undefined) : undefined}
            >
              <RoleSelect
                id={`${idPrefix}-role-${index}`}
                roles={roles}
                value={rule.roleId}
                onChange={(value) =>
                  updateRule(index, {
                    roleId: value,
                    suspendedRoleIds: (rule.suspendedRoleIds ?? []).filter((id) => id !== value),
                  })
                }
              />
            </FormField>
            <DurationBuilder
              id={`${idPrefix}-duration-${index}`}
              value={rule.durationInput}
              onChange={(value) => updateRule(index, { durationInput: value })}
              label="Keep role for"
              error={
                saveAttempted ? (validation.rows[index]?.durationInput ?? undefined) : undefined
              }
            />
            <ConfigurationAvailabilityActions
              label={`timed role rule ${index + 1}`}
              enabled={rule.enabled !== false}
              description="After saving, this rule stops creating assignments. Its settings are retained and existing assignments still expire."
              onEnabledChange={(enabled) => updateRule(index, { enabled })}
              additionalActions={[{ label: "Remove row", onSelect: () => removeRule(index) }]}
            />

            <div className="md:col-span-3">
              <FormField
                label="Roles to suspend while active"
                htmlFor={`${idPrefix}-suspended-roles-${index}`}
                hint="Optional. Only explicitly selected roles are removed. This can temporarily change the member's channel access until restoration."
                error={
                  saveAttempted
                    ? (validation.rows[index]?.suspendedRoleIds ?? undefined)
                    : undefined
                }
              >
                <MultiRoleSelect
                  id={`${idPrefix}-suspended-roles-${index}`}
                  roles={roles.filter((role) => role.id !== rule.roleId)}
                  value={rule.suspendedRoleIds ?? []}
                  onChange={(value) => updateRule(index, { suspendedRoleIds: value })}
                />
              </FormField>
            </div>
            <div className="space-y-2 md:col-span-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Assignment DM</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setOpenDmRuleIndex(openDmRuleIndex === index ? null : index)}
                >
                  {rule.dmMessage?.trim() ? "Edit DM" : "Configure DM"}
                </Button>
              </div>
              {openDmRuleIndex === index ? (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                  <FormField
                    label="DM message"
                    htmlFor={`${idPrefix}-dm-${index}`}
                    hint="Optional message sent to the member when this role is assigned."
                    error={
                      saveAttempted ? (validation.rows[index]?.dmMessage ?? undefined) : undefined
                    }
                  >
                    <Textarea
                      id={`${idPrefix}-dm-${index}`}
                      maxLength={500}
                      placeholder="Optional DM, e.g. Hi {username}, you received {rolename} until {expires}."
                      value={rule.dmMessage ?? ""}
                      onChange={(event) => updateRule(index, { dmMessage: event.target.value })}
                    />
                  </FormField>
                  <TimedRoleDmPlaceholderList />
                  <TimedRoleDmPreview rule={rule} roles={roles} />
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
      {missingRoleIds.length > 0 ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {`The selected role${missingRoleIds.length === 1 ? "" : "s"} ${missingRoleIds.join(", ")} no longer exist${missingRoleIds.length === 1 ? "s" : ""} in Discord.`}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rules, { roleId: "", durationInput: defaultDuration }])}
      >
        Add role rule
      </Button>
    </div>
  );
}

type DurationBuilderUnit = "minutes" | "hours" | "days" | "weeks";

const DURATION_PRESETS = [
  { label: "30 minutes", value: "30min" },
  { label: "1 hour", value: "1h" },
  { label: "1 day", value: "24h" },
  { label: "1 week", value: "1w" },
  { label: "30 days", value: "720h" },
];

function DurationBuilder({
  id,
  value,
  onChange,
  label = "Duration",
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  error?: string;
}) {
  const parsed = useMemo(() => parseDurationBuilderValue(value), [value]);
  const [amount, setAmount] = useState(parsed.amount);
  const [unit, setUnit] = useState<DurationBuilderUnit>(parsed.unit);
  const isCustom = parsed.custom;

  function updateAmount(nextAmount: string) {
    setAmount(nextAmount);
    onChange(serializeDurationBuilderValue(nextAmount, unit));
  }

  function updateUnit(nextUnit: DurationBuilderUnit) {
    setUnit(nextUnit);
    onChange(serializeDurationBuilderValue(amount || "1", nextUnit));
  }

  return (
    <FormField
      label={label}
      htmlFor={id}
      required
      hint="Choose a common duration or open Advanced duration for an existing custom code."
      error={error}
    >
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <Input
            id={id}
            inputMode="decimal"
            value={isCustom ? value : amount}
            onChange={(event) =>
              isCustom ? onChange(event.target.value) : updateAmount(event.target.value)
            }
            placeholder="Amount"
          />
          <select
            aria-label={`${label} unit`}
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={isCustom ? "custom" : unit}
            onChange={(event) => {
              if (event.target.value === "custom") return;
              updateUnit(event.target.value as DurationBuilderUnit);
            }}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
            <option value="weeks">Weeks</option>
            {isCustom ? <option value="custom">Advanced / existing code</option> : null}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Common duration presets">
          {DURATION_PRESETS.map((preset) => (
            <Button
              key={preset.value}
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = parseDurationBuilderValue(preset.value);
                setAmount(next.amount);
                setUnit(next.unit);
                onChange(preset.value);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <details>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Advanced duration
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            Existing custom codes are preserved exactly. Supported normal units are minutes, hours,
            days, and weeks.
          </p>
          {isCustom ? (
            <Input
              className="mt-2"
              value={value}
              aria-label={`${label} custom code`}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : null}
        </details>
      </div>
    </FormField>
  );
}

function parseDurationBuilderValue(value: string): {
  amount: string;
  unit: DurationBuilderUnit;
  custom: boolean;
} {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(min|m|h|w)$/i);
  if (!match) return { amount: value, unit: "hours", custom: true };
  const suffix = match[2]!.toLowerCase();
  if (suffix === "min") return { amount: match[1]!, unit: "minutes", custom: false };
  if (suffix === "h") {
    const hours = Number(match[1]);
    if (Number.isInteger(hours) && hours >= 24 && hours % 24 === 0) {
      return { amount: String(hours / 24), unit: "days", custom: false };
    }
    return { amount: match[1]!, unit: "hours", custom: false };
  }
  if (suffix === "w") return { amount: match[1]!, unit: "weeks", custom: false };
  return { amount: match[1]!, unit: "hours", custom: true };
}

function durationUnitSuffix(unit: DurationBuilderUnit): string {
  return unit === "minutes" ? "min" : unit === "hours" ? "h" : "w";
}

function serializeDurationBuilderValue(amount: string, unit: DurationBuilderUnit): string {
  if (unit === "days") {
    const numeric = Number(amount);
    return Number.isFinite(numeric) ? `${numeric * 24}h` : `${amount}h`;
  }
  return `${amount}${durationUnitSuffix(unit)}`;
}

function areTimedRoleSnapshotsEqual(
  left: TimedRoleAutomationRule[],
  right: TimedRoleAutomationRule[],
): boolean {
  return (
    JSON.stringify(normalizeTimedRoleRules(left)) === JSON.stringify(normalizeTimedRoleRules(right))
  );
}

export function validateDurationInput(value: string): string | null {
  if (!value.trim()) return "Enter a duration.";
  if (!/^\d+(?:min|[hwm])$/i.test(value.trim())) {
    return "Use a positive whole number followed by min, h, w, or an existing custom code.";
  }
  if (!parseTimedRoleDuration(value)) return "Duration must be greater than zero and supported.";
  return null;
}

export function humanizeTimedRoleDuration(value: string): string {
  const match = value.trim().match(/^(\d+)(min|[hwm])$/i);
  if (!match) return value;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const labels: Record<string, string> = {
    min: "minute",
    h: "hour",
    w: "week",
    m: "month",
  };
  return `${amount} ${labels[unit] ?? unit}${amount === 1 ? "" : "s"}`;
}

export function relativeExpiry(expiresAtMs: number, nowMs = Date.now()): string {
  const deltaMs = expiresAtMs - nowMs;
  const minutes = Math.max(1, Math.round(Math.abs(deltaMs) / 60_000));
  const amount =
    minutes < 60 ? minutes : minutes < 1440 ? Math.round(minutes / 60) : Math.round(minutes / 1440);
  const unit = minutes < 60 ? "minute" : minutes < 1440 ? "hour" : "day";
  return deltaMs >= 0
    ? `expires in ${amount} ${unit}${amount === 1 ? "" : "s"}`
    : `expired ${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

function TimedRoleDmPlaceholderList() {
  return (
    <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
      {TIMED_ROLE_DM_PLACEHOLDERS.map((placeholder) => (
        <p key={placeholder.token}>
          <code>{placeholder.token}</code> {placeholder.description}
        </p>
      ))}
    </div>
  );
}

function TimedRoleDmPreview({
  rule,
  roles,
}: {
  rule: TimedRoleAutomationRule;
  roles: Array<{ id: string; name: string }>;
}) {
  const roleName = roles.find((role) => role.id === rule.roleId)?.name ?? "Role name";
  const renderedDescription = renderTimedRoleDmPreview(rule.dmMessage ?? "", {
    duration: rule.durationInput || "1h",
    roleName,
  });

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Preview</p>
      <DiscordMessagePreview
        embedTitle="Role Assigned"
        embedColor="#57f287"
        embedDescription={renderedDescription}
        embedFields={[
          { name: "Role", value: "<@&9876543210>" },
          { name: "Duration", value: rule.durationInput || "1h" },
          { name: "Expires", value: "in 7 days" },
        ]}
        embedFooter={{ text: "hafbot.xyz" }}
      />
    </div>
  );
}

function normalizeTimedRoleRules(rules: TimedRoleAutomationRule[]): TimedRoleAutomationRule[] {
  return rules.map((rule) => ({
    roleId: rule.roleId.trim(),
    ...(rule.enabled === false ? { enabled: false } : {}),
    durationInput: rule.durationInput.trim(),
    dmMessage: rule.dmMessage?.trim() || null,
    suspendedRoleIds: [
      ...new Set((rule.suspendedRoleIds ?? []).map((roleId) => roleId.trim()).filter(Boolean)),
    ],
  }));
}

interface TimedRoleRuleValidation {
  roleId: string | null;
  durationInput: string | null;
  dmMessage: string | null;
  suspendedRoleIds: string | null;
}

interface TimedRoleRulesValidation {
  firstError: string | null;
  rows: TimedRoleRuleValidation[];
}

function validateTimedRoleRules(rules: TimedRoleAutomationRule[]): string | null {
  return validateTimedRoleRulesDetailed(rules).firstError;
}

export function validateTimedRoleRulesDetailed(
  rules: TimedRoleAutomationRule[],
): TimedRoleRulesValidation {
  const rows: TimedRoleRuleValidation[] = rules.map(() => ({
    roleId: null,
    durationInput: null,
    dmMessage: null,
    suspendedRoleIds: null,
  }));
  const seenRoleIds = new Map<string, number>();
  let firstError: string | null = null;

  function remember(error: string | null) {
    if (!firstError && error) firstError = error;
  }

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    const roleId = rule.roleId.trim();
    const durationInput = rule.durationInput.trim();
    const row = rows[index]!;

    if (!roleId) {
      row.roleId = `Select the role for timed-role row ${index + 1}.`;
      remember(`Timed-role row ${index + 1}: Select the role for this timed role rule.`);
    }

    if (!durationInput) {
      row.durationInput = "Enter how long the role should stay on the member.";
      remember(`Timed-role row ${index + 1}: Enter how long the role should stay on the member.`);
    } else {
      const durationError = validateDurationInput(durationInput);
      if (durationError) {
        row.durationInput = durationError;
        remember(`Timed-role row ${index + 1}: ${durationError}`);
      }
    }

    if (roleId) {
      const previousIndex = seenRoleIds.get(roleId);
      if (previousIndex !== undefined) {
        const duplicateError = `Duplicate timed-role role selected: ${roleId}.`;
        row.roleId = duplicateError;
        rows[previousIndex]!.roleId = duplicateError;
        remember(`Timed-role row ${index + 1}: ${duplicateError}`);
      } else {
        seenRoleIds.set(roleId, index);
      }
    }

    if (rule.dmMessage?.trim() && !isValidTimedRoleDmTemplate(rule.dmMessage)) {
      row.dmMessage = `Timed-role DM row ${index + 1} has an unknown placeholder.`;
      remember(
        `Timed-role row ${index + 1}: Timed-role DM row ${index + 1} has an unknown placeholder.`,
      );
    }

    if ((rule.suspendedRoleIds ?? []).map((id) => id.trim()).includes(roleId) && roleId) {
      row.suspendedRoleIds = "The assigned timed role cannot also be suspended.";
      remember(`Timed-role row ${index + 1}: ${row.suspendedRoleIds}`);
    }
  }

  return { firstError, rows };
}

function isValidTimedRoleDmTemplate(template: string): boolean {
  const allowed = new Set(TIMED_ROLE_DM_PLACEHOLDERS.map((placeholder) => placeholder.name));
  return Array.from(template.matchAll(/\{([^{}]+)\}/g)).every((match) =>
    allowed.has(match[1] ?? ""),
  );
}

const TIMED_ROLE_DM_PLACEHOLDERS = [
  { name: "user", token: "{user}", description: "mentions the assigned member." },
  { name: "username", token: "{username}", description: "shows the member display name." },
  { name: "role", token: "{role}", description: "mentions the assigned role." },
  { name: "rolename", token: "{rolename}", description: "shows the assigned role name." },
  { name: "duration", token: "{duration}", description: "shows the configured duration." },
  {
    name: "expires",
    token: "{expires}",
    description: "shows the expiry as Discord relative time.",
  },
  {
    name: "expires_at",
    token: "{expires_at}",
    description: "shows the expiry as Discord date/time.",
  },
  { name: "guild", token: "{guild}", description: "shows the guild name." },
];

export function renderTimedRoleDmPreview(
  template: string,
  options: { duration: string; roleName: string },
): string {
  const preview = template.trim() || "No assignment DM will be sent.";
  return preview
    .replaceAll("{user}", "<@1234567890>")
    .replaceAll("{username}", "ExampleUser")
    .replaceAll("{role}", "<@&9876543210>")
    .replaceAll("{rolename}", options.roleName)
    .replaceAll("{duration}", options.duration)
    .replaceAll("{expires}", "in 7 days")
    .replaceAll("{expires_at}", "June 11, 2026 12:00 PM")
    .replaceAll("{guild}", "Example Guild");
}
