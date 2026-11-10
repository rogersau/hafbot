import { useEffect, useRef, useState } from "react";
import {
  SUGGESTION_STATUSES,
  isTerminalSuggestionStatus,
  type ConsideredReply,
  type Suggestion,
  type SuggestionRevision,
  type SuggestionsConfig,
  type SuggestionStatus,
  type SuggestionStatusEvent,
  type SuggestionVote,
} from "../../suggestions";
import type { SuggestionsLoaderData } from "../lib/admin-route-loaders";
import { AdminApiError, parseAdminApiError, readResponseError } from "../lib/api";
import { AdminErrorNotice } from "./admin-error-notice";
import { copyTextToClipboard } from "../lib/clipboard";
import { loadGuildResources, type GuildResources } from "../lib/guild-resources-cache";
import { adminRefreshWarning, reconcileAdminMutation } from "../lib/mutation-reconciliation";
import { AdminPageHeader } from "./admin-page-header";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { NoGuildSelected } from "./no-guild-selected";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { RoleSelect } from "./guild-resource-select";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useConfirmDialog } from "./ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface SuggestionDetailData {
  suggestion: Suggestion;
  revisions: SuggestionRevision[];
  statusHistory: SuggestionStatusEvent[];
  replies: ConsideredReply[];
  votes: SuggestionVote[];
  replyFlags: Record<string, string[]>;
}

interface TransitionDraft {
  suggestionId: string;
  toStatus: SuggestionStatus;
  reason: string;
  outcomeSummary: string;
  nextStepOrLink: string;
  reviewing: boolean;
}

export function AdminSuggestionsPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: SuggestionsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  if (!selectedGuildId) return <NoGuildSelected feature="Suggestions" />;
  if (!initialData)
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Suggestions could not be loaded.</p>
        <Button
          type="button"
          variant="outline"
          loading={retrying}
          disabled={!onRouteDataRefresh}
          onClick={() => {
            setRetrying(true);
            void onRouteDataRefresh?.().finally(() => setRetrying(false));
          }}
        >
          Retry
        </Button>
      </div>
    );
  return (
    <SuggestionsEditor
      workspaceId={selectedWorkspaceId}
      guildId={selectedGuildId}
      initialData={initialData}
      refresh={onRouteDataRefresh}
    />
  );
}

