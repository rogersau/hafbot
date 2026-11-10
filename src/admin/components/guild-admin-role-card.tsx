import { useRef, useState } from "react";

import { useGuildResources } from "../hooks/use-guild-resources";
import { NavigationGuard } from "./navigation-guard";
import { RoleSelect } from "./guild-resource-select";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Label } from "./ui/label";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useToast } from "./toast";

type RoleId = string;

function normalizeRoleId(roleId: string | null | undefined): RoleId {
  return roleId?.trim() ?? "";
}

function roleName(roleId: RoleId, roles: Array<{ id: string; name: string }>): string {
  if (!roleId) return "no delegated role";
  const role = roles.find((entry) => entry.id === roleId);
  return role ? `@${role.name}` : `Unavailable role · ${roleId}`;
}

export function GuildAdminRoleCard({
  selectedWorkspaceId,
  selectedGuildId,
  initialAdminRoleId = null,
  initialManageServerAdminEnabled = true,
  canManageDelegation = false,
  canManageServerPolicy = false,
  onSaved,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialAdminRoleId?: string | null;
  initialManageServerAdminEnabled?: boolean;
  canManageDelegation?: boolean;
  canManageServerPolicy?: boolean;
  onSaved?: () => Promise<void>;
}) {
  const [managerEnabled, setManagerEnabled] = useState(initialManageServerAdminEnabled);
  const [policySaving, setPolicySaving] = useState(false);
  async function updateManagerPolicy() {
    if (!canManageServerPolicy || policySaving) return;
    setPolicySaving(true);
    try {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      const result = await crossCuttingClient.saveGuildAdminRole({
        guildId: selectedGuildId,
        manageServerAdminEnabled: !managerEnabled,
      });
      setManagerEnabled(result.manageServerAdminEnabled);
      toast.success("Access updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save HAF admin role.");
    } finally {
      setPolicySaving(false);
    }
  }
  const trimmedGuildId = selectedGuildId.trim();
  const initialRoleId = normalizeRoleId(initialAdminRoleId);
  const [savedRoleId, setSavedRoleId] = useState<RoleId>(initialRoleId);
  const [draftRoleId, setDraftRoleId] = useState<RoleId>(initialRoleId);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const toast = useToast();
  const savingRef = useRef(false);
  const actionPendingRef = useRef(false);
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);
  const roles = resources?.roles ?? [];
  const hasUnsavedChanges = draftRoleId !== savedRoleId;
  const savedRoleMissing = Boolean(
    savedRoleId && resources && !roles.some((role) => role.id === savedRoleId),
  );
  const draftRoleValid = !draftRoleId || roles.some((role) => role.id === draftRoleId);

  function discardChanges() {
    setDraftRoleId(savedRoleId);
    setSuccess(null);
    setRefreshError(null);
  }

  async function handleDiscardChanges() {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    try {
      const confirmed = await confirm({
        title: "Discard HAF admin role changes?",
        description: "This restores the last saved delegated dashboard access role.",
        confirmLabel: "Discard changes",
        variant: "destructive",
      });
      if (confirmed) discardChanges();
    } finally {
      actionPendingRef.current = false;
    }
  }

  async function saveAdminRole(nextRoleId: RoleId) {
    const nextRoleValid = !nextRoleId || roles.some((role) => role.id === nextRoleId);
    if (!canManageDelegation || !trimmedGuildId || savingRef.current || !nextRoleValid) return;

    savingRef.current = true;
    setSaving(true);
    setSuccess(null);
    setRefreshError(null);
    try {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      const body = await crossCuttingClient.saveGuildAdminRole({
        workspaceId: selectedWorkspaceId.trim() || undefined,
        guildId: trimmedGuildId,
        adminRoleId: nextRoleId || null,
      });
      const savedRole = normalizeRoleId(body.adminRoleId);
      setSavedRoleId(savedRole);
      setDraftRoleId(savedRole);
      setSuccess("Access updated.");
      toast.success("Access updated.");

      try {
        await onSaved?.();
      } catch {
        setSuccess(null);
        setRefreshError(
          "Access updated, but the page could not refresh. Your change is saved; retry the refresh to verify it.",
        );
      }
    } catch (saveError) {
      toast.error(
        saveError instanceof Error ? saveError.message : "Failed to save HAF admin role.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function requestSave() {
    if (!hasUnsavedChanges || !draftRoleValid || savingRef.current || actionPendingRef.current) {
      return;
    }

    actionPendingRef.current = true;
    try {
      if (!savedRoleId) {
        await saveAdminRole(draftRoleId);
        return;
      }

      const currentName = roleName(savedRoleId, roles);
      const nextName = roleName(draftRoleId, roles);
      const confirmed = await confirm({
        title: draftRoleId ? "Change HAF admin role?" : "Remove HAF admin role?",
        description: draftRoleId
          ? `Current role: ${currentName}. New role: ${nextName}. Members of ${currentName} will lose delegated HAF dashboard access. Members of ${nextName} will gain delegated HAF dashboard access. Discord permissions themselves are not changed.`
          : `This removes delegated HAF dashboard access from members of ${currentName}. Server owners and Discord Administrators retain access. Manage Server access follows the owner’s setting. Discord permissions themselves are not changed.`,
        confirmLabel: draftRoleId ? "Change access role" : "Remove delegated access",
        variant: draftRoleId ? "default" : "destructive",
      });
      if (confirmed) await saveAdminRole(draftRoleId);
    } finally {
      actionPendingRef.current = false;
    }
  }

  async function clearRole() {
    if (savingRef.current || actionPendingRef.current) return;
    if (!savedRoleId) {
      setDraftRoleId("");
      return;
    }

    actionPendingRef.current = true;
    try {
      const currentName = roleName(savedRoleId, roles);
      const confirmed = await confirm({
        title: "Remove HAF admin role?",
        description: `This removes delegated HAF dashboard access from members of ${currentName}. Server owners and Discord Administrators retain access. Manage Server access follows the owner’s setting. Discord permissions themselves are not changed.`,
        confirmLabel: "Remove delegated access",
        variant: "destructive",
      });
      if (confirmed) {
        setDraftRoleId("");
        await saveAdminRole("");
      }
    } finally {
      actionPendingRef.current = false;
    }
  }

  async function retryRefresh() {
    if (!onSaved || refreshing) return;
    setRefreshing(true);
    try {
      await onSaved();
      setRefreshError(null);
      setSuccess("Access updated and the page refreshed.");
    } catch {
      setRefreshError(
        "Access updated, but the page could not refresh. Your change is saved; retry the refresh to verify it.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">HAF admin role</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Members with this Discord role can access and configure this guild in the HAF dashboard.
          This does not grant additional Discord permissions.
        </p>
        <div className="space-y-2 rounded border p-3">
          <p>Automatic HAF access for Manage Server: {managerEnabled ? "On" : "Off"}.</p>
          <p className="text-sm text-muted-foreground">Other access grants are unaffected.</p>
          {canManageServerPolicy ? (
            <Button
              variant="outline"
              disabled={policySaving}
              onClick={() => void updateManagerPolicy()}
            >
              {managerEnabled
                ? "Disable automatic Manage Server access"
                : "Enable automatic Manage Server access"}
            </Button>
          ) : null}
        </div>
        {!canManageDelegation ? (
          <p className="text-sm text-muted-foreground">
            Only the server owner or a Discord Administrator can change the HAF admin role.
          </p>
        ) : null}
        {!trimmedGuildId ? (
          <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
            Pick a server from the sidebar to configure its HAF admin role.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Delegated dashboard access</p>
              <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
            </div>
            <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
            {confirmDialog}
            <div className="space-y-2">
              <Label htmlFor="guild-admin-role-id">Discord role</Label>
              <RoleSelect
                allowClear
                id="guild-admin-role-id"
                roles={roles}
                value={draftRoleId}
                disabled={saving || !canManageDelegation}
                onChange={(value) => {
                  setDraftRoleId(value);
                  setSuccess(null);
                  setRefreshError(null);
                }}
                creation={
                  canManageDelegation
                    ? {
                        guildId: trimmedGuildId,
                        workspaceId: selectedWorkspaceId,
                        surfaceKey: "guild_access",
                        dependencyKey: "admin_role",
                        label: "HAF administrator role",
                        recommendedName: "HAF Administrator",
                      }
                    : undefined
                }
              />
            </div>
            {savedRoleMissing ? (
              <p className="text-sm text-amber-200">
                The saved role ({savedRoleId}) is no longer available in Discord. Choose another
                role or clear delegated access.
              </p>
            ) : null}
            {refreshError ? (
              <div
                className="flex flex-wrap items-center gap-3 text-sm text-amber-200"
                role="alert"
              >
                <span>{refreshError}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void retryRefresh()}
                  disabled={refreshing}
                >
                  {refreshing ? "Retrying…" : "Retry"}
                </Button>
              </div>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                size="sm"
                disabled={!canManageDelegation || !hasUnsavedChanges || !draftRoleValid || saving}
                loading={saving}
                loadingLabel="Saving..."
                success={Boolean(success) && !hasUnsavedChanges}
                successLabel="Saved"
                onClick={() => void requestSave()}
              >
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canManageDelegation || saving || draftRoleId.length === 0}
                onClick={() => void clearRole()}
              >
                Clear
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!hasUnsavedChanges || saving}
                onClick={() => void handleDiscardChanges()}
              >
                Discard changes
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function buildGuildAdminRoleApiPath(guildId: string, workspaceId?: string): string {
  const params = new URLSearchParams({ guildId });
  if (workspaceId?.trim()) {
    params.set("workspaceId", workspaceId.trim());
  }
  return `/admin/api/guild-rbac/admin-role?${params.toString()}`;
}
