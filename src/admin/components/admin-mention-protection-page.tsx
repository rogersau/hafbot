import { useRef, useState } from "react";
import type { MentionProtectionConfig, MentionProtectionResponsePolicy } from "../../types";
import { createDefaultMentionProtectionConfig } from "../../services/mention-protection/message-handler";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { AdminPageHeader } from "./admin-page-header";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { MultiChannelSelect, MultiRoleSelect, RoleSelect } from "./guild-resource-select";
import { NavigationGuard } from "./navigation-guard";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { useToast } from "./toast";
import { refreshAdminRouteData, requireAdminRouteRefresh } from "../lib/mutation-reconciliation";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import type { MentionProtectionLoaderData } from "../lib/admin-route-loaders";
import type { AdminPermissionCheck } from "../../runtime/admin-types";
import { ConfigurationHistoryCard } from "./configuration-history-card";
import { useConfirmDialog } from "./ui/confirm-dialog";

export type MentionProtectionConfigSnapshot = Omit<
  MentionProtectionConfig,
  "guildId" | "createdAtMs" | "updatedAtMs"
>;

export function AdminMentionProtectionPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement: EntitlementInfo | null;
  initialData?: MentionProtectionLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const guildId = selectedGuildId.trim();
  const [editorGeneration, setEditorGeneration] = useState(0);
  const editorHasUnsavedChanges = useRef(false);
  return (
    <section className="admin-feature-page admin-page-settings admin-mention-protection-page space-y-6">
      <AdminPageHeader
        title="Mention Protection"
        description="Protect selected admin roles and respond to direct-user mention spam with independent escalation policies."
        readinessFeature="mention-protection"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!guildId ? (
        <NoGuildSelected feature="Mention Protection" />
      ) : (
        <>
          <MentionProtectionEditor
            key={editorGeneration}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={guildId}
            paidFeaturesAvailable={Boolean(entitlement && entitlement.tier !== "free")}
            initialData={initialData}
            onRouteDataRefresh={onRouteDataRefresh}
            onUnsavedChangesChange={(hasChanges) => {
              editorHasUnsavedChanges.current = hasChanges;
            }}
          />
          <ConfigurationHistoryCard
            guildId={guildId}
            workspaceId={selectedWorkspaceId}
            feature="mention-protection"
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

function MentionProtectionEditor({
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
  initialData?: MentionProtectionLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
  onUnsavedChangesChange?: (hasChanges: boolean) => void;
}) {
  const initial = normalizeMentionProtectionConfig(initialData?.config);
  const [config, setConfig] = useState<MentionProtectionConfigSnapshot>(initial);
  const [savedConfig, setSavedConfig] = useState<MentionProtectionConfigSnapshot>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);
  const roles = resources?.roles ?? [];
  const channels = [...(resources?.textChannels ?? []), ...(resources?.forumChannels ?? [])];
  const errors = validateMentionProtectionConfig({
    ...config,
    spamEnabled: paidFeaturesAvailable && config.spamEnabled,
    adminInitialResponse: paidFeaturesAvailable
      ? config.adminInitialResponse
      : { ...config.adminInitialResponse, restriction: { type: "none" } },
    adminRepeatResponse: paidFeaturesAvailable
      ? config.adminRepeatResponse
      : { ...config.adminRepeatResponse, restriction: { type: "none" } },
  });
  const knownRoleIds = new Set(roles.map((role) => role.id));
  const missingRoleIds = configuredRoleIds(config, paidFeaturesAvailable).filter(
    (roleId) => !knownRoleIds.has(roleId),
  );
  const firstError = Object.values(errors).find((error) => error !== null) ?? null;
  const hasChanges = hasMentionProtectionChanges(config, savedConfig);
  onUnsavedChangesChange?.(hasChanges);

  function update(patch: Partial<MentionProtectionConfigSnapshot>) {
    setConfig((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function save() {
    if (firstError) {
      api.setError(firstError);
      return;
    }
    setSaving(true);
    api.setError(null);
    try {
      await createAdminLoaderClient().postJson("/admin/api/mention-protection/config", config, {
        workspaceId: selectedWorkspaceId,
        guildId: selectedGuildId,
      });
      setSavedConfig(config);
      setSaved(true);
      toast.success("Saved Mention Protection configuration.");
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Mention Protection.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-mention-protection-editor space-y-5">
      <NavigationGuard
        hasChanges={hasChanges}
        onDiscardChanges={() => {
          setConfig(savedConfig);
          setSaved(false);
          api.setError(null);
        }}
      />
      <UnsavedChangesIndicator hasChanges={hasChanges} />
      {!config.adminEnabled && !config.spamEnabled ? (
        <div className="rounded-[4px] border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Enable at least one protection to begin processing new messages.
        </div>
      ) : null}
      {missingRoleIds.length > 0 ? (
        <div className="rounded-[4px] border border-red-500/30 bg-red-500/10 p-3 text-sm">
          Missing configured role(s): {missingRoleIds.join(", ")}. Replace them before saving;
          missing Protected Admin Roles match nobody and missing Timed Roles cannot be applied.
        </div>
      ) : null}
      <MentionProtectionSetupIssues checks={initialData?.setupChecks ?? []} />

      <SettingsBlock>
        <SectionHeader
          title="Shared scope and eligibility"
          description="Both protections use this Channel Scope and Excluded Role set. Threads and Forum posts inherit their parent channel."
        />
        <MentionProtectionChannelScopeFields
          mode={config.channelMode}
          channelIds={config.channelIds}
          channels={channels}
          onModeChange={(channelMode) => update({ channelMode })}
          onChannelIdsChange={(channelIds) => update({ channelIds })}
        />
        <FormField
          label="Mention Protection Excluded Role(s)"
          htmlFor="mp-excluded-roles"
          hint="A member holding any selected role is skipped by both protections."
        >
          <MultiRoleSelect
            id="mp-excluded-roles"
            value={config.excludedRoleIds}
            onChange={(excludedRoleIds) => update({ excludedRoleIds })}
            roles={roles}
          />
        </FormField>
      </SettingsBlock>

      <ProtectionSettings
        kind="admin"
        available
        paidRestrictionsAvailable={paidFeaturesAvailable}
        enabled={config.adminEnabled}
        onEnabledChange={(adminEnabled) => update({ adminEnabled })}
        repeatPeriodMs={config.adminRepeatPeriodMs}
        onRepeatPeriodChange={(adminRepeatPeriodMs) => update({ adminRepeatPeriodMs })}
        initialPolicy={config.adminInitialResponse}
        onInitialPolicyChange={(adminInitialResponse) => update({ adminInitialResponse })}
        repeatPolicy={config.adminRepeatResponse}
        onRepeatPolicyChange={(adminRepeatResponse) => update({ adminRepeatResponse })}
        roles={roles}
      >
        <FormField
          label="Protected Admin Role(s)"
          htmlFor="mp-protected-roles"
          error={errors.protectedRoles ?? undefined}
          hint="Protection follows current membership of these roles."
        >
          <MultiRoleSelect
            id="mp-protected-roles"
            value={config.protectedAdminRoleIds}
            onChange={(protectedAdminRoleIds) => update({ protectedAdminRoleIds })}
            roles={roles}
          />
        </FormField>
      </ProtectionSettings>

      <ProtectionSettings
        kind="spam"
        available={paidFeaturesAvailable}
        paidRestrictionsAvailable={paidFeaturesAvailable}
        enabled={config.spamEnabled}
        onEnabledChange={(spamEnabled) => update({ spamEnabled })}
        repeatPeriodMs={config.spamRepeatPeriodMs}
        onRepeatPeriodChange={(spamRepeatPeriodMs) => update({ spamRepeatPeriodMs })}
        initialPolicy={config.spamInitialResponse}
        onInitialPolicyChange={(spamInitialResponse) => update({ spamInitialResponse })}
        repeatPolicy={config.spamRepeatResponse}
        onRepeatPolicyChange={(spamRepeatResponse) => update({ spamRepeatResponse })}
        roles={roles}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            id="mp-mass-threshold"
            label="Mass Mention users"
            value={config.massMentionThreshold}
            min={2}
            max={50}
            onChange={(massMentionThreshold) => update({ massMentionThreshold })}
          />
          <NumberField
            id="mp-burst-threshold"
            label="Mention Burst messages"
            value={config.burstMessageThreshold}
            min={2}
            max={20}
            onChange={(burstMessageThreshold) => update({ burstMessageThreshold })}
          />
          <NumberField
            id="mp-burst-window"
            label="Burst window (seconds)"
            value={config.burstWindowSeconds}
            min={5}
            max={300}
            onChange={(burstWindowSeconds) => update({ burstWindowSeconds })}
          />
        </div>
      </ProtectionSettings>

      <PageFeedback error={api.error} />
      <AdminBottomActionBar
        actions={[
          {
            label: "Discard changes",
            variant: "secondary",
            disabled: !hasChanges || saving,
            onClick: () => setConfig(savedConfig),
          },
          {
            label: "Save changes",
            loadingLabel: "Saving...",
            loading: saving,
            success: saved && !hasChanges,
            successLabel: "Saved",
            disabled: !hasChanges || saving || Boolean(firstError),
            variant: "accent",
            onClick: () => void save(),
          },
        ]}
      />
    </div>
  );
}

export function MentionProtectionSetupIssues({ checks }: { checks: AdminPermissionCheck[] }) {
  const issues = checks.filter((check) => check.status !== "ok");
  if (issues.length === 0) return null;

  return (
    <SettingsBlock>
      <SectionHeader
        title="Setup issues"
        description="Resolve these Discord configuration issues before relying on enforcement."
      />
      <div className="space-y-2">
        {issues.map((check) => (
          <div key={check.label} className="rounded-[4px] border p-3 text-sm">
            <div className="font-medium">
              {check.status === "warning" ? "Warning" : "Fix"}
              {": "}
              {check.label}
            </div>
            <div className="text-muted-foreground">{check.detail}</div>
          </div>
        ))}
      </div>
    </SettingsBlock>
  );
}

export function MentionProtectionChannelScopeFields({
  mode,
  channelIds,
  channels,
  onModeChange,
  onChannelIdsChange,
}: {
  mode: "include" | "exclude";
  channelIds: string[];
  channels: Array<{ id: string; name: string }>;
  onModeChange: (mode: "include" | "exclude") => void;
  onChannelIdsChange: (channelIds: string[]) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,0.55fr)_minmax(0,1fr)]">
        <FormField
          label="Filter mode"
          hint="Include protects only selected channels. Exclude protects every channel except the selected ones."
        >
          <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-1.5">
            <Button
              type="button"
              size="sm"
              variant={mode === "include" ? "default" : "outline"}
              onClick={() => onModeChange("include")}
            >
              Include
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "exclude" ? "default" : "outline"}
              onClick={() => onModeChange("exclude")}
            >
              Exclude
            </Button>
          </div>
        </FormField>
        <FormField
          label="Mention Protection Channel Scope"
          hint="Leave empty to protect every channel."
        >
          <MultiChannelSelect
            id="mp-channels"
            value={channelIds}
            onChange={onChannelIdsChange}
            channels={channels}
          />
        </FormField>
      </div>
      <p className="text-xs text-muted-foreground">
        {channelIds.length === 0
          ? "No channels selected means all channels are protected."
          : mode === "include"
            ? "Only selected channels are protected."
            : "Selected channels are excluded; all other channels are protected."}
      </p>
    </div>
  );
}

function ProtectionSettings({
  kind,
  available,
  paidRestrictionsAvailable,
  enabled,
  onEnabledChange,
  repeatPeriodMs,
  onRepeatPeriodChange,
  initialPolicy,
  onInitialPolicyChange,
  repeatPolicy,
  onRepeatPolicyChange,
  roles,
  children,
}: {
  kind: "admin" | "spam";
  available: boolean;
  paidRestrictionsAvailable: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  repeatPeriodMs: number;
  onRepeatPeriodChange: (periodMs: number) => void;
  initialPolicy: MentionProtectionResponsePolicy;
  onInitialPolicyChange: (policy: MentionProtectionResponsePolicy) => void;
  repeatPolicy: MentionProtectionResponsePolicy;
  onRepeatPolicyChange: (policy: MentionProtectionResponsePolicy) => void;
  roles: Array<{ id: string; name: string }>;
  children: React.ReactNode;
}) {
  const title = kind === "admin" ? "Admin Mention Protection" : "Mention Spam Protection";
  const { dialog, confirm } = useConfirmDialog();

  async function applyPreset(preset: MentionProtectionPreset) {
    if (preset === "timeout-repeat" && !paidRestrictionsAvailable) return;
    const policies = mentionProtectionPreset(preset);
    const next = paidRestrictionsAvailable
      ? policies
      : {
          initial: { ...policies.initial, restriction: initialPolicy.restriction },
          repeat: { ...policies.repeat, restriction: repeatPolicy.restriction },
        };
    const replacing =
      JSON.stringify(initialPolicy) !== JSON.stringify(next.initial) ||
      JSON.stringify(repeatPolicy) !== JSON.stringify(next.repeat);
    if (
      replacing &&
      (hasPolicyAction(initialPolicy) || hasPolicyAction(repeatPolicy)) &&
      !(await confirm({
        title: "Replace the current response policies?",
        description:
          "This preset updates the current form only. Review the resulting first and repeat responses before saving.",
        confirmLabel: "Apply preset",
      }))
    )
      return;
    onInitialPolicyChange(next.initial);
    onRepeatPolicyChange(next.repeat);
  }

  return (
    <SettingsBlock>
      {dialog}
      <SectionHeader
        title={title}
        description={
          kind === "admin"
            ? "Respond to explicit mentions of protected role holders or protected roles."
            : "Respond to direct-user Mass Mention and Mention Burst conditions."
        }
        actions={
          <Switch
            checked={enabled}
            disabled={!available}
            onCheckedChange={onEnabledChange}
            aria-label={`Enable ${title}`}
          />
        }
      />
      {!available ? (
        <p className="border-t pt-4 text-xs text-muted-foreground">
          Mention Spam Protection requires a paid plan. Retained settings are dormant and resume
          after upgrading.
        </p>
      ) : null}
      {enabled ? (
        <fieldset disabled={!available} className="space-y-4 border-t pt-4">
          {children}
          <NumberField
            id={`mp-${kind}-repeat-period`}
            label="Repeat period (minutes)"
            value={Math.max(1, Math.round(repeatPeriodMs / 60_000))}
            min={1}
            max={30 * 24 * 60}
            onChange={(minutes) => onRepeatPeriodChange(minutes * 60_000)}
          />
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <p className="text-sm font-medium">Response presets</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["warn-only", "Warn only"],
                  ["warn-delete-repeat", "Warn, then delete on repeat"],
                  ["delete-immediately", "Delete immediately"],
                  ["timeout-repeat", "Escalate to timeout on repeat"],
                ] as const
              ).map(([preset, label]) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={preset === "timeout-repeat" && !paidRestrictionsAvailable}
                  onClick={() => void applyPreset(preset)}
                >
                  {label}
                  {preset === "timeout-repeat" ? " (paid)" : ""}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Presets update this form without saving.{" "}
              {paidRestrictionsAvailable
                ? "Every response control remains editable."
                : "On Free, retained paid restrictions stay unchanged."}
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <MentionProtectionPolicyFields
              idPrefix={`${kind}-initial`}
              label="Initial response"
              policy={initialPolicy}
              roles={roles}
              paidRestrictionsAvailable={paidRestrictionsAvailable}
              onChange={onInitialPolicyChange}
            />
            <MentionProtectionPolicyFields
              idPrefix={`${kind}-repeat`}
              label="Repeat response"
              policy={repeatPolicy}
              roles={roles}
              paidRestrictionsAvailable={paidRestrictionsAvailable}
              onChange={onRepeatPolicyChange}
            />
          </div>
          <MentionProtectionEffectiveResponse
            initialPolicy={initialPolicy}
            repeatPolicy={repeatPolicy}
            repeatPeriodMs={repeatPeriodMs}
            roles={roles}
            paidRestrictionsAvailable={paidRestrictionsAvailable}
          />
        </fieldset>
      ) : null}
    </SettingsBlock>
  );
}

type MentionProtectionPreset =
  | "warn-only"
  | "warn-delete-repeat"
  | "delete-immediately"
  | "timeout-repeat";

export function MentionProtectionEffectiveResponse({
  initialPolicy,
  repeatPolicy,
  repeatPeriodMs,
  roles,
  paidRestrictionsAvailable,
}: {
  initialPolicy: MentionProtectionResponsePolicy;
  repeatPolicy: MentionProtectionResponsePolicy;
  repeatPeriodMs: number;
  roles: Array<{ id: string; name: string }>;
  paidRestrictionsAvailable: boolean;
}) {
  const roleNames = new Map(roles.map((role) => [role.id, role.name]));
  const identical = areAdminActionSnapshotsEqual(
    {
      ...initialPolicy,
      restriction: paidRestrictionsAvailable ? initialPolicy.restriction : { type: "none" },
    },
    {
      ...repeatPolicy,
      restriction: paidRestrictionsAvailable ? repeatPolicy.restriction : { type: "none" },
    },
  );
  return (
    <section className="space-y-3 rounded-md border bg-background p-3">
      <div>
        <h3 className="text-sm font-medium">Effective response</h3>
        <p className="text-xs text-muted-foreground">
          What members experience under the current form values.
        </p>
      </div>
      <ol className="space-y-2 text-sm">
        <li className="rounded-md bg-muted/30 p-3">
          <span className="font-medium">1. First detection</span>
          <p>
            {describeMentionProtectionPolicy(initialPolicy, roleNames, paidRestrictionsAvailable)}
          </p>
        </li>
        <li className="rounded-md bg-muted/30 p-3">
          <span className="font-medium">
            2. Further detections within {humanDuration(repeatPeriodMs)}
          </span>
          <p>
            {describeMentionProtectionPolicy(repeatPolicy, roleNames, paidRestrictionsAvailable)}
          </p>
        </li>
      </ol>
      {identical ? (
        <p className="text-xs text-amber-300">
          Initial and repeat responses are identical on the current plan, so the repeat period does
          not change behaviour.
        </p>
      ) : null}
    </section>
  );
}

export function describeMentionProtectionPolicy(
  policy: MentionProtectionResponsePolicy,
  roleNames: ReadonlyMap<string, string>,
  paidRestrictionsAvailable: boolean,
): string {
  const actions: string[] = [];
  if (policy.reply) actions.push("reply with a warning");
  if (policy.delete) actions.push("delete the message");
  if (policy.restriction.type !== "none") {
    if (!paidRestrictionsAvailable) {
      actions.push("skip the retained paid restriction on the current plan");
    } else if (policy.restriction.type === "timeout") {
      actions.push(`apply a ${humanDuration(policy.restriction.durationMs)} Discord timeout`);
    } else {
      const role = roleNames.get(policy.restriction.roleId);
      actions.push(
        `assign ${
          role ? `@${role}` : `unavailable role ${policy.restriction.roleId}`
        } for ${humanDuration(policy.restriction.durationMs)}`,
      );
    }
  }
  if (actions.length === 0) return "No response configured.";
  const sentence = actions.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function humanDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function mentionProtectionPreset(preset: MentionProtectionPreset): {
  initial: MentionProtectionResponsePolicy;
  repeat: MentionProtectionResponsePolicy;
} {
  const warn: MentionProtectionResponsePolicy = {
    reply: true,
    delete: false,
    restriction: { type: "none" },
  };
  const remove: MentionProtectionResponsePolicy = {
    reply: false,
    delete: true,
    restriction: { type: "none" },
  };
  if (preset === "warn-only") return { initial: warn, repeat: warn };
  if (preset === "warn-delete-repeat") return { initial: warn, repeat: { ...warn, delete: true } };
  if (preset === "delete-immediately") return { initial: remove, repeat: remove };
  return {
    initial: warn,
    repeat: {
      reply: true,
      delete: true,
      restriction: { type: "timeout", durationMs: 10 * 60_000 },
    },
  };
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <FormField label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </FormField>
  );
}

export function normalizeMentionProtectionConfig(
  config?: MentionProtectionConfig | null,
): MentionProtectionConfigSnapshot {
  const defaults = createDefaultMentionProtectionConfig(config?.guildId ?? "preview", 0);
  const {
    guildId: _guildId,
    createdAtMs: _createdAtMs,
    updatedAtMs: _updatedAtMs,
    ...snapshot
  } = {
    ...defaults,
    ...config,
  };
  return snapshot;
}

export function hasMentionProtectionChanges(
  current: MentionProtectionConfigSnapshot,
  saved: MentionProtectionConfigSnapshot,
): boolean {
  return !areAdminActionSnapshotsEqual(current, saved);
}

export function validateMentionProtectionConfig(config: MentionProtectionConfigSnapshot) {
  return {
    protectedRoles:
      config.adminEnabled && config.protectedAdminRoleIds.length === 0
        ? "Choose at least one Protected Admin Role."
        : null,
    massThreshold:
      config.spamEnabled && (config.massMentionThreshold < 2 || config.massMentionThreshold > 50)
        ? "Mass Mention must be between 2 and 50 users."
        : null,
    burstThreshold:
      config.spamEnabled && (config.burstMessageThreshold < 2 || config.burstMessageThreshold > 20)
        ? "Mention Burst must be between 2 and 20 messages."
        : null,
    burstWindow:
      config.spamEnabled && (config.burstWindowSeconds < 5 || config.burstWindowSeconds > 300)
        ? "Burst window must be between 5 and 300 seconds."
        : null,
    policies:
      (config.adminEnabled &&
        (!hasPolicyAction(config.adminInitialResponse) ||
          !hasPolicyAction(config.adminRepeatResponse))) ||
      (config.spamEnabled &&
        (!hasPolicyAction(config.spamInitialResponse) ||
          !hasPolicyAction(config.spamRepeatResponse)))
        ? "Every enabled protection needs an initial and repeat response action."
        : null,
  };
}

function hasPolicyAction(policy: MentionProtectionResponsePolicy): boolean {
  return policy.reply || policy.delete || policy.restriction.type !== "none";
}

function configuredRoleIds(
  config: MentionProtectionConfigSnapshot,
  paidRestrictionsAvailable = true,
): string[] {
  const ids = new Set([...config.protectedAdminRoleIds, ...config.excludedRoleIds]);
  for (const policy of [
    config.adminInitialResponse,
    config.adminRepeatResponse,
    config.spamInitialResponse,
    config.spamRepeatResponse,
  ]) {
    if (
      paidRestrictionsAvailable &&
      policy.restriction.type === "timed-role" &&
      policy.restriction.roleId
    ) {
      ids.add(policy.restriction.roleId);
    }
  }
  return [...ids];
}

export function MentionProtectionPolicyFields({
  idPrefix,
  label,
  policy,
  roles,
  paidRestrictionsAvailable = true,
  onChange,
}: {
  idPrefix: string;
  label: string;
  policy: MentionProtectionResponsePolicy;
  roles: Array<{ id: string; name: string }>;
  paidRestrictionsAvailable?: boolean;
  onChange: (policy: MentionProtectionResponsePolicy) => void;
}) {
  const restrictionType = policy.restriction.type;
  return (
    <fieldset className="space-y-3 rounded-[4px] border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={policy.reply}
            onCheckedChange={(checked) => onChange({ ...policy, reply: checked === true })}
          />
          Reply with warning
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={policy.delete}
            onCheckedChange={(checked) => onChange({ ...policy, delete: checked === true })}
          />
          Delete message
        </label>
      </div>
      <FormField label="Restriction" htmlFor={`${idPrefix}-restriction`}>
        <Select
          value={restrictionType}
          disabled={!paidRestrictionsAvailable}
          onValueChange={(type) => {
            onChange({
              ...policy,
              restriction:
                type === "timeout"
                  ? { type, durationMs: 10 * 60 * 1_000 }
                  : type === "timed-role"
                    ? { type, roleId: roles[0]?.id ?? "", durationMs: 60 * 60 * 1_000 }
                    : { type: "none" },
            });
          }}
        >
          <SelectTrigger id={`${idPrefix}-restriction`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="timeout">Discord timeout</SelectItem>
            <SelectItem value="timed-role">Timed Role</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      {!paidRestrictionsAvailable ? (
        <p className="text-xs text-muted-foreground">
          Discord timeout and Timed Role restrictions require a paid plan. Retained restrictions are
          dormant on Free.
        </p>
      ) : null}
      {policy.restriction.type === "timeout" ? (
        <DurationField
          id={`${idPrefix}-timeout-duration`}
          label="Timeout duration (minutes)"
          durationMs={policy.restriction.durationMs}
          disabled={!paidRestrictionsAvailable}
          onChange={(durationMs) =>
            onChange({ ...policy, restriction: { type: "timeout", durationMs } })
          }
        />
      ) : null}
      {policy.restriction.type === "timed-role" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Restriction role" htmlFor={`${idPrefix}-role`}>
            <RoleSelect
              id={`${idPrefix}-role`}
              value={policy.restriction.roleId}
              roles={roles}
              disabled={!paidRestrictionsAvailable}
              onChange={(roleId) =>
                onChange({
                  ...policy,
                  restriction: {
                    type: "timed-role",
                    roleId,
                    durationMs:
                      policy.restriction.type === "timed-role"
                        ? policy.restriction.durationMs
                        : 60 * 60 * 1_000,
                  },
                })
              }
              placeholder="Select a role"
            />
          </FormField>
          <DurationField
            id={`${idPrefix}-timed-role-duration`}
            label="Duration (minutes)"
            durationMs={policy.restriction.durationMs}
            disabled={!paidRestrictionsAvailable}
            onChange={(durationMs) =>
              onChange({
                ...policy,
                restriction: {
                  type: "timed-role",
                  roleId: policy.restriction.type === "timed-role" ? policy.restriction.roleId : "",
                  durationMs,
                },
              })
            }
          />
        </div>
      ) : null}
    </fieldset>
  );
}

function DurationField({
  id,
  label,
  durationMs,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  durationMs: number;
  disabled?: boolean;
  onChange: (durationMs: number) => void;
}) {
  return (
    <FormField label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        min={1}
        disabled={disabled}
        value={Math.max(1, Math.round(durationMs / 60_000))}
        onChange={(event) => onChange(Number(event.currentTarget.value) * 60_000)}
      />
    </FormField>
  );
}
