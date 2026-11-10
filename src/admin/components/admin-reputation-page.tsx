import { useEffect, useRef, useState } from "react";
import {
  reputationSettingsSchema,
  type ReputationConfig,
  type ReputationSettings,
} from "../../reputation/types";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { AdminPageHeader } from "./admin-page-header";
import { AdminBottomActionBar } from "./admin-bottom-action-bar";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { MultiRoleSelect, RoleSelect } from "./guild-resource-select";
import { NavigationGuard } from "./navigation-guard";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

export interface ReputationLoaderData {
  guildId: string;
  config: ReputationConfig;
}

export function AdminReputationPage(props: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ReputationLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  if (!props.selectedGuildId) return <NoGuildSelected feature="Reputation" />;
  if (!props.initialData || props.initialData.guildId !== props.selectedGuildId)
    return <PageFeedback error="Reputation settings could not be loaded. Reload this page." />;
  return (
    <ReputationEditor
      key={`${props.selectedWorkspaceId}:${props.selectedGuildId}`}
      {...props}
      config={props.initialData.config}
    />
  );
}

function ReputationEditor({
  selectedWorkspaceId,
  selectedGuildId,
  config,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  config: ReputationConfig;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const initial = settingsFromConfig(config);
  const [settings, setSettings] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [revision, setRevision] = useState(config.revision);
  const [message, setMessage] = useState<string | null>(null);
  const api = useAdminApi();
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const { resources, loading: resourcesLoading } = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
  );
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  useEffect(() => () => request.current?.abort(), []);
  function update<K extends keyof ReputationSettings>(key: K, value: ReputationSettings[K]) {
    setSettings((previous) => ({ ...previous, [key]: value }));
    setMessage(null);
  }
  async function save() {
    if (saving.current) return;
    const parsed = reputationSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      api.setError(parsed.error.issues[0]?.message ?? "Check the Reputation settings.");
      return;
    }
    saving.current = true;
    request.current = new AbortController();
    const snapshot = parsed.data;
    await api.run(async () => {
      const result = await createAdminLoaderClient(request.current!.signal).postJson<{
        config: ReputationConfig;
      }>(
        "/admin/api/reputation/config",
        { settings: snapshot, expectedRevision: revision },
        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
      );
      setRevision(result.config.revision);
      setSaved(snapshot);
      setMessage("Reputation settings saved.");
      await onRouteDataRefresh?.().catch(() =>
        setMessage("Settings saved. Reload the page to refresh the dashboard."),
      );
    });
    saving.current = false;
  }
  return (
    <div className="space-y-6">
      <NavigationGuard hasChanges={dirty} />
      <AdminPageHeader
        title="Reputation"
        description="Recognise helpful teammates with member-awarded thanks and safe role rewards."
        actions={<UnsavedChangesIndicator hasChanges={dirty} />}
      />
      <PageFeedback error={api.error} message={message} />
      <SettingsBlock>
        <SectionHeader
          title="Member recognition"
          description="Members use /rep give, /rep profile and /rep leaderboard. Each thanks adds one reputation point."
        />
        <div className="flex items-center gap-3">
          <Switch
            id="reputation-enabled"
            checked={settings.enabled}
            onCheckedChange={(value) => update("enabled", value)}
            disabled={api.loading}
          />
          <label htmlFor="reputation-enabled">Enable Reputation</label>
        </div>
        <FormField
          label="Giver cooldown (seconds)"
          htmlFor="reputation-cooldown"
          hint="The wait before a member can thank anyone again. Default: one day."
        >
          <Input
            id="reputation-cooldown"
            type="number"
            min={60}
            max={604800}
            value={settings.cooldownSeconds}
            onChange={(event) => update("cooldownSeconds", Number(event.target.value))}
            disabled={api.loading}
          />
        </FormField>
        <FormField
          label="Roles allowed to give reputation"
          hint="Leave empty to allow every eligible member."
        >
          <MultiRoleSelect
            aria-label="Roles allowed to give reputation"
            roles={resources?.roles ?? []}
            value={settings.giverRoleIds}
            onChange={(value) => update("giverRoleIds", value)}
            disabled={api.loading || resourcesLoading}
          />
        </FormField>
        <FormField
          label="Excluded roles"
          hint="Members with any excluded role cannot give or receive reputation."
        >
          <MultiRoleSelect
            aria-label="Roles excluded from reputation"
            roles={resources?.roles ?? []}
            value={settings.excludedRoleIds}
            onChange={(value) => update("excludedRoleIds", value)}
            disabled={api.loading || resourcesLoading}
          />
        </FormField>
      </SettingsBlock>
      <SettingsBlock>
        <SectionHeader
          title="Role rewards"
          description="Grant dedicated community roles at reputation milestones. Staff, paid-access and other HAF-managed roles cannot be rewards. Rewards never remove roles."
          actions={
            <Button
              type="button"
              variant="secondary"
              disabled={settings.rewards.length >= 20 || api.loading}
              onClick={() => update("rewards", [...settings.rewards, { threshold: 5, roleId: "" }])}
            >
              Add reward
            </Button>
          }
        />
        {settings.rewards.length === 0 ? (
          <p className="text-sm text-muted-foreground">No role rewards configured.</p>
        ) : (
          settings.rewards.map((reward, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-[120px_1fr_auto] sm:items-end">
              <FormField label="Reputation" htmlFor={`reputation-threshold-${index}`}>
                <Input
                  id={`reputation-threshold-${index}`}
                  type="number"
                  min={1}
                  max={1000000}
                  value={reward.threshold}
                  disabled={api.loading}
                  onChange={(event) =>
                    update(
                      "rewards",
                      settings.rewards.map((entry, position) =>
                        position === index
                          ? { ...entry, threshold: Number(event.target.value) }
                          : entry,
                      ),
                    )
                  }
                />
              </FormField>
              <FormField label="Reward role">
                <RoleSelect
                  aria-label={`Reward role ${index + 1}`}
                  roles={resources?.roles ?? []}
                  value={reward.roleId}
                  onChange={(roleId) =>
                    update(
                      "rewards",
                      settings.rewards.map((entry, position) =>
                        position === index ? { ...entry, roleId } : entry,
                      ),
                    )
                  }
                  disabled={api.loading || resourcesLoading}
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                disabled={api.loading}
                aria-label={`Remove reward ${index + 1}`}
                onClick={() =>
                  update(
                    "rewards",
                    settings.rewards.filter((_, position) => position !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </SettingsBlock>
      <AdminBottomActionBar
        actions={[
          {
            label: "Save settings",
            loadingLabel: "Saving…",
            loading: api.loading,
            disabled: !dirty || api.loading,
            onClick: () => void save(),
          },
        ]}
      />
    </div>
  );
}

function settingsFromConfig(config: ReputationConfig): ReputationSettings {
  return {
    enabled: config.enabled,
    cooldownSeconds: config.cooldownSeconds,
    giverRoleIds: [...config.giverRoleIds],
    excludedRoleIds: [...config.excludedRoleIds],
    rewards: config.rewards.map((reward) => ({ ...reward })),
  };
}