function SuggestionsEditor({
  workspaceId,
  guildId,
  initialData,
  refresh,
}: {
  workspaceId: string;
  guildId: string;
  initialData: SuggestionsLoaderData;
  refresh?: () => Promise<void>;
}) {
  const [config, setConfig] = useState(initialData.config);
  const [savedConfig, setSavedConfig] = useState(initialData.config);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [promptErrors, setPromptErrors] = useState<Record<number, string>>({});
  const [resources, setResources] = useState<GuildResources | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [resourceAttempt, setResourceAttempt] = useState(0);
  const [categoryDraft, setCategoryDraft] = useState("");
  const categoryOriginalsRef = useRef(new Map<number, string>());
  const [categoryValidation, setCategoryValidation] = useState<{
    index: number;
    message: string;
  } | null>(null);
  const [suggestions, setSuggestions] = useState(initialData.suggestions);
  const [transitionDraft, setTransitionDraft] = useState<TransitionDraft | null>(null);
  const [transitionPendingId, setTransitionPendingId] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [detailSuggestionId, setDetailSuggestionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SuggestionDetailData | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<{
    action: string;
    error: unknown;
  } | null>(null);
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const toast = useToast();

  useEffect(() => {
    let active = true;
    setResourceError(null);
    void loadGuildResources(workspaceId, guildId)
      .then((value) => {
        if (active) setResources(value);
      })
      .catch((cause) => {
        if (active) {
          setResourceError(
            cause instanceof Error ? cause.message : "Discord resources could not be loaded.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [guildId, workspaceId, resourceAttempt]);

  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(config, savedConfig);

  useEffect(() => {
    setSuggestions(initialData.suggestions);
  }, [initialData.suggestions]);

  function discardChanges() {
    setConfig(savedConfig);
    categoryOriginalsRef.current.clear();
    setCategoryValidation(null);
    setSaveError(null);
    setPromptErrors({});
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard Suggestions changes?",
      description: "This restores the last saved Suggestions settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    const errors: Record<number, string> = {};
    config.prompts.forEach((prompt, index) => {
      if (!prompt.label.trim() || prompt.label.trim().length > 45) {
        errors[index] = "Enter a prompt between 1 and 45 characters.";
      }
    });
    setPromptErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setSaveError(null);
    setRefreshFailure(null);
    try {
      const response = await fetch("/admin/api/suggestions/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, guildId, workspaceId: workspaceId.trim() || undefined }),
      });
      if (!response.ok) throw await parseAdminApiError(response, "Suggestions save failed.");
      const value = (await response.json()) as { config?: SuggestionsConfig };
      const next = value.config ?? config;
      setConfig(next);
      setSavedConfig(next);
      categoryOriginalsRef.current.clear();
      setCategoryValidation(null);
      toast.success("Suggestions settings saved.");
      await reconcileRefresh("Suggestions settings save");
    } catch (cause) {
      setSaveError(cause);
      toast.error(cause instanceof Error ? cause.message : "Suggestions save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function publishPanel() {
    const wasPublished = Boolean(config.panelMessageId);
    setBusy(true);
    setRefreshFailure(null);
    try {
      const response = await fetch("/admin/api/suggestions/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId, workspaceId: workspaceId.trim() || undefined }),
      });
      if (!response.ok)
        throw new Error(await readResponseError(response, "Suggestions panel publish failed."));
      const value = (await response.json()) as { config?: SuggestionsConfig };
      if (value.config) {
        setConfig(value.config);
        setSavedConfig(value.config);
        categoryOriginalsRef.current.clear();
        setCategoryValidation(null);
      }
      toast.success(wasPublished ? "Suggestions panel updated." : "Suggestions panel published.");
      await reconcileRefresh("Suggestions panel publish");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Suggestions panel publish failed.");
    } finally {
      setBusy(false);
    }
  }

  function addCategory() {
    const value = categoryDraft.trim();
    if (
      !value ||
      config.categories.some(
        (category) => category.toLocaleLowerCase() === value.toLocaleLowerCase(),
      ) ||
      config.categories.length >= 14
    )
      return;
    patch(setConfig, "categories", [...config.categories, value]);
    setCategoryDraft("");
  }

  function removeCategory(index: number) {
    categoryOriginalsRef.current.clear();
    setCategoryValidation(null);
    patch(
      setConfig,
      "categories",
      config.categories.filter((_, categoryIndex) => categoryIndex !== index),
    );
  }

  function renameCategory(index: number, value: string) {
    const next = [...config.categories];
    const original = categoryOriginalsRef.current.get(index) ?? next[index] ?? "";
    const result = validateSuggestionCategoryRename(value, original, next, index);
    if (result.error) {
      next[index] = result.value;
      patch(setConfig, "categories", next);
      setCategoryValidation({ index, message: result.error });
      return;
    }
    next[index] = result.value;
    patch(setConfig, "categories", next);
    categoryOriginalsRef.current.delete(index);
    setCategoryValidation((current) => (current?.index === index ? null : current));
  }

  async function mutate(path: string, body: object, method: "POST" | "PUT" = "POST") {
    setBusy(true);
    setRefreshFailure(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId, workspaceId: workspaceId.trim() || undefined, ...body }),
      });
      if (!response.ok)
        throw new Error(await readResponseError(response, "Suggestions update failed."));
      const value = (await response.json()) as {
        config?: SuggestionsConfig;
        suggestion?: Suggestion;
      };
      if (value.config) {
        setConfig(value.config);
        setSavedConfig(value.config);
        categoryOriginalsRef.current.clear();
        setCategoryValidation(null);
      }
      if (value.suggestion) {
        setSuggestions((current) =>
          current.map((item) => (item.id === value.suggestion?.id ? value.suggestion : item)),
        );
      }
      toast.success("Suggestions updated.");
      await reconcileRefresh("Suggestions update");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Suggestions update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reconcileRefresh(action: string) {
    const { refreshError } = await reconcileAdminMutation(async () => undefined, refresh);
    if (!refreshError) return;
    setRefreshFailure({ action, error: refreshError });
    toast.info(adminRefreshWarning(action, refreshError));
  }

  function openTransition(suggestion: Suggestion) {
    const defaultTarget = SUGGESTION_STATUSES.find((status) => status !== suggestion.status);
    if (!defaultTarget) return;
    setTransitionError(null);
    setTransitionDraft({
      suggestionId: suggestion.id,
      toStatus: defaultTarget,
      reason: "",
      outcomeSummary: "",
      nextStepOrLink: "",
      reviewing: false,
    });
  }

  function closeTransition() {
    if (transitionPendingId) return;
    const suggestionId = transitionDraft?.suggestionId;
    setTransitionDraft(null);
    setTransitionError(null);
    restoreSuggestionFocus(suggestionId);
  }

  async function submitTransition() {
    if (!transitionDraft) return;
    const suggestion = suggestions.find((item) => item.id === transitionDraft.suggestionId);
    if (!suggestion) return;
    const validationError = validateTransitionDraft(suggestion, transitionDraft);
    if (validationError) {
      setTransitionError(validationError);
      return;
    }
    setTransitionPendingId(suggestion.id);
    setTransitionError(null);
    setRefreshFailure(null);
    try {
      const targetTerminal = isTerminalSuggestionStatus(transitionDraft.toStatus);
      const response = await fetch("/admin/api/suggestions/transition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId,
          workspaceId: workspaceId.trim() || undefined,
          suggestionId: suggestion.id,
          expectedRevision: suggestion.revision,
          toStatus: transitionDraft.toStatus,
          reason: transitionDraft.reason.trim() || undefined,
          outcome: targetTerminal
            ? {
                summary: transitionDraft.outcomeSummary.trim(),
                nextStepOrLink: transitionDraft.nextStepOrLink.trim() || null,
              }
            : undefined,
        }),
      });
      if (!response.ok)
        throw new Error(
          await readResponseError(response, "Suggestion status could not be changed."),
        );
      const value = (await response.json()) as { suggestion: Suggestion };
      setSuggestions((current) =>
        current.map((item) => (item.id === value.suggestion.id ? value.suggestion : item)),
      );
      toast.success(`Suggestion moved to ${humanize(value.suggestion.status)}.`);
      setTransitionDraft(null);
      restoreSuggestionFocus(suggestion.id);
      await reconcileRefresh("Suggestion status change");
    } catch (cause) {
      const text =
        cause instanceof Error ? cause.message : "Suggestion status could not be changed.";
      setTransitionError(
        /changed|revision|stale/i.test(text)
          ? "This Suggestion changed while you were reviewing it. Refresh the page, then review your entered text and try again."
          : text,
      );
    } finally {
      setTransitionPendingId(null);
    }
  }

  async function openDetails(suggestionId: string) {
    setDetailSuggestionId(suggestionId);
    setDetail(null);
    await loadDetails(suggestionId);
  }

  async function loadDetails(suggestionId: string) {
    setDetailBusy(true);
    setDetailError(null);
    try {
      const query = new URLSearchParams({ guildId, suggestionId });
      if (workspaceId.trim()) query.set("workspaceId", workspaceId.trim());
      const response = await fetch(`/admin/api/suggestions/detail?${query}`);
      if (!response.ok)
        throw new Error(
          await readResponseError(response, "Suggestion details could not be loaded."),
        );
      setDetail((await response.json()) as SuggestionDetailData);
    } catch (cause) {
      setDetailError(
        cause instanceof Error ? cause.message : "Suggestion details could not be loaded.",
      );
    } finally {
      setDetailBusy(false);
    }
  }

  function closeDetails() {
    const suggestionId = detailSuggestionId;
    setDetailSuggestionId(null);
    setDetail(null);
    setDetailError(null);
    restoreSuggestionFocus(suggestionId);
  }

  async function copyId(value: string) {
    try {
      await copyTextToClipboard(value);
      setCopiedId(value);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Discord ID could not be copied.");
    }
  }

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      {confirmDialog}
      <AdminPageHeader
        title="Suggestions"
        description="Run structured community proposals, balanced voting, Considered Replies, and visible staff outcomes."
        selectedGuildId={guildId}
        selectedWorkspaceId={workspaceId}
        actions={<Badge variant="info">Free on every plan</Badge>}
      />
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      {saveError ? (
        <div className="space-y-2">
          <AdminErrorNotice error={saveError} />
          {saveError instanceof AdminApiError && saveError.fieldIssues?.length ? (
            <ul className="text-sm text-destructive">
              {saveError.fieldIssues.map((issue) => (
                <li key={`${issue.path}:${issue.code}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {refreshFailure ? (
        <AdminRefreshNotice
          action={refreshFailure.action}
          error={refreshFailure.error}
          refresh={refresh}
        />
      ) : null}
      {resourceError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p>Discord resources could not be loaded: {resourceError}</p>
          <Button
            className="mt-2"
            variant="outline"
            onClick={() => setResourceAttempt((v) => v + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <SettingsBlock>
        <SectionHeader
          title="Readiness"
          description={`Current state: ${initialData.readiness.state.replaceAll("_", " ")}`}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {Object.entries(initialData.readiness.checks).map(([label, healthy]) => (
            <div className="rounded-md border p-3 text-sm" key={label}>
              <Badge variant={healthy ? "success" : "warning"}>
                {healthy ? "Ready" : "Action needed"}
              </Badge>
              <span className="ml-2">{humanize(label)}</span>
            </div>
          ))}
        </div>
      </SettingsBlock>
      <SettingsBlock>
        <SectionHeader
          title="Core resources"
          description="Select existing Discord resources or use the create button to provision the recommended resource through Feature Resource Setup."
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Suggestion Forum">
            <ChannelSelect
              value={config.forumChannelId ?? ""}
              channels={resources?.forumChannels ?? []}
              onChange={(value) => patch(setConfig, "forumChannelId", value || null)}
              creation={resourceCreation(
                workspaceId,
                guildId,
                "forum_channel",
                "Suggestion Forum",
                "suggestions",
              )}
            />
          </FormField>
          <FormField label="Suggestion Panel channel">
            <ChannelSelect
              value={config.panelChannelId ?? ""}
              channels={resources?.textChannels ?? []}
              onChange={(value) => patch(setConfig, "panelChannelId", value || null)}
              creation={resourceCreation(
                workspaceId,
                guildId,
                "panel_channel",
                "Suggestion Panel channel",
                "suggestions",
              )}
            />
          </FormField>
          <FormField label="Suggestions Mod Queue">
            <ChannelSelect
              value={config.modQueueChannelId ?? ""}
              channels={resources?.textChannels ?? []}
              onChange={(value) => patch(setConfig, "modQueueChannelId", value || null)}
              creation={resourceCreation(
                workspaceId,
                guildId,
                "mod_queue_channel",
                "Suggestions Mod Queue",
                "suggestions-mod-queue",
              )}
            />
          </FormField>
          <FormField label="Suggestion Mod roles">
            <MultiRoleSelect
              value={config.modRoleIds}
              roles={resources?.roles ?? []}
              onChange={(value) => patch(setConfig, "modRoleIds", value)}
              creation={resourceCreation(
                workspaceId,
                guildId,
                "mod_role",
                "Suggestion Mod role",
                "Suggestion Moderator",
              )}
            />
          </FormField>
          <FormField label="Voter role" hint="Leave blank to allow @everyone.">
            <RoleSelect
              allowClear
              value={config.voterRoleId ?? ""}
              roles={resources?.roles ?? []}
              placeholder="@everyone (all members)"
              onChange={(value) => patch(setConfig, "voterRoleId", value || null)}
            />
          </FormField>
        </div>
      </SettingsBlock>
      <SettingsBlock>
        <SectionHeader
          title="Suggestion Panel"
          description="Configure the permanent member submission entry point."
        />
        <div className="grid gap-4">
          <FormField label="Title">
            <Input
              value={config.panelTitle}
              onChange={(event) => patch(setConfig, "panelTitle", event.target.value)}
            />
          </FormField>
          <FormField label="Body">
            <textarea
              className="min-h-24 w-full rounded-md border bg-background p-2"
              value={config.panelBody}
              onChange={(event) => patch(setConfig, "panelBody", event.target.value)}
            />
          </FormField>
          <FormField label="Button text">
            <Input
              value={config.panelButtonText}
              onChange={(event) => patch(setConfig, "panelButtonText", event.target.value)}
            />
          </FormField>
          {config.prompts.map((prompt, index) => (
            <FormField
              label={`Prompt ${index + 1}`}
              htmlFor={`suggestion-prompt-${prompt.id}`}
              key={prompt.id}
              error={promptErrors[index]}
              hint="Discord prompt labels allow 1–45 characters."
            >
              <div className="flex gap-2">
                <Input
                  id={`suggestion-prompt-${prompt.id}`}
                  maxLength={45}
                  aria-invalid={Boolean(promptErrors[index])}
                  value={prompt.label}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      prompts: current.prompts.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, label: event.target.value } : item,
                      ),
                    }))
                  }
                />
                <label className="flex items-center gap-2 whitespace-nowrap text-sm">
                  <Checkbox
                    aria-label={`Prompt ${index + 1} required`}
                    checked={prompt.required}
                    onCheckedChange={(checked) =>
                      setConfig((current) => ({
                        ...current,
                        prompts: current.prompts.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, required: checked === true } : item,
                        ),
                      }))
                    }
                  />
                  Required
                </label>
              </div>
            </FormField>
          ))}
        </div>
      </SettingsBlock>
      <SettingsBlock>
        <SectionHeader
          title="Participation and discovery"
          description="Tune eligibility, abuse limits, categories, and digest delivery."
        />
        <div className="grid gap-4 md:grid-cols-3">
          <NumberField
            label="Minimum tenure days"
            value={config.minimumTenureDays}
            min={0}
            max={3650}
            hint="Days"
            set={(value) => patch(setConfig, "minimumTenureDays", value)}
          />
          <NumberField
            label="Collapse threshold"
            value={config.collapseThreshold}
            min={2}
            max={100}
            hint="Votes"
            set={(value) => patch(setConfig, "collapseThreshold", value)}
          />
          <NumberField
            label="Active limit per member"
            value={config.activeSuggestionLimit}
            min={1}
            max={100}
            hint="Suggestions"
            set={(value) => patch(setConfig, "activeSuggestionLimit", value)}
          />
          <NumberField
            label="Submission cooldown"
            value={config.submissionCooldownSeconds / 60}
            min={0}
            max={1440}
            step={1 / 60}
            hint="Minutes"
            set={(value) => patch(setConfig, "submissionCooldownSeconds", Math.round(value * 60))}
          />
          <NumberField
            label="Digest cadence days"
            value={config.digestCadenceDays}
            min={1}
            max={30}
            hint="Days"
            set={(value) => patch(setConfig, "digestCadenceDays", value)}
          />
          <FormField label="Digest channel">
            <ChannelSelect
              allowClear
              value={config.digestChannelId ?? ""}
              channels={resources?.textChannels ?? []}
              onChange={(value) => patch(setConfig, "digestChannelId", value || null)}
              creation={resourceCreation(
                workspaceId,
                guildId,
                "digest_channel",
                "Suggestion Digest channel",
                "suggestion-digest",
              )}
            />
          </FormField>
        </div>
        <FormField label="Suggestion categories" hint="Up to 14 categories; one per suggestion.">
          <div className="space-y-2">
            {config.categories.map((category, index) => (
              <div className="flex gap-2" key={`${category}-${index}`}>
                <Input
                  value={category}
                  aria-label={`Category ${index + 1}`}
                  aria-invalid={categoryValidation?.index === index || undefined}
                  onFocus={() => {
                    categoryOriginalsRef.current.set(index, category);
                    setCategoryValidation((current) => (current?.index === index ? null : current));
                  }}
                  onChange={(event) => {
                    if (!categoryOriginalsRef.current.has(index)) {
                      categoryOriginalsRef.current.set(index, category);
                    }
                    const next = [...config.categories];
                    next[index] = event.target.value;
                    patch(setConfig, "categories", next);
                    setCategoryValidation((current) => (current?.index === index ? null : current));
                  }}
                  onBlur={(event) => renameCategory(index, event.target.value)}
                />
                {categoryValidation?.index === index ? (
                  <p className="text-xs text-destructive" role="alert">
                    {categoryValidation.message}
                  </p>
                ) : null}
                <Button type="button" variant="outline" onClick={() => removeCategory(index)}>
                  Remove
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                value={categoryDraft}
                placeholder="Add a category"
                onChange={(event) => setCategoryDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCategory();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={config.categories.length >= 14}
                onClick={addCategory}
              >
                Add
              </Button>
            </div>
          </div>
        </FormField>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={config.digestEnabled}
            onCheckedChange={(checked) => patch(setConfig, "digestEnabled", checked === true)}
          />
          Publish the optional Suggestion Digest
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={config.enabled}
            onCheckedChange={(checked) => patch(setConfig, "enabled", checked === true)}
          />
          Enable Suggestions
        </label>
      </SettingsBlock>
      <SettingsBlock>
        <SectionHeader
          title="Suggestions"
          description="Recent active and historical community proposals."
        />
        <div className="space-y-3">
          {suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Suggestions yet.</p>
          ) : (
            suggestions.map((suggestion) => (
              <div className="rounded-md border p-3" key={suggestion.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{suggestion.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {suggestion.category ? `${suggestion.category} · ` : ""}
                      {suggestion.editedAtMs ? "Edited" : "Submitted"}{" "}
                      {formatAge(suggestion.editedAtMs ?? suggestion.createdAtMs)}
                    </p>
                  </div>
                  <Badge variant="info">{humanize(suggestion.status)}</Badge>
                </div>
                <p className="mt-2 text-sm">{suggestionExcerpt(suggestion)}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Support: {suggestion.supportCount}</span>
                  <span>Oppose: {suggestion.opposeCount}</span>
                  <span>
                    Projection: {suggestion.projectionError ? "Needs attention" : "Healthy"}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span>Discord user ID: {suggestion.authorId}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copyId(suggestion.authorId)}
                  >
                    {copiedId === suggestion.authorId ? "Copied" : "Copy author ID"}
                  </Button>
                </div>
                {suggestion.outcome ? (
                  <div className="mt-3 rounded-md bg-muted/40 p-3 text-sm">
                    <p className="font-medium">Public outcome</p>
                    <p>{suggestion.outcome.summary}</p>
                    {suggestion.outcome.nextStepOrLink ? (
                      <p className="mt-1 text-muted-foreground">
                        Next step: {suggestion.outcome.nextStepOrLink}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {suggestion.projectionError ? (
                  <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <p>Discord projection degraded: {suggestion.projectionError}</p>
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        mutate("/admin/api/suggestions/repair", { suggestionId: suggestion.id })
                      }
                    >
                      Repair projection
                    </Button>
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    id={`suggestion-action-${suggestion.id}`}
                    size="sm"
                    variant="outline"
                    disabled={transitionPendingId === suggestion.id}
                    onClick={() => openTransition(suggestion)}
                  >
                    Change status
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={detailBusy && detailSuggestionId === suggestion.id}
                    onClick={() => void openDetails(suggestion.id)}
                  >
                    View details
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsBlock>
      <AdminBottomActionBar
        actions={[
          {
            label: "Discard changes",
            disabled: !hasUnsavedChanges || busy,
            variant: "outline",
            onClick: () => void handleDiscardChanges(),
          },
          {
            label: config.panelMessageId ? "Update panel & tags" : "Publish panel & tags",
            loadingLabel: "Publishing...",
            loading: busy,
            disabled: busy || hasUnsavedChanges || !config.panelChannelId,
            variant: "secondary",
            onClick: () => void publishPanel(),
          },
          {
            label: "Save Suggestions settings",
            loadingLabel: "Saving...",
            loading: busy,
            successLabel: "Saved",
            success: !hasUnsavedChanges,
            disabled: !hasUnsavedChanges || busy,
            variant: "accent",
            onClick: () => void saveConfig(),
          },
        ]}
      />
      <SettingsBlock>
        <SectionHeader
          title="Collapsed reply queue"
          description={`${initialData.collapsedReplies.length} unresolved ${
            initialData.collapsedReplies.length === 1 ? "reply" : "replies"
          }. Reply actions remain in the existing Discord moderation workflow.`}
        />
        {initialData.collapsedReplies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collapsed replies need review.</p>
        ) : (
          <div className="space-y-3">
            {initialData.collapsedReplies.map((reply) => {
              const related = suggestions.find(
                (suggestion) => suggestion.id === reply.suggestionId,
              );
              return (
                <article className="rounded-md border p-3" key={reply.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {related?.title ?? "Suggestion no longer available"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {humanize(reply.perspective)} perspective · {reply.flagCount}{" "}
                        {reply.flagCount === 1 ? "flag" : "flags"} · Submitted{" "}
                        {formatAge(reply.createdAtMs)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!related}
                      onClick={() => related && void openDetails(related.id)}
                    >
                      Review Suggestion
                    </Button>
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Show collapsed reply
                    </summary>
                    <div className="mt-2 space-y-2 break-words text-sm">
                      <p>
                        <span className="font-medium">Reasoning:</span> {reply.reasoning}
                      </p>
                      {reply.improvement ? (
                        <p>
                          <span className="font-medium">Proposed improvement:</span>{" "}
                          {reply.improvement}
                        </p>
                      ) : null}
                    </div>
                  </details>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span>Discord user ID: {reply.authorId}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void copyId(reply.authorId)}
                    >
                      {copiedId === reply.authorId ? "Copied" : "Copy author ID"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SettingsBlock>
      <TransitionDialog
        draft={transitionDraft}
        suggestion={suggestions.find((item) => item.id === transitionDraft?.suggestionId)}
        error={transitionError}
        pending={transitionPendingId !== null}
        onChange={setTransitionDraft}
        onClose={closeTransition}
        onSubmit={() => void submitTransition()}
      />
      <SuggestionDetailDialog
        open={detailSuggestionId !== null}
        detail={detail}
        busy={detailBusy}
        error={detailError}
        onClose={closeDetails}
        onRetry={() => detailSuggestionId && void loadDetails(detailSuggestionId)}
      />
    </section>
  );
}

function TransitionDialog({
  draft,
  suggestion,
  error,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: TransitionDraft | null;
  suggestion?: Suggestion;
  error: string | null;
  pending: boolean;
  onChange: React.Dispatch<React.SetStateAction<TransitionDraft | null>>;
  onClose(): void;
  onSubmit(): void;
}) {
  if (!draft || !suggestion) return null;
  const targetTerminal = isTerminalSuggestionStatus(draft.toStatus);
  const reopening =
    isTerminalSuggestionStatus(suggestion.status) && !isTerminalSuggestionStatus(draft.toStatus);
  const validationError = validateTransitionDraft(suggestion, draft);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change Suggestion status</DialogTitle>
          <DialogDescription>
            {suggestion.title} · Current status: {humanize(suggestion.status)}
          </DialogDescription>
        </DialogHeader>
        <FormField label="New status">
          <select
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={draft.toStatus}
            disabled={pending || draft.reviewing}
            onChange={(event) =>
              onChange((current) =>
                current
                  ? {
                      ...current,
                      toStatus: event.target.value as SuggestionStatus,
                      reviewing: false,
                    }
                  : current,
              )
            }
          >
            {SUGGESTION_STATUSES.filter((status) => status !== suggestion.status).map((status) => (
              <option value={status} key={status}>
                {humanize(status)}
              </option>
            ))}
          </select>
        </FormField>
        <p className="text-sm text-muted-foreground">
          {transitionExplanation(suggestion.status, draft.toStatus)}
        </p>
        {targetTerminal ? (
          <>
            <FormField label="Public outcome summary" hint="Required · maximum 2,000 characters">
              <textarea
                className="min-h-28 w-full rounded-md border bg-background p-2"
                maxLength={2000}
                disabled={pending || draft.reviewing}
                value={draft.outcomeSummary}
                onChange={(event) =>
                  onChange((current) =>
                    current ? { ...current, outcomeSummary: event.target.value } : current,
                  )
                }
              />
            </FormField>
            {draft.toStatus !== "rejected" ? (
              <FormField
                label="Next step or implementation link"
                hint="Optional · maximum 500 characters"
              >
                <Input
                  maxLength={500}
                  disabled={pending || draft.reviewing}
                  value={draft.nextStepOrLink}
                  onChange={(event) =>
                    onChange((current) =>
                      current ? { ...current, nextStepOrLink: event.target.value } : current,
                    )
                  }
                />
              </FormField>
            ) : null}
          </>
        ) : null}
        {reopening ? (
          <FormField label="Reason for reopening" hint="Required · maximum 500 characters">
            <textarea
              className="min-h-24 w-full rounded-md border bg-background p-2"
              maxLength={500}
              disabled={pending || draft.reviewing}
              value={draft.reason}
              onChange={(event) =>
                onChange((current) =>
                  current ? { ...current, reason: event.target.value } : current,
                )
              }
            />
          </FormField>
        ) : null}
        {draft.reviewing ? (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">Review transition</p>
            <p>
              {humanize(suggestion.status)} → {humanize(draft.toStatus)}
            </p>
            {draft.outcomeSummary.trim() ? (
              <p className="mt-2">Public outcome: {draft.outcomeSummary.trim()}</p>
            ) : null}
            {draft.reason.trim() ? (
              <p className="mt-2">Reopening reason: {draft.reason.trim()}</p>
            ) : null}
            {draft.nextStepOrLink.trim() ? (
              <p className="mt-2">Next step: {draft.nextStepOrLink.trim()}</p>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          {draft.reviewing ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  onChange((current) => (current ? { ...current, reviewing: false } : current))
                }
              >
                Edit
              </Button>
              <Button type="button" loading={pending} onClick={onSubmit}>
                Confirm status change
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={Boolean(validationError)}
              onClick={() =>
                onChange((current) => (current ? { ...current, reviewing: true } : current))
              }
            >
              Review change
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionDetailDialog({
  open,
  detail,
  busy,
  error,
  onClose,
  onRetry,
}: {
  open: boolean;
  detail: SuggestionDetailData | null;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onRetry(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{detail?.suggestion.title ?? "Suggestion details"}</DialogTitle>
          <DialogDescription>
            Full proposal, revision history, moderation history, replies, and votes.
          </DialogDescription>
        </DialogHeader>
        {busy ? <p className="text-sm text-muted-foreground">Loading Suggestion details…</p> : null}
        {error ? (
          <div className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>{error}</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : null}
        {detail ? <SuggestionDetailContent detail={detail} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionDetailContent({ detail }: { detail: SuggestionDetailData }) {
  const activeVotes = detail.votes.filter((vote) => vote.active);
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="font-medium">Proposal</h3>
        <dl className="mt-2 space-y-3">
          {detail.suggestion.answers.map((answer) => (
            <div key={`${answer.promptId}-${answer.promptLabel}`}>
              <dt className="text-xs font-medium text-muted-foreground">{answer.promptLabel}</dt>
              <dd className="break-words whitespace-pre-wrap">{answer.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h3 className="font-medium">Vote summary</h3>
        <p className="mt-1">
          {activeVotes.filter((vote) => vote.value === "support").length} support ·{" "}
          {activeVotes.filter((vote) => vote.value === "oppose").length} oppose
        </p>
      </section>
      <section>
        <h3 className="font-medium">Status history</h3>
        {detail.statusHistory.length ? (
          <ol className="mt-2 space-y-2">
            {detail.statusHistory.map((event) => (
              <li className="rounded-md border p-2" key={event.id}>
                {humanize(event.fromStatus)} → {humanize(event.toStatus)} ·{" "}
                {formatDateTime(event.createdAtMs)}
                {event.reason ? <p className="mt-1">Reason: {event.reason}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-muted-foreground">No status changes recorded.</p>
        )}
      </section>
      <section>
        <h3 className="font-medium">Revisions</h3>
        {detail.revisions.length ? (
          <ol className="mt-2 space-y-2">
            {detail.revisions.map((revision) => (
              <li className="rounded-md border p-2" key={revision.id}>
                Revision {revision.revision} · {formatDateTime(revision.createdAtMs)}
                <p className="mt-1">{revision.title}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-muted-foreground">No earlier revisions.</p>
        )}
      </section>
      <section>
        <h3 className="font-medium">Considered replies</h3>
        {detail.replies.length ? (
          <ul className="mt-2 space-y-2">
            {detail.replies.map((reply) => (
              <li className="rounded-md border p-2 break-words" key={reply.id}>
                <p>
                  {humanize(reply.perspective)} · {humanize(reply.state)} ·{" "}
                  {(detail.replyFlags[reply.id] ?? []).length} flags
                </p>
                <p className="mt-1">{reply.reasoning}</p>
                {reply.improvement ? (
                  <p className="mt-1">Improvement: {reply.improvement}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">No considered replies.</p>
        )}
      </section>
    </div>
  );
}

function NumberField({
  label,
  value,
  set,
  min,
  max,
  step = 1,
  hint,
}: {
  label: string;
  value: number;
  set(value: number): void;
  min: number;
  max: number;
  step?: number;
  hint: string;
}) {
  return (
    <FormField label={label} hint={`${hint} · allowed range ${min}–${max}`}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            const normalized = step === 1 ? Math.trunc(parsed) : parsed;
            set(Math.max(min, Math.min(max, normalized)));
          }
        }}
      />
    </FormField>
  );
}

function patch<K extends keyof SuggestionsConfig>(
  set: React.Dispatch<React.SetStateAction<SuggestionsConfig>>,
  key: K,
  value: SuggestionsConfig[K],
) {
  set((current) => ({ ...current, [key]: value }));
}

export function validateSuggestionCategoryRename(
  value: string,
  previousValue: string,
  categories: readonly string[],
  index: number,
): { value: string; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { value: previousValue, error: "Category name cannot be empty." };
  }
  if (
    categories.some(
      (entry, entryIndex) =>
        entryIndex !== index && entry.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
    )
  ) {
    return { value: previousValue, error: "Category names must be unique." };
  }
  return { value: trimmed, error: null };
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function validateTransitionDraft(
  suggestion: Pick<Suggestion, "status">,
  draft: Pick<TransitionDraft, "toStatus" | "reason" | "outcomeSummary" | "nextStepOrLink">,
): string | null {
  if (draft.toStatus === suggestion.status) return "Choose a different status.";
  if (isTerminalSuggestionStatus(draft.toStatus) && !draft.outcomeSummary.trim())
    return "Enter the public outcome before reviewing this transition.";
  if (draft.outcomeSummary.length > 2000)
    return "Public outcome must be 2,000 characters or fewer.";
  if (draft.nextStepOrLink.length > 500) return "Next step must be 500 characters or fewer.";
  const reopening =
    isTerminalSuggestionStatus(suggestion.status) && !isTerminalSuggestionStatus(draft.toStatus);
  if (reopening && !draft.reason.trim()) return "Enter a reason for reopening this Suggestion.";
  if (draft.reason.length > 500) return "Reopening reason must be 500 characters or fewer.";
  return null;
}

export function suggestionExcerpt(suggestion: Pick<Suggestion, "answers">): string {
  const text = suggestion.answers
    .map((answer) => answer.answer.trim())
    .filter(Boolean)
    .join(" · ");
  if (!text) return "No proposal answers were provided.";
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function transitionExplanation(from: SuggestionStatus, to: SuggestionStatus): string {
  if (isTerminalSuggestionStatus(from) && !isTerminalSuggestionStatus(to))
    return "This reopens a completed moderation decision. Staff must record why the Suggestion is returning to active review.";
  if (isTerminalSuggestionStatus(to))
    return "This closes active review and publishes the written staff outcome to the Suggestion.";
  return "This moves the Suggestion to another active moderation stage without publishing a final outcome.";
}

function formatAge(timestampMs: number): string {
  const elapsed = Math.max(0, Date.now() - timestampMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

function restoreSuggestionFocus(suggestionId?: string | null) {
  if (!suggestionId || typeof document === "undefined") return;
  window.setTimeout(() => document.getElementById(`suggestion-action-${suggestionId}`)?.focus(), 0);
}

function resourceCreation(
  workspaceId: string,
  guildId: string,
  dependencyKey: string,
  label: string,
  recommendedName: string,
) {
  return {
    workspaceId,
    guildId,
    surfaceKey: "suggestions",
    dependencyKey,
    label,
    recommendedName,
  };
}
