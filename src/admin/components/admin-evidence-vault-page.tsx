import { ConfigurationAvailabilityActions } from "./configuration-availability-actions";
import { useState } from "react";

import type { EvidenceFieldDefinition, EvidenceFieldType } from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import { AdvancedSection, FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { useAutoSaveToggle } from "../hooks/use-auto-save-toggle";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import {
  adminRefreshWarning,
  reconcileAdminMutation,
  refreshAdminRouteData,
} from "../lib/mutation-reconciliation";
import type { EvidenceVaultLoaderData } from "../lib/admin-route-loaders";

type EvidenceVaultAutoSaveKey = "subjectsEnabled";

export function AdminEvidenceVaultPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement: EntitlementInfo | null;
  initialData?: EvidenceVaultLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-data space-y-6">
      <AdminPageHeader
        title="Evidence Vault"
        description="Configure evidence audit storage and delegated access roles for this guild."
        readinessFeature="evidence-vault"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Evidence Vault" />
      ) : (
        <EvidenceVaultEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          entitlement={entitlement}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function EvidenceVaultEditor({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement: EntitlementInfo | null;
  initialData?: EvidenceVaultLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [auditChannelId, setAuditChannelId] = useState(initialData?.config?.auditChannelId ?? "");
  const [accessRoleIds, setAccessRoleIds] = useState(initialData?.config?.accessRoleIds ?? []);
  const [subjectsEnabled, setSubjectsEnabled] = useState(
    initialData?.config?.subjectsEnabled ?? false,
  );
  const [evidenceFields, setEvidenceFields] = useState<EvidenceFieldDefinition[]>(
    initialData?.config?.evidenceFields ?? [],
  );
  const [enumValueDrafts, setEnumValueDrafts] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(initialData?.config?.enabled !== false);
  const [saved, setSaved] = useState(false);
  const [savedConfig, setSavedConfig] = useState(() => ({
    auditChannelId: initialData?.config?.auditChannelId ?? "",
    accessRoleIds: initialData?.config?.accessRoleIds ?? [],
    subjectsEnabled: initialData?.config?.subjectsEnabled ?? false,
    evidenceFields: initialData?.config?.evidenceFields ?? [],
  }));
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const api = useAdminApi();
  const toast = useToast();
  const autoSave = useAutoSaveToggle<EvidenceVaultAutoSaveKey>({
    onSave: async (_key, nextValue) => {
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        () =>
          createAdminLoaderClient().postJson(
            "/admin/api/evidence-vault/config",
            {
              auditChannelId: auditChannelId.trim(),
              accessRoleIds,
              subjectsEnabled: nextValue,
              evidenceFields,
            },
            { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
          ),
        onRouteDataRefresh,
      );
      setSavedConfig((current) => ({ ...current, subjectsEnabled: nextValue }));
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Evidence Vault preference save", nextRefreshError));
      } else setRefreshError(null);
    },
  });
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const enumValueUsage = initialData?.enumValueUsage ?? {};
  const recordUsage = initialData?.recordUsage ?? {
    used: 0,
    max: entitlement?.limits.evidenceVaultMaxRecords ?? null,
  };
  const nearingRecordLimit =
    typeof recordUsage.max === "number" && recordUsage.used >= recordUsage.max - 5;

  const savedConfigSnapshot = {
    auditChannelId: savedConfig.auditChannelId,
    accessRoleIds: savedConfig.accessRoleIds,
    subjectsEnabled: savedConfig.subjectsEnabled,
    evidenceFields: savedConfig.evidenceFields ?? [],
  };
  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(
    { auditChannelId, accessRoleIds, subjectsEnabled, evidenceFields },
    savedConfigSnapshot,
  );
  const savedSuccessfully = !hasUnsavedChanges && saved;

  function discardChanges() {
    setAuditChannelId(savedConfig.auditChannelId);
    setAccessRoleIds(savedConfig.accessRoleIds);
    setSubjectsEnabled(savedConfig.subjectsEnabled);
    setEvidenceFields(savedConfig.evidenceFields ?? []);
    setSaved(false);
    setSaveAttempted(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Evidence Vault changes?",
      description: "This restores the last saved Evidence Vault settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    setSaved(false);
    setSaveAttempted(true);
    api.setError(null);
    if (!auditChannelId.trim()) {
      api.setError("Evidence Vault audit channel is required.");
      return;
    }
    const nextEvidenceFields = evidenceFields.map(normalizeEvidenceFieldForSave);
    const validationError = validateEvidenceFields(nextEvidenceFields);
    setFieldError(validationError);
    if (validationError) return;
    const removedEnumValues = buildRemovedEvidenceFieldEnumValueWarnings(
      savedConfig.evidenceFields ?? [],
      nextEvidenceFields,
      enumValueUsage,
    );
    if (removedEnumValues.length > 0) {
      const confirmed = await confirm({
        title: "Remove enum values?",
        description:
          "Records with removed enum values keep their archived metadata, but those values stop matching the current Evidence Field definition.",
        confirmLabel: "Remove values",
        variant: "destructive",
        children: (
          <ul className="space-y-1">
            {removedEnumValues.map((entry) => (
              <li key={`${entry.fieldKey}:${entry.value}`}>
                <span className="font-medium">{entry.fieldLabel}</span>: {entry.value} (
                {entry.count} {entry.count === 1 ? "record" : "records"})
              </li>
            ))}
          </ul>
        ),
      });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/evidence-vault/config",
        {
          auditChannelId: auditChannelId.trim(),
          accessRoleIds,
          subjectsEnabled,
          evidenceFields: nextEvidenceFields,
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      setSavedConfig({
        auditChannelId: auditChannelId.trim(),
        accessRoleIds,
        subjectsEnabled,
        evidenceFields: nextEvidenceFields,
      });
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        async () => undefined,
        onRouteDataRefresh,
      );
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Evidence Vault configuration save", nextRefreshError));
      } else setRefreshError(null);
      toast.success("Saved Evidence Vault configuration.");
      setSaved(true);
      setSaveAttempted(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Evidence Vault.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      <AdminRefreshNotice
        action="Evidence Vault"
        error={refreshError}
        refresh={onRouteDataRefresh}
      />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <div className="rounded-md border bg-card p-4 text-sm">
        <p className="font-medium text-foreground">
          {typeof recordUsage.max === "number"
            ? `${recordUsage.used} / ${recordUsage.max} Evidence Vault records used`
            : `${recordUsage.used} Evidence Vault records · No plan limit`}
        </p>
        {nearingRecordLimit ? (
          <p className="mt-1 text-muted-foreground">
            {recordUsage.used >= (recordUsage.max ?? 0)
              ? "The Free record limit has been reached. Existing evidence remains available, but new evidence cannot be hidden until usage falls below the limit."
              : "You are nearing the Free record limit."}{" "}
            {entitlement?.supportInvite ? (
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={entitlement.supportInvite}
              >
                Upgrade for no plan limit.
              </a>
            ) : (
              "Upgrade for no plan limit."
            )}
          </p>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Evidence Vault is an access-control safeguard for sensitive staff evidence, with optional
        audit logging. It is not a Moderation feature and does not enforce penalties.
      </p>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Ban Cases</span> auto-create forum threads
        when game-server ban webhooks arrive.{" "}
        <a
          href={`/admin/${selectedGuildId}/ban-cases`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Configure Ban Cases →
        </a>
      </p>

      <SettingsBlock>
        <SectionHeader
          title="Evidence Vault configuration"
          actions={
            savedConfig.auditChannelId ? (
              <ConfigurationAvailabilityActions
                label="Evidence Vault"
                enabled={enabled}
                disabled={saving || api.loading || hasUnsavedChanges}
                description="New evidence captures will stop. Existing evidence remains accessible to authorised staff, with its access controls and audit logging."
                onEnabledChange={async (next) => {
                  await api.run(
                    async () => {
                      await createAdminLoaderClient().postJson(
                        "/admin/api/evidence-vault/enabled",
                        { enabled: next },
                        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
                      );
                      await refreshAdminRouteData(onRouteDataRefresh);
                    },
                    () => {
                      setEnabled(next);
                      toast.success(`Evidence Vault ${next ? "enabled" : "disabled"}.`);
                    },
                  );
                }}
              />
            ) : undefined
          }
          description="Choose where hidden evidence is logged and who can hide or view evidence from Discord."
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="Audit channel"
            htmlFor="ev-audit-channel"
            required
            hint="Every hidden evidence action is posted here so staff can audit who hid or viewed evidence."
            error={
              saveAttempted && !auditChannelId.trim()
                ? "Select the Discord channel where Evidence Vault audit messages should be posted."
                : undefined
            }
          >
            <ChannelSelect
              id="ev-audit-channel"
              channels={resources?.textChannels ?? []}
              value={auditChannelId}
              onChange={setAuditChannelId}
              placeholder="Select an audit channel"
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "evidence_vault",
                dependencyKey: "audit_channel",
                label: "audit channel",
                recommendedName: "evidence-vault",
                accessRoleIds,
              }}
            />
          </FormField>
          <FormField
            label="Access roles"
            htmlFor="ev-access-roles"
            hint="Members with any selected role can hide and view Evidence Vault items. Server administrators always have access."
          >
            <MultiRoleSelect
              id="ev-access-roles"
              roles={resources?.roles ?? []}
              value={accessRoleIds}
              onChange={setAccessRoleIds}
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "evidence_vault",
                dependencyKey: "access_role",
                label: "access role",
                recommendedName: "Evidence Vault Access",
                accessChannelIds: auditChannelId ? [auditChannelId] : [],
              }}
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          The bot needs permission to read, delete, and repost messages in source channels.
        </p>
        <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
          <div className="mt-1">
            <Switch
              checked={subjectsEnabled}
              loading={autoSave.savingKey === "subjectsEnabled"}
              success={autoSave.savedKey === "subjectsEnabled"}
              onCheckedChange={(checked) =>
                void autoSave.saveToggle({
                  key: "subjectsEnabled",
                  nextValue: checked,
                  previousValue: subjectsEnabled,
                  applyValue: setSubjectsEnabled,
                  hasUnrelatedChanges: hasUnsavedChanges,
                  successMessage: "Saved Evidence Vault subjects preference.",
                })
              }
              aria-label="Enable Evidence Vault subjects"
            />
          </div>
          <span>
            <span className="block font-medium">Enable Evidence Vault subjects</span>
            <span className="text-muted-foreground">
              Scan newly hidden evidence for Discord, Steam, Xbox, and CFTools identifiers so staff
              can search or amend evidence later. Existing records are not backfilled.
            </span>
          </span>
        </div>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Evidence Fields"
          description="Define up to five structured fields staff can add to hidden evidence records."
        />
        <div className="space-y-3">
          {evidenceFields.map((field, index) => (
            <div key={field.key} className="space-y-4 rounded-md border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">Field {index + 1}</h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={index === 0}
                    aria-label={`Move ${field.label || `field ${index + 1}`} up`}
                    onClick={() => moveEvidenceField(index, -1)}
                  >
                    Move up
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={index === evidenceFields.length - 1}
                    aria-label={`Move ${field.label || `field ${index + 1}`} down`}
                    onClick={() => moveEvidenceField(index, 1)}
                  >
                    Move down
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void removeEvidenceField(index)}
                  >
                    Remove field
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_11rem]">
                <FormField label="Label" htmlFor={`ev-field-label-${field.key}`}>
                  <Input
                    id={`ev-field-label-${field.key}`}
                    value={field.label}
                    onChange={(event) =>
                      updateEvidenceField(index, { label: event.currentTarget.value })
                    }
                  />
                </FormField>
                <FormField label="Type" htmlFor={`ev-field-type-${field.key}`}>
                  <Select
                    value={field.type}
                    onValueChange={(value) =>
                      void changeEvidenceFieldType(index, value as EvidenceFieldType)
                    }
                  >
                    <SelectTrigger id={`ev-field-type-${field.key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="short_text">Short text</SelectItem>
                      <SelectItem value="text">Long text</SelectItem>
                      <SelectItem value="enum">Choice list</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
              {field.type === "enum" ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Allowed choices</p>
                  {(field.allowedValues ?? []).map((value, valueIndex) => {
                    const usageCount = enumValueUsage[field.key]?.[value] ?? 0;
                    return (
                      <div
                        key={`${field.key}:${valueIndex}`}
                        className="flex min-w-0 flex-wrap items-center gap-2"
                      >
                        <Input
                          className="min-w-48 flex-1"
                          value={value}
                          aria-label={`${field.label || `Field ${index + 1}`} choice ${valueIndex + 1}`}
                          onChange={(event) =>
                            renameEnumValue(index, valueIndex, event.currentTarget.value)
                          }
                        />
                        {usageCount > 0 ? (
                          <Badge variant="info">
                            {usageCount} {usageCount === 1 ? "record" : "records"}
                          </Badge>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => removeEnumValue(index, valueIndex)}
                        >
                          Remove choice
                        </Button>
                      </div>
                    );
                  })}
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Input
                      className="min-w-48 flex-1"
                      value={enumValueDrafts[field.key] ?? ""}
                      placeholder="Add a choice"
                      aria-label={`New choice for ${field.label || `field ${index + 1}`}`}
                      onChange={(event) =>
                        setEnumValueDrafts((current) => ({
                          ...current,
                          [field.key]: event.currentTarget.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addEnumValue(index);
                      }}
                    />
                    <Button type="button" variant="outline" onClick={() => addEnumValue(index)}>
                      Add choice
                    </Button>
                  </div>
                </div>
              ) : null}
              <AdvancedSection
                title="Advanced"
                description="The stable field key is retained in archived record metadata."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 text-xs">{field.key}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void navigator.clipboard?.writeText(field.key)}
                  >
                    Copy key
                  </Button>
                </div>
              </AdvancedSection>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={evidenceFields.length >= 5}
            onClick={() =>
              setEvidenceFields((current) => [
                ...current,
                {
                  key: `field_${Date.now().toString(36)}`,
                  label: "",
                  type: "short_text",
                },
              ])
            }
          >
            Add field
          </Button>
          {fieldError ? <p className="text-sm text-destructive">{fieldError}</p> : null}
        </div>
      </SettingsBlock>

      {evidenceFields.length > 0 ? (
        <SettingsBlock>
          <SectionHeader
            title="Staff preview"
            description="This is the order staff will see when hiding evidence."
          />
          <ol className="space-y-2">
            {evidenceFields.map((field, index) => (
              <li key={field.key} className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
                <span className="font-medium">
                  {index + 1}. {field.label.trim() || "Untitled field"}
                </span>
                <span className="ml-2 text-muted-foreground">
                  {field.type === "enum"
                    ? `${field.allowedValues?.length ?? 0} choices`
                    : field.type === "text"
                      ? "Long text"
                      : "Short text"}
                </span>
              </li>
            ))}
          </ol>
        </SettingsBlock>
      ) : null}

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

  function updateEvidenceField(index: number, patch: Partial<EvidenceFieldDefinition>) {
    setEvidenceFields((current) =>
      current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)),
    );
  }

  function moveEvidenceField(index: number, direction: -1 | 1) {
    setEvidenceFields((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function addEnumValue(fieldIndex: number) {
    const field = evidenceFields[fieldIndex];
    if (!field) return;
    const nextValue = (enumValueDrafts[field.key] ?? "").trim();
    if (!nextValue) {
      setFieldError("Choice values cannot be blank.");
      return;
    }
    if (
      (field.allowedValues ?? []).some(
        (value) => value.trim().toLowerCase() === nextValue.toLowerCase(),
      )
    ) {
      setFieldError(`"${nextValue}" is already a choice for ${field.label || "this field"}.`);
      return;
    }
    updateEvidenceField(fieldIndex, {
      allowedValues: [...(field.allowedValues ?? []), nextValue],
    });
    setEnumValueDrafts((current) => ({ ...current, [field.key]: "" }));
    setFieldError(null);
  }

  function renameEnumValue(fieldIndex: number, valueIndex: number, nextValue: string) {
    const field = evidenceFields[fieldIndex];
    if (!field) return;
    const values = [...(field.allowedValues ?? [])];
    values[valueIndex] = nextValue;
    updateEvidenceField(fieldIndex, { allowedValues: values });
    setFieldError(null);
  }

  function removeEnumValue(fieldIndex: number, valueIndex: number) {
    const field = evidenceFields[fieldIndex];
    if (!field) return;
    updateEvidenceField(fieldIndex, {
      allowedValues: (field.allowedValues ?? []).filter((_, index) => index !== valueIndex),
    });
  }

  async function changeEvidenceFieldType(index: number, nextType: EvidenceFieldType) {
    const field = evidenceFields[index];
    if (!field || field.type === nextType) return;
    const savedField = (savedConfig.evidenceFields ?? []).find((entry) => entry.key === field.key);
    const hasSavedEnumData =
      savedField?.type === "enum" &&
      ((savedField.allowedValues?.length ?? 0) > 0 ||
        Object.values(enumValueUsage[field.key] ?? {}).some((count) => count > 0));
    if (field.type === "enum" && hasSavedEnumData) {
      const confirmed = await confirm({
        title: `Change ${field.label || "this field"} to another type?`,
        description:
          "Archived records retain their field metadata, but saved choice values stop matching the current definition.",
        confirmLabel: "Change type",
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    updateEvidenceField(index, {
      type: nextType,
      allowedValues: nextType === "enum" ? (field.allowedValues ?? []) : undefined,
    });
  }

  async function removeEvidenceField(index: number) {
    const field = evidenceFields[index];
    if (!field) return;
    const isSaved = (savedConfig.evidenceFields ?? []).some((entry) => entry.key === field.key);
    if (isSaved) {
      const usageCount = Object.values(enumValueUsage[field.key] ?? {}).reduce(
        (total, count) => total + count,
        0,
      );
      const confirmed = await confirm({
        title: `Remove ${field.label || "this Evidence Field"}?`,
        description:
          "The field is removed from the current definition. Archived records retain the field key, label, and recorded value.",
        confirmLabel: "Remove field",
        variant: "destructive",
        children:
          usageCount > 0 ? (
            <p>
              {usageCount} archived {usageCount === 1 ? "record uses" : "records use"} its saved
              choices.
            </p>
          ) : undefined,
      });
      if (!confirmed) return;
    }
    setEvidenceFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index));
  }
}

function normalizeEvidenceFieldForSave(field: EvidenceFieldDefinition): EvidenceFieldDefinition {
  const allowedValues =
    field.type === "enum"
      ? (field.allowedValues ?? []).map((value) => value.trim()).filter(Boolean)
      : undefined;
  return {
    key: field.key,
    label: field.label.trim(),
    type: field.type,
    ...(allowedValues ? { allowedValues } : {}),
  };
}

export function validateEvidenceFields(fields: EvidenceFieldDefinition[]): string | null {
  const labels = new Set<string>();
  for (const field of fields) {
    const label = field.label.trim();
    if (!label) return "Every Evidence Field needs a label.";
    const normalizedLabel = label.toLowerCase();
    if (labels.has(normalizedLabel)) return `Evidence Field labels must be unique: "${label}".`;
    labels.add(normalizedLabel);
    if (field.type !== "enum") continue;
    const values = field.allowedValues ?? [];
    if (values.length === 0) return `${label} needs at least one choice.`;
    const normalizedValues = new Set<string>();
    for (const value of values) {
      const normalizedValue = value.trim().toLowerCase();
      if (!normalizedValue) return `${label} contains a blank choice.`;
      if (normalizedValues.has(normalizedValue))
        return `${label} contains a duplicate choice: "${value.trim()}".`;
      normalizedValues.add(normalizedValue);
    }
  }
  return null;
}

export interface RemovedEvidenceFieldEnumValueWarning {
  fieldKey: string;
  fieldLabel: string;
  value: string;
  count: number;
}

export function buildRemovedEvidenceFieldEnumValueWarnings(
  savedFields: EvidenceFieldDefinition[],
  nextFields: EvidenceFieldDefinition[],
  usage: Record<string, Record<string, number>>,
): RemovedEvidenceFieldEnumValueWarning[] {
  const nextByKey = new Map(nextFields.map((field) => [field.key, field]));
  const warnings: RemovedEvidenceFieldEnumValueWarning[] = [];
  for (const savedField of savedFields) {
    if (savedField.type !== "enum") continue;
    const nextField = nextByKey.get(savedField.key);
    const nextValues = new Set(
      nextField?.type === "enum"
        ? (nextField.allowedValues ?? []).map((value) => value.trim().toLowerCase())
        : [],
    );
    for (const value of savedField.allowedValues ?? []) {
      const trimmed = value.trim();
      if (!trimmed || nextValues.has(trimmed.toLowerCase())) continue;
      warnings.push({
        fieldKey: savedField.key,
        fieldLabel: savedField.label,
        value: trimmed,
        count: usage[savedField.key]?.[trimmed] ?? 0,
      });
    }
  }
  return warnings;
}
