import { useRef, useState } from "react";

import type { Clan, ClanManagementConfig, ClanRequest } from "../../clans";
import type {
  FeatureSetupState,
  SetupDependencyPreview,
  SetupPreview,
  SetupResourceChoice,
  SetupRun,
} from "../../feature-setup";
import type { ClansLoaderData } from "../lib/admin-route-loaders";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { readResponseError } from "../lib/api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { AdminPageHeader } from "./admin-page-header";
import { areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { AdvancedSection, FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { ChannelSelect, MultiRoleSelect, RoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ColorInput } from "./ui/color-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { copyTextToClipboard } from "../lib/clipboard";
import { useToast } from "./toast";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";

export function AdminClansPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: ClansLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const guildId = selectedGuildId.trim();
  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Clan Management"
        description="Configure HAF-managed Clan resources, review creation requests, and monitor Clan lifecycle state."
        actions={<Badge variant="info">Beta</Badge>}
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      <div className="rounded-md border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
        <span className="font-semibold">Clan Management is in beta.</span> We would love to hear
        what works and what needs improving. Share your feedback in the{" "}
        <a
          className="font-semibold underline underline-offset-4"
          href="https://discord.gg/HpRPkdm6dv"
          target="_blank"
          rel="noreferrer"
        >
          HAF Bot Discord
        </a>
        .
      </div>
      {!guildId ? (
        <NoGuildSelected feature="Clan Management" />
      ) : initialData ? (
        <ClanManagementEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={guildId}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Clan Management could not be loaded.</p>
      )}
    </section>
  );
}

function ClanManagementEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData: ClansLoaderData;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [config, setConfigState] = useState(initialData.config);
  const configRef = useRef(initialData.config);
  const [savedConfig, setSavedConfig] = useState(initialData.config);
  const savedConfigRef = useRef(initialData.config);
  const [requests, setRequests] = useState(initialData.requests);
  const [clans, setClans] = useState(initialData.clans);
  const [saving, setSaving] = useState(false);
  const [refreshingRoute, setRefreshingRoute] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupState, setSetupState] = useState(initialData.setup);
  const [setupPreview, setSetupPreview] = useState<SetupPreview | null>(null);
  const [setupChoices, setSetupChoices] = useState<Record<string, SetupResourceChoice>>(() =>
    initialSetupChoices(initialData),
  );
  const [publishing, setPublishing] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ClanRequest | null>(null);
  const [reviewDecision, setReviewDecision] = useState<ReviewDecision>("approve");
  const [reviewReason, setReviewReason] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { resources, refresh: refreshResources } = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
  );
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(config, savedConfig);
  const configBusy = saving || publishing || settingUp;

  function setConfig(next: ClanManagementConfig) {
    configRef.current = next;
    setConfigState(next);
  }

  async function refreshRouteData() {
    // Route invalidation remounts this editor. Local responses already reconcile its data.
    if (
      !onRouteDataRefresh ||
      !areAdminActionSnapshotsEqual(configRef.current, savedConfigRef.current)
    )
      return;
    setRefreshingRoute(true);
    try {
      await refreshAdminRouteData(onRouteDataRefresh);
    } finally {
      setRefreshingRoute(false);
    }
  }

  function acceptSavedConfig(next: ClanManagementConfig, baseline = savedConfigRef.current) {
    // A review refresh can finish after a newer configuration save.
    if (next.updatedAtMs < savedConfigRef.current.updatedAtMs) return;
    const current = configRef.current;
    const merged = { ...next };
    // Only replace fields that have not been edited since this operation's baseline.
    for (const key of Object.keys(current) as Array<keyof ClanManagementConfig>) {
      if (key === "updatedAtMs") continue;
      if (!areAdminActionSnapshotsEqual(current[key], baseline[key])) {
        Object.assign(merged, { [key]: current[key] });
      }
    }
    savedConfigRef.current = next;
    setSavedConfig(next);
    setConfig(merged);
  }

  function discardChanges() {
    setConfig(savedConfigRef.current);
    setError(null);
    setMessage(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Clan settings changes?",
      description: "This restores the last saved Clan Management settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    const submittedConfig = config;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/admin/api/clans/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, workspaceId: selectedWorkspaceId }),
      });
      if (!response.ok) throw new Error(await readResponseError(response, "Could not save Clans."));
      const body = (await response.json()) as { config: ClanManagementConfig };
      acceptSavedConfig(body.config, submittedConfig);
      setSetupState((current) =>
        current
          ? {
              ...current,
              readiness:
                current.readiness === "ready_disabled" || current.readiness === "enabled"
                  ? body.config.enabled
                    ? "enabled"
                    : "ready_disabled"
                  : current.readiness,
            }
          : current,
      );
      toast.success("Clan Management settings saved.");
      await refreshRouteData();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not save Clan Management settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function previewSetup() {
    setSettingUp(true);
    setError(null);
    setMessage(null);
    try {
      const body = await createAdminLoaderClient().postJson<{ preview: SetupPreview }>(
        "/admin/api/clans/setup/preview",
        { choices: setupChoices },
        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
      );
      setSetupPreview(body.preview);
      setMessage("Review the setup plan, then confirm it to create or reuse these resources.");
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not preview Clan resource setup.",
      );
    } finally {
      setSettingUp(false);
    }
  }

  async function executeSetup() {
    setSettingUp(true);
    setError(null);
    setMessage(null);
    try {
      const body = await createAdminLoaderClient().postJson<{
        config: ClanManagementConfig;
        run: SetupRun;
        setup: FeatureSetupState;
      }>(
        "/admin/api/clans/setup/execute",
        { choices: setupChoices, confirmationId: setupPreview?.confirmationId },
        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
      );
      if (body.config) acceptSavedConfig(body.config);
      setSetupState(body.setup);
      setSetupPreview(null);
      setSetupChoices(
        body.run.status === "completed" ? choicesFromRun(body.run) : body.run.choices,
      );
      await refreshResources();
      if (body.run.status === "completed") {
        setMessage(
          "Clan feature resources are ready. Review the configuration before enabling it.",
        );
        toast.success("Clan feature resources are ready.");
      } else {
        const setupError = `Setup stopped at ${body.run.failureDependencyKey ?? "an unknown step"}: ${body.run.failureMessage ?? "Discord setup failed."}`;
        setError(setupError);
        toast.error(setupError);
      }
      await refreshRouteData();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not set up Clan resources.");
    } finally {
      setSettingUp(false);
    }
  }

  function changeSetupChoice(key: string, choice: SetupResourceChoice) {
    setSetupChoices((current) => ({ ...current, [key]: choice }));
    setSetupPreview(null);
  }

  async function publishPanel() {
    const submittedConfig = config;
    setPublishing(true);
    setError(null);
    setMessage(null);
    try {
      const saveResponse = await fetch("/admin/api/clans/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, workspaceId: selectedWorkspaceId }),
      });
      if (!saveResponse.ok)
        throw new Error(await readResponseError(saveResponse, "Could not save the Clan panel."));
      const saved = (await saveResponse.json()) as { config: ClanManagementConfig };
      acceptSavedConfig(saved.config, submittedConfig);
      const published = await createAdminLoaderClient().postJson<{
        config: ClanManagementConfig;
      }>(
        "/admin/api/clans/panel/publish",
        {},
        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
      );
      acceptSavedConfig(published.config);
      toast.success("Clan creation panel published.");
      if (!saved.config.requestPanelChannelId) throw new Error("Choose a panel channel first.");
      await refreshRouteData();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not publish the Clan panel.");
    } finally {
      setPublishing(false);
    }
  }

  function openReview(request: ClanRequest, trigger: HTMLButtonElement) {
    reviewTriggerRef.current = trigger;
    setReviewRequest(request);
    setReviewDecision("approve");
    setReviewReason("");
    setReviewError(null);
  }

  function closeReview() {
    if (reviewingId) return;
    const trigger = reviewTriggerRef.current;
    setReviewRequest(null);
    setReviewError(null);
    queueMicrotask(() => trigger?.focus());
  }

  async function submitReview() {
    const request = reviewRequest;
    if (!request) return;
    const trimmedReason = reviewReason.trim();
    const reasonError = validateReviewReason(reviewDecision, trimmedReason);
    if (reasonError) {
      setReviewError(reasonError);
      return;
    }
    setReviewingId(request.id);
    setError(null);
    setReviewError(null);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/clans/requests/review",
        {
          requestId: request.id,
          expectedRevision: request.revision,
          decision: reviewDecision,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        },
        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
      );
      const refreshed = await createAdminLoaderClient().getJson<ClansLoaderData>(
        "/admin/api/clans",
        { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
      );
      setRequests(refreshed.requests);
      setClans(refreshed.clans);
      acceptSavedConfig(refreshed.config);
      toast.success(`Clan request ${reviewDecision === "approve" ? "approved" : "updated"}.`);
      setReviewRequest(null);
      queueMicrotask(() => reviewTriggerRef.current?.focus());
      await refreshRouteData();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not review the Clan request.";
      if (/revision|changed|stale|conflict/i.test(message)) {
        try {
          const latest = await createAdminLoaderClient().getJson<ClansLoaderData>(
            "/admin/api/clans",
            { guildId: selectedGuildId, workspaceId: selectedWorkspaceId },
          );
          setRequests(latest.requests);
          setClans(latest.clans);
          acceptSavedConfig(latest.config);
          const latestRequest = latest.requests.find((item) => item.id === request.id);
          if (latestRequest) setReviewRequest(latestRequest);
        } catch {
          // Keep the original request visible when refreshing the latest revision is unavailable.
        }
        setReviewError(
          "This request changed while you were reviewing it. The latest revision is shown; verify it before submitting. Your entered reason is still here.",
        );
      } else {
        setReviewError(message);
      }
    } finally {
      setReviewingId(null);
    }
  }

  const requestColumns: ResponsiveTableColumn<ClanRequest>[] = [
    { header: "Clan", cell: (request) => `${request.name} [${request.tag}]` },
    { header: "Requester ID", cell: (request) => request.requesterId },
    { header: "Status", cell: (request) => request.status.replaceAll("-", " ") },
    { header: "Revision", cell: (request) => request.revision },
    {
      header: "Actions",
      cell: (request) =>
        request.status === "pending" || request.status === "changes-requested" ? (
          <Button
            size="sm"
            variant="outline"
            loading={reviewingId === request.id}
            disabled={reviewingId !== null && reviewingId !== request.id}
            ref={(element) => {
              if (reviewRequest?.id === request.id) reviewTriggerRef.current = element;
            }}
            onClick={(event) => openReview(request, event.currentTarget)}
          >
            Review request
          </Button>
        ) : (
          <span className="text-muted-foreground">Reviewed</span>
        ),
    },
  ];
  const clanColumns: ResponsiveTableColumn<Clan>[] = [
    { header: "Clan", cell: (clan) => `${clan.name} [${clan.tag}]` },
    { header: "Lifecycle", cell: (clan) => clan.lifecycleState.replaceAll("-", " ") },
    { header: "Recruitment", cell: (clan) => clan.recruitmentState.replaceAll("-", " ") },
    { header: "Discord role", cell: (clan) => clan.roleId ?? "Not provisioned" },
  ];

  const setupNeedsAttention =
    !setupState ||
    setupState.readiness === "not_setup" ||
    setupState.readiness === "setup_incomplete";
  const setupReady =
    setupState?.readiness === "ready_disabled" || setupState?.readiness === "enabled";
  const setupRun = setupState?.run;
  const retainedResources = setupRun?.resolutions ?? [];

  const setupSummary = setupNeedsAttention ? (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
      <p className="font-semibold">
        Complete these four Discord dependencies before configuring Clan Management.
      </p>
      <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        {[
          ["Managed Clan category", "managed_category"],
          ["Clan creation panel channel", "panel_channel"],
          ["Request-review category", "review_category"],
          ["Clan Reviewer role", "reviewer_role"],
        ].map(([label, key]) => {
          const resolution = retainedResources.find((item) => item.dependencyKey === key);
          const failed = setupRun?.failureDependencyKey === key;
          return (
            <li key={key} className="flex items-center justify-between gap-2">
              <span>{label}</span>
              <Badge variant={failed ? "danger" : resolution ? "success" : "warning"}>
                {failed ? "Failed" : resolution ? "Retained" : "Pending"}
              </Badge>
            </li>
          );
        })}
      </ul>
      {setupRun?.failureMessage ? (
        <p className="mt-2 text-xs text-red-200">{setupRun.failureMessage}</p>
      ) : null}
    </div>
  ) : (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
      <p className="font-semibold">Discord resources are ready.</p>
      <p className="mt-1 text-xs">
        Review or repair them any time without changing Clan ownership or lifecycle rules.
      </p>
    </div>
  );

  const setupBlock = (
    <SettingsBlock
      className={setupNeedsAttention ? "border-amber-500/50 ring-1 ring-amber-500/20" : undefined}
    >
      <SectionHeader
        title={
          setupNeedsAttention
            ? "Start with Feature Resource Setup"
            : "Review or repair Discord resources"
        }
        description="Choose an existing Discord resource or ask HAF to create the recommended resource for each dependency. Created reviewer and panel resources remain administrator-owned; the managed Clan category remains feature-owned."
        actions={
          <Badge variant={setupReadinessVariant(setupState)}>
            {setupReadinessLabel(setupState)}
          </Badge>
        }
      />
      {setupSummary}
      <div className="grid gap-4 md:grid-cols-2">
        <SetupDependencyChoice
          dependencyKey="managed_category"
          label="Managed Clan category"
          choice={setupChoices.managed_category}
          reuseOptions={resources?.categories ?? []}
          resourceKind="channel"
          onChange={changeSetupChoice}
        />
        <SetupDependencyChoice
          dependencyKey="panel_channel"
          label="Clan creation panel channel"
          choice={setupChoices.panel_channel}
          reuseOptions={resources?.textChannels ?? []}
          resourceKind="channel"
          onChange={changeSetupChoice}
        />
        <SetupDependencyChoice
          dependencyKey="review_category"
          label="Request-review category"
          choice={setupChoices.review_category}
          reuseOptions={resources?.categories ?? []}
          resourceKind="channel"
          onChange={changeSetupChoice}
        />
        <SetupDependencyChoice
          dependencyKey="reviewer_role"
          label="Clan Reviewer role"
          choice={setupChoices.reviewer_role}
          reuseOptions={resources?.roles ?? []}
          resourceKind="role"
          onChange={changeSetupChoice}
        />
      </div>
      {setupPreview ? (
        <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
          <p className="font-display text-sm font-semibold uppercase tracking-wide">
            Confirm setup plan
          </p>
          <ul className="space-y-3">
            {setupPreview.dependencies.map((dependency) => (
              <SetupPreviewItem key={dependency.key} dependency={dependency} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Successful resources are retained if a later step fails. Reopening this page lets you
            resume the same Setup Run.
          </p>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        {setupPreview ? (
          <Button variant="outline" onClick={() => setSetupPreview(null)}>
            Change choices
          </Button>
        ) : null}
        <Button
          loading={settingUp}
          disabled={configBusy}
          loadingLabel={setupPreview ? "Running setup…" : "Checking setup…"}
          onClick={() => void (setupPreview ? executeSetup() : previewSetup())}
        >
          {setupPreview
            ? "Confirm and run setup"
            : setupState?.readiness === "setup_incomplete"
              ? "Review and resume setup"
              : setupState?.readiness === "not_setup" || !setupState
                ? "Review setup plan"
                : "Review repair plan"}
        </Button>
      </div>
    </SettingsBlock>
  );

  const panelBlock = (
    <div className={setupNeedsAttention ? "space-y-5 opacity-80" : "space-y-5"}>
      {setupNeedsAttention ? (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          Resource setup is the next step. Panel publishing, enabling, and operational configuration
          unlock after the four Discord dependencies are ready.
        </div>
      ) : null}
      <SettingsBlock>
        <SectionHeader
          title="Clan creation panel"
          description="Publish a custom member-facing button. Submissions create a private review ticket visible only to the requester, configured reviewers, and HAF Bot."
          actions={
            <Button
              loading={publishing}
              loadingLabel="Publishing…"
              disabled={
                configBusy ||
                !config.requestPanelChannelId ||
                !config.requestReviewCategoryId ||
                config.reviewerRoleIds.length === 0
              }
              onClick={() => void publishPanel()}
            >
              {config.requestPanelMessageId ? "Update panel" : "Publish panel"}
            </Button>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Panel channel">
            <p className="rounded-md border border-input bg-muted/20 px-3 py-2 text-sm">
              {resourceName(resources?.textChannels, config.requestPanelChannelId)}
            </p>
          </FormField>
          <FormField label="Review-ticket category">
            <p className="rounded-md border border-input bg-muted/20 px-3 py-2 text-sm">
              {resourceName(resources?.categories, config.requestReviewCategoryId)}
            </p>
          </FormField>
          <FormField label="Panel title">
            <Input
              value={config.requestPanelTitle ?? "Create a Clan"}
              onChange={(event) => setConfig({ ...config, requestPanelTitle: event.target.value })}
            />
          </FormField>
          <FormField label="Button label">
            <Input
              value={config.requestPanelButtonLabel ?? "Create Clan"}
              onChange={(event) =>
                setConfig({ ...config, requestPanelButtonLabel: event.target.value })
              }
            />
          </FormField>
          <FormField label="Panel description">
            <textarea
              className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={config.requestPanelDescription ?? ""}
              onChange={(event) =>
                setConfig({ ...config, requestPanelDescription: event.target.value })
              }
            />
          </FormField>
          <FormField label="Panel colour">
            <ColorInput
              id="clan-request-panel-color"
              value={config.requestPanelColor ?? 0x5865f2}
              onChange={(requestPanelColor) => setConfig({ ...config, requestPanelColor })}
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          Published message: {config.requestPanelMessageId ?? "Not published"}
        </p>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Configuration"
          description="Control who can review requests, who is eligible, and how Clan lifecycle automation behaves."
        />
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={config.enabled}
            disabled={
              config.enabled === false &&
              setupState?.readiness !== "ready_disabled" &&
              setupState?.readiness !== "enabled"
            }
            onCheckedChange={(checked) => setConfig({ ...config, enabled: checked === true })}
          />
          Enable Clan Management
        </label>
        {!config.enabled && setupState?.readiness !== "ready_disabled" ? (
          <p className="text-xs text-muted-foreground">
            Finish Feature Resource Setup before enabling Clan Management.
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Reviewer roles">
            <MultiRoleSelect
              roles={resources?.roles ?? []}
              value={config.reviewerRoleIds}
              onChange={(reviewerRoleIds) => setConfig({ ...config, reviewerRoleIds })}
            />
          </FormField>
          <FormField label="Staff access roles">
            <MultiRoleSelect
              roles={resources?.roles ?? []}
              value={config.staffAccessRoleIds}
              onChange={(staffAccessRoleIds) => setConfig({ ...config, staffAccessRoleIds })}
            />
          </FormField>
          <FormField label="Allowed applicant roles">
            <MultiRoleSelect
              roles={resources?.roles ?? []}
              value={config.eligibilityAllowedRoleIds}
              onChange={(eligibilityAllowedRoleIds) =>
                setConfig({ ...config, eligibilityAllowedRoleIds })
              }
            />
          </FormField>
          <FormField label="Required applicant roles">
            <MultiRoleSelect
              roles={resources?.roles ?? []}
              value={config.eligibilityRequiredRoleIds}
              onChange={(eligibilityRequiredRoleIds) =>
                setConfig({ ...config, eligibilityRequiredRoleIds })
              }
            />
          </FormField>
          <ClanLimitFields
            config={config}
            onChange={(field, value) => setConfig({ ...config, [field]: value })}
          />
          <NumberField
            label="Minimum Discord account age (days)"
            value={config.minimumAccountAgeDays}
            min={0}
            onChange={(minimumAccountAgeDays) => setConfig({ ...config, minimumAccountAgeDays })}
          />
          <NumberField
            label="Minimum Guild tenure (days)"
            value={config.minimumGuildTenureDays}
            min={0}
            onChange={(minimumGuildTenureDays) => setConfig({ ...config, minimumGuildTenureDays })}
          />
          <NumberField
            label="Request cooldown (days)"
            value={config.requestCooldownDays}
            min={0}
            onChange={(requestCooldownDays) => setConfig({ ...config, requestCooldownDays })}
          />
          <NumberField
            label="Invitation expiry (days)"
            value={config.invitationExpiryDays}
            min={1}
            onChange={(invitationExpiryDays) => setConfig({ ...config, invitationExpiryDays })}
          />
          <NumberField
            label="Application expiry (days)"
            value={config.applicationExpiryDays}
            min={1}
            onChange={(applicationExpiryDays) => setConfig({ ...config, applicationExpiryDays })}
          />
          <FormField label="Clan board channel">
            <ChannelSelect
              allowClear
              channels={resources?.textChannels ?? []}
              value={config.boardChannelId ?? ""}
              onChange={(boardChannelId) =>
                setConfig({
                  ...config,
                  boardChannelId: boardChannelId || null,
                  boardEnabled: Boolean(boardChannelId),
                  boardChannelType: boardChannelId ? "text" : null,
                })
              }
              placeholder="Optional Clan board"
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave a local limit blank to use the plan maximum. A local limit can lower a plan
          allowance, but cannot raise it. Lowering a limit does not remove existing Clans or
          members; it blocks additions until usage is below the new limit.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            label="Enable inactivity lifecycle automation"
            checked={config.inactivityEnabled}
            onChange={(inactivityEnabled) => setConfig({ ...config, inactivityEnabled })}
          />
          <Toggle
            label="Show Clan attribution on public LFG posts"
            checked={config.publicLfgAttributionEnabled}
            onChange={(publicLfgAttributionEnabled) =>
              setConfig({ ...config, publicLfgAttributionEnabled })
            }
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={!hasUnsavedChanges || configBusy}
            onClick={() => void handleDiscardChanges()}
          >
            Discard changes
          </Button>
          <Button
            loading={saving}
            loadingLabel="Saving…"
            disabled={!hasUnsavedChanges || configBusy}
            onClick={() => void saveConfig()}
          >
            Save Clan settings
          </Button>
        </div>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Creation requests"
          description="Review the authoritative request revision before provisioning a Clan."
        />
        <ResponsiveTable
          rows={requests}
          rowKey={(request) => request.id}
          columns={requestColumns}
        />
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Managed Clans"
          description="Current lifecycle and Discord provisioning state."
        />
        <ResponsiveTable rows={clans} rowKey={(clan) => clan.id} columns={clanColumns} />
      </SettingsBlock>
      <PageFeedback error={error} message={message} />
    </div>
  );

  return (
    <fieldset className="min-w-0 space-y-5" disabled={refreshingRoute}>
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      {setupNeedsAttention ? setupBlock : null}
      {panelBlock}
      {setupReady ? (
        <>
          {setupSummary}
          <AdvancedSection
            title="Review or repair Discord resources"
            description="Resources are healthy and retained. Expand this section when you need to inspect choices or repair a dependency."
          >
            {setupBlock}
          </AdvancedSection>
        </>
      ) : null}
      <ReviewRequestDialog
        request={reviewRequest}
        decision={reviewDecision}
        reason={reviewReason}
        error={reviewError}
        pending={reviewingId === reviewRequest?.id}
        onDecisionChange={(value) => {
          setReviewDecision(value);
          setReviewError(null);
        }}
        onReasonChange={(value) => {
          setReviewReason(value);
          if (reviewError) setReviewError(null);
        }}
        onSubmit={() => void submitReview()}
        onClose={closeReview}
        onCopyRequester={async () => {
          if (!reviewRequest) return;
          try {
            await copyTextToClipboard(reviewRequest.requesterId);
            toast.success("Requester ID copied.");
          } catch (cause) {
            setReviewError(cause instanceof Error ? cause.message : "Could not copy requester ID.");
          }
        }}
      />
    </fieldset>
  );
}

type ClanLimitField = "localClansMax" | "localMembersMax" | "localOfficersMax";

type ReviewDecision = "approve" | "request-changes" | "reject";

export function ReviewRequestDialog({
  request,
  decision,
  reason,
  error,
  pending,
  onDecisionChange,
  onReasonChange,
  onSubmit,
  onClose,
  onCopyRequester,
}: {
  request: ClanRequest | null;
  decision: ReviewDecision;
  reason: string;
  error: string | null;
  pending: boolean;
  onDecisionChange: (value: ReviewDecision) => void;
  onReasonChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onCopyRequester: () => void;
}) {
  const view = request ? buildClanReviewDialogView(request) : null;
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && onClose()}>
      {request ? (
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{view?.title}</DialogTitle>
            <DialogDescription>
              Inspect the complete request, then record one deliberate decision against revision{" "}
              {request.revision}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-muted/20 p-3">
              <div>
                <p className="font-display text-lg font-semibold">
                  {request.name} <span className="text-muted-foreground">[{request.tag}]</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Created {formatRequestAge(request.createdAtMs)} · Revision {request.revision}
                </p>
              </div>
              <Badge variant={request.status === "changes-requested" ? "warning" : "info"}>
                {request.status.replaceAll("-", " ")}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ReviewDetail
                label={view?.requesterLabel ?? ""}
                value={view?.requesterId ?? ""}
                copyAction={onCopyRequester}
              />
              <ReviewDetail
                label="Recruitment state"
                value={request.recruitmentState.replaceAll("-", " ")}
              />
              <ReviewDetail
                label="Proposed officer IDs"
                value={
                  request.proposedOfficerIds.length ? request.proposedOfficerIds.join(", ") : "None"
                }
              />
              <ReviewDetail label="Request age" value={formatRequestAge(request.createdAtMs)} />
            </div>
            <ReviewDetail label="Description" value={view?.description ?? ""} multiline />
            <ReviewDetail label="Focus" value={view?.focus ?? ""} multiline />
            {request.reviewReason ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-200">
                  Previous requested changes or rejection reason
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{view?.reviewReason}</p>
              </div>
            ) : null}
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide">Review-ticket state</p>
              <p className="mt-1">{view?.reviewTicketState}</p>
              {request.reviewTicketError ? (
                <p className="mt-1 text-xs text-red-200">
                  Projection error: {view?.reviewTicketError}
                </p>
              ) : null}
            </div>
            <div className="space-y-3 rounded-md border p-3">
              <p className="font-semibold">Decision</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Decision">
                {(
                  [
                    ["approve", "Approve"],
                    ["request-changes", "Request changes"],
                    ["reject", "Reject"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={
                      decision === value
                        ? value === "reject"
                          ? "destructive"
                          : "default"
                        : "outline"
                    }
                    aria-pressed={decision === value}
                    onClick={() => onDecisionChange(value)}
                    disabled={pending}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {decision !== "approve" ? (
                <FormField
                  label={decision === "reject" ? "Rejection reason" : "Requested changes"}
                  hint="Required; maximum 1,000 characters."
                  required
                  error={
                    error && !/changed|revision|stale|conflict/i.test(error) ? error : undefined
                  }
                >
                  <Textarea
                    value={reason}
                    maxLength={1000}
                    rows={5}
                    aria-label={decision === "reject" ? "Rejection reason" : "Requested changes"}
                    placeholder={
                      decision === "reject"
                        ? "Explain why this request is being rejected."
                        : "Tell the requester what to change."
                    }
                    onChange={(event) => onReasonChange(event.target.value)}
                    disabled={pending}
                  />
                </FormField>
              ) : null}
              {error && /changed|revision|stale|conflict/i.test(error) ? (
                <p className="text-xs text-amber-200" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="rounded-md bg-muted/30 p-3 text-xs">
                <span className="font-semibold">Final decision summary:</span>{" "}
                {decision === "approve"
                  ? "Approve and provision this Clan request."
                  : decision === "reject"
                    ? "Reject this request with the entered reason."
                    : "Return this request to the requester with the entered changes."}{" "}
                <span className="text-muted-foreground">Current revision: {view?.revision}.</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={decision === "reject" ? "destructive" : "default"}
              loading={pending}
              loadingLabel="Submitting…"
              onClick={onSubmit}
            >
              {decision === "approve"
                ? "Approve request"
                : decision === "reject"
                  ? "Reject request"
                  : "Request changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function buildClanReviewDialogView(request: ClanRequest) {
  return {
    title: "Review Clan request",
    requesterLabel: "Requester ID",
    requesterId: request.requesterId,
    description: request.description || "No description provided.",
    focus: request.focus || "No focus provided.",
    reviewReason: request.reviewReason,
    reviewTicketState: request.reviewTicketState ?? "Not recorded",
    reviewTicketError: request.reviewTicketError,
    revision: request.revision,
  };
}

function ReviewDetail({
  label,
  value,
  multiline = false,
  copyAction,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  copyAction?: () => void;
}) {
  return (
    <div
      className={
        multiline
          ? "rounded-md border bg-muted/20 p-3 sm:col-span-2"
          : "rounded-md border bg-muted/20 p-3"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {copyAction ? (
          <Button type="button" variant="ghost" size="sm" onClick={copyAction}>
            Copy
          </Button>
        ) : null}
      </div>
      <p className={multiline ? "mt-1 whitespace-pre-wrap" : "mt-1 break-all"}>{value}</p>
    </div>
  );
}

function formatRequestAge(createdAtMs: number): string {
  const ageMs = Math.max(0, Date.now() - createdAtMs);
  const ageHours = Math.floor(ageMs / 3_600_000);
  if (ageHours < 24) return `${ageHours}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

export function validateReviewReason(decision: ReviewDecision, reason: string): string | null {
  if (decision === "approve") return null;
  if (!reason.trim()) {
    return decision === "reject"
      ? "Provide a reason before rejecting this request."
      : "Describe the changes the requester should make.";
  }
  return reason.trim().length > 1000
    ? "Keep the review reason to 1,000 characters or fewer."
    : null;
}

const CLAN_SETUP_DEFAULT_NAMES: Record<string, string> = {
  managed_category: "HAF Clans",
  panel_channel: "clan-requests",
  review_category: "Clan Reviews",
  reviewer_role: "Clan Reviewer",
};

function initialSetupChoices(initialData: ClansLoaderData): Record<string, SetupResourceChoice> {
  if (initialData.setup?.run?.status === "incomplete") return initialData.setup.run.choices;
  const choices =
    initialData.recommendedSetupChoices ??
    Object.fromEntries(
      Object.entries(CLAN_SETUP_DEFAULT_NAMES).map(([key, name]) => [
        key,
        { action: "create", name } satisfies SetupResourceChoice,
      ]),
    );
  return {
    ...choices,
    ...(initialData.config.categoryId
      ? {
          managed_category: { action: "reuse", resourceId: initialData.config.categoryId } as const,
        }
      : {}),
    ...(initialData.config.requestPanelChannelId
      ? {
          panel_channel: {
            action: "reuse",
            resourceId: initialData.config.requestPanelChannelId,
          } as const,
        }
      : {}),
    ...(initialData.config.requestReviewCategoryId
      ? {
          review_category: {
            action: "reuse",
            resourceId: initialData.config.requestReviewCategoryId,
          } as const,
        }
      : {}),
    ...(initialData.config.reviewerRoleIds[0]
      ? {
          reviewer_role: {
            action: "reuse",
            resourceId: initialData.config.reviewerRoleIds[0],
          } as const,
        }
      : {}),
  };
}

function choicesFromRun(run: SetupRun): Record<string, SetupResourceChoice> {
  return Object.fromEntries(
    run.resolutions.map((resolution) => [
      resolution.dependencyKey,
      { action: "reuse", resourceId: resolution.resource.id } satisfies SetupResourceChoice,
    ]),
  );
}

function setupReadinessLabel(setup: FeatureSetupState | null): string {
  switch (setup?.readiness) {
    case "setup_incomplete":
      return "Setup incomplete";
    case "ready_disabled":
      return "Ready · disabled";
    case "enabled":
      return "Enabled";
    case "needs_attention":
      return "Needs attention";
    case "dormant":
      return "Dormant";
    default:
      return "Not set up";
  }
}

function setupReadinessVariant(
  setup: FeatureSetupState | null,
): "default" | "success" | "warning" | "danger" | "info" {
  if (setup?.readiness === "enabled" || setup?.readiness === "ready_disabled") return "success";
  if (setup?.readiness === "needs_attention") return "danger";
  if (setup?.readiness === "setup_incomplete" || setup?.readiness === "dormant") return "warning";
  return "default";
}

function SetupDependencyChoice({
  dependencyKey,
  label,
  choice,
  reuseOptions,
  resourceKind,
  onChange,
}: {
  dependencyKey: string;
  label: string;
  choice: SetupResourceChoice | undefined;
  reuseOptions: Array<{ id: string; name: string }>;
  resourceKind: "channel" | "role";
  onChange: (key: string, choice: SetupResourceChoice) => void;
}) {
  const current = choice ?? {
    action: "create" as const,
    name: CLAN_SETUP_DEFAULT_NAMES[dependencyKey] ?? label,
  };
  const action = current.action;
  return (
    <FormField label={label}>
      <div className="space-y-2">
        <select
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={action}
          onChange={(event) =>
            onChange(
              dependencyKey,
              event.target.value === "reuse"
                ? { action: "reuse", resourceId: "" }
                : {
                    action: "create",
                    name: CLAN_SETUP_DEFAULT_NAMES[dependencyKey] ?? label,
                  },
            )
          }
        >
          <option value="create">Create recommended resource</option>
          <option value="reuse">Reuse existing resource</option>
        </select>
        {current.action === "create" ? (
          <Input
            aria-label={`${label} name`}
            value={current.name}
            onChange={(event) =>
              onChange(dependencyKey, { action: "create", name: event.target.value })
            }
          />
        ) : resourceKind === "role" ? (
          <RoleSelect
            roles={reuseOptions}
            value={current.resourceId}
            onChange={(resourceId) => onChange(dependencyKey, { action: "reuse", resourceId })}
            placeholder="Select an existing role"
          />
        ) : (
          <ChannelSelect
            channels={reuseOptions}
            value={current.resourceId}
            onChange={(resourceId) => onChange(dependencyKey, { action: "reuse", resourceId })}
            placeholder="Select an existing Discord resource"
          />
        )}
      </div>
    </FormField>
  );
}

function SetupPreviewItem({ dependency }: { dependency: SetupDependencyPreview }) {
  return (
    <li className="border-l-2 border-accent pl-3 text-sm">
      <p className="font-medium">
        {dependency.label}: {dependency.choice.action === "create" ? "Create" : "Reuse"}{" "}
        <code>
          {dependency.choice.action === "create"
            ? dependency.choice.name
            : (dependency.resource?.name ?? dependency.choice.resourceId)}
        </code>
      </p>
      <p className="text-xs text-muted-foreground">
        {dependency.relationship.replaceAll("_", " ")} · {dependency.permissionSummary}
      </p>
    </li>
  );
}

function resourceName(
  resources: Array<{ id: string; name: string }> | undefined,
  resourceId: string | null | undefined,
): string {
  if (!resourceId) return "Not set up";
  return resources?.find((resource) => resource.id === resourceId)?.name ?? resourceId;
}

export function ClanLimitFields({
  config,
  onChange,
}: {
  config: ClanManagementConfig;
  onChange: (field: ClanLimitField, value: number | null) => void;
}) {
  return (
    <>
      <OptionalNumberField
        id="clan-local-clans-max"
        label="Local maximum active Clans"
        hint="The maximum number of active Clans this server allows, up to its plan maximum."
        value={config.localClansMax}
        min={1}
        onChange={(value) => onChange("localClansMax", value)}
      />
      <OptionalNumberField
        id="clan-local-members-max"
        label="Local maximum members per Clan"
        hint="The maximum total membership of each Clan, including its owner and officers, up to the plan maximum."
        value={config.localMembersMax}
        min={1}
        onChange={(value) => onChange("localMembersMax", value)}
      />
      <OptionalNumberField
        id="clan-local-officers-max"
        label="Local maximum officers per Clan"
        hint="The maximum officer count per Clan. The owner is not counted as an officer."
        value={config.localOfficersMax}
        min={0}
        onChange={(value) => onChange("localOfficersMax", value)}
      />
    </>
  );
}

function OptionalNumberField({
  id,
  label,
  hint,
  value,
  min,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number | null;
  min: number;
  onChange: (value: number | null) => void;
}) {
  return (
    <FormField label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        min={min}
        value={value ?? ""}
        placeholder="Use plan maximum"
        onChange={(event) => onChange(parseOptionalClanLimit(event.target.value, min))}
      />
    </FormField>
  );
}

export function parseOptionalClanLimit(value: string, min: number): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : null;
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <FormField label={label}>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(event) =>
          onChange(Math.max(min, Number.parseInt(event.target.value || "0", 10)))
        }
      />
    </FormField>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-3 text-sm">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}
