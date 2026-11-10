import { BanCaseServerActions } from "./ban-case-server-actions";
import { useMemo, useState } from "react";

import type { BanCaseConfig, BanCaseSource } from "../../types";
import type { SubjectIdentifierPlatform } from "../../types";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { AdminPageHeader } from "./admin-page-header";
import {
  EditorActions,
  FormField,
  SectionHeader,
  SettingsBlock,
  SettingsPanel,
} from "./admin-form-layout";
import { PaidPlanLockedCard } from "./paid-plan-locked-card";
import { NoGuildSelected } from "./no-guild-selected";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import { ChannelSelect, MultiRoleSelect } from "./guild-resource-select";
import { buildWorkspaceGuildPath, readResponseError } from "../lib/api";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import type { BanCasesLoaderData } from "../lib/admin-route-loaders";
import { extractBanDetails } from "../../services/ban-case-service";
import { ConfigurationTestPanel } from "./configuration-test-panel";
import { copyTextToClipboard } from "../lib/clipboard";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type EditableBanCaseSource = {
  guildId: string;
  publicId?: string;
  sourceId?: string;
  name: string;
  enabled: boolean;
  platform: SubjectIdentifierPlatform;
  pattern: string;
  flags: string;
  subjectIdGroup: string;
  nameGroup: string;
  reasonGroup: string;
};

interface BanCasesResource {
  guildId: string;
  config: BanCaseConfig | null;
  sources: BanCaseSource[];
}

interface PendingSourceAction {
  title: string;
  description: string;
  continueAction: () => void | Promise<void>;
}

function createBlankSource(guildId: string): EditableBanCaseSource {
  return {
    guildId,
    name: "",
    enabled: true,
    platform: "steam",
    pattern: "",
    flags: "",
    subjectIdGroup: "",
    nameGroup: "",
    reasonGroup: "",
  };
}

function toEditable(source: BanCaseSource): EditableBanCaseSource {
  return {
    guildId: source.guildId,
    publicId: source.publicId,
    sourceId: source.sourceId,
    name: source.name,
    enabled: source.enabled,
    platform: source.platform,
    pattern: source.pattern,
    flags: source.flags,
    subjectIdGroup: source.subjectIdGroup,
    nameGroup: source.nameGroup,
    reasonGroup: source.reasonGroup,
  };
}

function isDraftValid(draft: EditableBanCaseSource): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (!draft.pattern.trim()) return "Regex pattern is required.";
  try {
    if (draft.pattern) new RegExp(draft.pattern, draft.flags);
  } catch {
    return "Invalid regex pattern.";
  }
  if (!draft.subjectIdGroup.trim()) return "Subject ID capture group is required.";
  if (!draft.nameGroup.trim()) return "Name capture group is required.";
  if (!draft.reasonGroup.trim()) return "Reason capture group is required.";
  return null;
}

export function AdminBanCasesPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  initialData?: BanCasesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-data space-y-6">
      <AdminPageHeader
        title="Ban Cases"
        description="Auto-create forum threads when game-server ban webhooks arrive. Each banned player gets a single thread that staff can mark as completed."
        readinessFeature="ban-cases"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="ban cases" />
      ) : entitlement && entitlement.tier === "free" ? (
        <PaidPlanLockedCard
          feature="Ban Cases"
          description="Ban Cases auto-create forum threads when game-server ban webhooks arrive, giving staff a per-player review surface."
          supportInvite={entitlement.supportInvite}
        />
      ) : (
        <>
          <BanCasesEditor
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={trimmedGuildId}
            initialData={initialData}
            onRouteDataRefresh={onRouteDataRefresh}
          />
          <BanCaseServerActions
            key={trimmedGuildId}
            guildId={trimmedGuildId}
            workspaceId={selectedWorkspaceId}
          />
        </>
      )}
    </section>
  );
}

function BanCasesEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: BanCasesLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [resource, setResource] = useState<BanCasesResource | null>(initialData ?? null);
  const [draft, setDraft] = useState<EditableBanCaseSource>(() =>
    createBlankSource(selectedGuildId),
  );
  const [savedDraft, setSavedDraft] = useState<EditableBanCaseSource>(() =>
    createBlankSource(selectedGuildId),
  );
  const [saving, setSaving] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [testSample, setTestSample] = useState("");
  const [testRequested, setTestRequested] = useState(false);
  const [pendingSourceAction, setPendingSourceAction] = useState<PendingSourceAction | null>(null);
  const [pendingSourceActionBusy, setPendingSourceActionBusy] = useState(false);
  const api = useAdminApi();
  const toast = useToast();
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources: guildResources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  const sources = resource?.sources ?? [];
  const config = resource?.config ?? null;
  const forumChannels = guildResources?.forumChannels ?? [];
  const roles = guildResources?.roles ?? [];
  const validationError = isDraftValid(draft);
  const extractionTestResult = useMemo(() => {
    if (!testRequested) return null;
    if (!testSample) return { kind: "error" as const, message: "Enter a sample webhook body." };
    try {
      new RegExp(draft.pattern, draft.flags || undefined);
    } catch {
      return { kind: "error" as const, message: "The regex pattern or flags are invalid." };
    }
    const details = extractBanDetails(
      {
        ...draft,
        sourceId: draft.sourceId ?? "configuration-test",
        publicId: draft.publicId ?? "configuration-test",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      testSample,
    );
    if (details) {
      const match = new RegExp(draft.pattern, draft.flags || undefined).exec(testSample);
      const missingGroups = [
        ["Subject ID", draft.subjectIdGroup],
        ["Display name", draft.nameGroup],
        ["Reason", draft.reasonGroup],
      ]
        .filter(([, group]) => !match?.groups?.[group])
        .map(([label]) => label);
      return { kind: "match" as const, details, missingGroups };
    }
    return { kind: "no-match" as const, message: "The sample did not match this extraction rule." };
  }, [draft, testRequested, testSample]);
  const sampleValidationError =
    testRequested &&
    (extractionTestResult?.kind !== "match" || extractionTestResult.missingGroups.length > 0)
      ? "Run a successful sample test with all named results before saving."
      : null;
  const saveBlocked = saving || Boolean(validationError) || Boolean(sampleValidationError);

  async function load() {
    await api.run(
      async () => {
        const response = await fetch(
          buildWorkspaceGuildPath("/admin/api/ban-cases", selectedWorkspaceId, selectedGuildId),
        );
        if (!response.ok) {
          throw new Error(await readResponseError(response, "Failed to load ban case data."));
        }
        return (await response.json()) as BanCasesResource;
      },
      (data) => setResource(data),
    );
  }

  async function saveSource(): Promise<boolean> {
    api.setError(null);
    setSaveAttempted(true);
    const error = isDraftValid(draft);
    if (error) {
      api.setError(error);
      return false;
    }
    if (
      testRequested &&
      (extractionTestResult?.kind !== "match" || extractionTestResult.missingGroups.length > 0)
    ) {
      api.setError("Run a successful sample test with all named results before saving.");
      return false;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        guildId: draft.guildId,
        name: draft.name.trim(),
        enabled: draft.enabled,
        platform: draft.platform,
        pattern: draft.pattern,
        flags: draft.flags,
        subjectIdGroup: draft.subjectIdGroup.trim(),
        nameGroup: draft.nameGroup.trim(),
        reasonGroup: draft.reasonGroup.trim(),
      };
      if (draft.publicId) body.publicId = draft.publicId;
      if (draft.sourceId) body.sourceId = draft.sourceId;

      await createAdminLoaderClient().postJson("/admin/api/ban-cases/config", body, {
        workspaceId: selectedWorkspaceId,
      });
      toast.success(draft.publicId ? "Source updated." : "Source created.");
      const blank = createBlankSource(selectedGuildId);
      setDraft(blank);
      setSavedDraft(blank);
      setTestSample("");
      setTestRequested(false);
      setSaveAttempted(false);
      await refreshAdminRouteData(onRouteDataRefresh);
      await load();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save source.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteSource(source: BanCaseSource) {
    const confirmed = await confirm({
      title: "Delete ban case source?",
      description: `This permanently deletes "${source.name}". New bans from this game server will no longer create cases.`,
      confirmLabel: "Delete source",
      variant: "destructive",
    });
    if (!confirmed) return;
    api.setError(null);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/ban-cases/delete",
        {
          guildId: source.guildId,
          sourceId: source.sourceId,
        },
        { workspaceId: selectedWorkspaceId, guildId: source.guildId },
      );
      toast.success("Source deleted.");
      if (draft.sourceId === source.sourceId) {
        const blank = createBlankSource(selectedGuildId);
        setDraft(blank);
        setSavedDraft(blank);
      }
      await refreshAdminRouteData(onRouteDataRefresh);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete source.");
    }
  }

  function startNewNow() {
    const blank = createBlankSource(selectedGuildId);
    setDraft(blank);
    setSavedDraft(blank);
    setTestSample("");
    setTestRequested(false);
    api.setError(null);
  }

  function editSourceNow(source: BanCaseSource) {
    const nextDraft = toEditable(source);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setTestSample("");
    setTestRequested(false);
    api.setError(null);
  }

  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(draft, savedDraft);

  function requestSourceAction(action: PendingSourceAction) {
    if (!hasUnsavedChanges) {
      void action.continueAction();
      return;
    }
    setPendingSourceAction(action);
  }

  function startNew() {
    requestSourceAction({
      title: "Start a new Ban Case source?",
      description: "Your current Ban Case source draft has unsaved changes.",
      continueAction: startNewNow,
    });
  }

  function editSource(source: BanCaseSource) {
    requestSourceAction({
      title: "Switch Ban Case source?",
      description: "Your current Ban Case source draft has unsaved changes.",
      continueAction: () => editSourceNow(source),
    });
  }

  function discardSourceChanges() {
    setDraft(savedDraft);
    setTestSample("");
    setTestRequested(false);
    api.setError(null);
  }

  async function saveAndContinueSourceAction() {
    if (!pendingSourceAction) return;
    setPendingSourceActionBusy(true);
    const savedSuccessfully = await saveSource();
    setPendingSourceActionBusy(false);
    if (!savedSuccessfully) return;
    const action = pendingSourceAction;
    setPendingSourceAction(null);
    await action.continueAction();
  }

  function discardSourceAction() {
    if (!pendingSourceAction) return;
    const action = pendingSourceAction;
    setPendingSourceAction(null);
    discardSourceChanges();
    void action.continueAction();
  }

  async function copyWebhookUrl(source: BanCaseSource) {
    try {
      await copyTextToClipboard(`${webhookBaseUrl}${source.publicId}`);
      toast.success("Webhook URL copied.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to copy webhook URL.");
    }
  }

  const webhookBaseUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const u = new URL(window.location.href);
    return `${u.protocol}//${u.host}/ban-cases/`;
  }, []);

  return (
    <SettingsPanel>
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardSourceChanges} />
      {confirmDialog}
      <Dialog
        open={pendingSourceAction !== null}
        onOpenChange={(open) => {
          if (!open && !pendingSourceActionBusy) setPendingSourceAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingSourceAction?.title}</DialogTitle>
            <DialogDescription>{pendingSourceAction?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={pendingSourceActionBusy}
              onClick={() => setPendingSourceAction(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingSourceActionBusy}
              onClick={discardSourceAction}
            >
              Discard and continue
            </Button>
            <Button
              type="button"
              loading={pendingSourceActionBusy}
              disabled={pendingSourceActionBusy}
              onClick={() => void saveAndContinueSourceAction()}
            >
              Save and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <SettingsBlock>
        <SectionHeader
          title="Ban Case Sources"
          description="One source per game-server ban webhook feed."
        />
        {sources.length === 0 ? (
          <EmptyState>No sources configured yet.</EmptyState>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => (
              <Card key={source.sourceId}>
                <CardContent className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{source.name}</span>
                      <span className="text-xs text-muted-foreground">{source.platform}</span>
                      {!source.enabled && (
                        <span className="text-xs text-muted-foreground">(disabled)</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      Webhook: {webhookBaseUrl}
                      {source.publicId}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => void copyWebhookUrl(source)}>
                      Copy
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => editSource(source)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => deleteSource(source)}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        <div className="pt-2">
          <Button variant="outline" onClick={startNew}>
            New Source
          </Button>
        </div>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Source Editor"
          description="Configure the regex extraction and webhook details."
        />
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <SectionHeader
                title="Source identity"
                description="Name, platform, and activation."
              />
              <FormField label="Source Name" htmlFor="bc-name">
                <Input
                  id="bc-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. COLDASFK Bans"
                />
              </FormField>
              <FormField label="Enabled" htmlFor="bc-enabled">
                <Switch
                  id="bc-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
                />
              </FormField>
              <FormField label="Platform" htmlFor="bc-platform">
                <select
                  id="bc-platform"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={draft.platform}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      platform: e.target.value as SubjectIdentifierPlatform,
                    })
                  }
                >
                  <option value="steam">Steam</option>
                  <option value="xbox">Xbox</option>
                  <option value="playstation">PlayStation</option>
                  <option value="discord">Discord</option>
                  <option value="cftools">cftools</option>
                </select>
              </FormField>
              <SectionHeader
                title="Extraction pattern"
                description="The regex must define named groups for each result below."
              />
              <FormField
                label="Regex Pattern"
                htmlFor="bc-pattern"
                error={
                  saveAttempted && !draft.pattern.trim() ? "Regex pattern is required." : undefined
                }
              >
                <Input
                  id="bc-pattern"
                  value={draft.pattern}
                  onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
                  placeholder="e.g. (\w+) \((\d+)\) got banned on .+?: (.+)"
                />
              </FormField>
              <FormField
                label="Regex Flags"
                htmlFor="bc-flags"
                error={
                  saveAttempted && draft.pattern.trim()
                    ? (() => {
                        try {
                          new RegExp(draft.pattern, draft.flags || undefined);
                          return undefined;
                        } catch {
                          return "Regex flags are invalid.";
                        }
                      })()
                    : undefined
                }
              >
                <Input
                  id="bc-flags"
                  value={draft.flags}
                  onChange={(e) => setDraft({ ...draft, flags: e.target.value })}
                  placeholder="e.g. i"
                />
              </FormField>
              <SectionHeader
                title="Named result mapping"
                description="Map named capture groups to the values shown in the sample preview."
              />
              <FormField
                label="Subject ID Capture Group"
                htmlFor="bc-subject"
                hint="Named capture group that extracts the banned subject's platform ID."
                error={
                  saveAttempted && !draft.subjectIdGroup.trim()
                    ? "Subject ID capture group is required."
                    : undefined
                }
              >
                <Input
                  id="bc-subject"
                  value={draft.subjectIdGroup}
                  onChange={(e) => setDraft({ ...draft, subjectIdGroup: e.target.value })}
                  placeholder="e.g. steamId"
                />
              </FormField>
              <FormField
                label="Name Capture Group"
                htmlFor="bc-name-group"
                hint="Named capture group that extracts the display name."
                error={
                  saveAttempted && !draft.nameGroup.trim()
                    ? "Name capture group is required."
                    : undefined
                }
              >
                <Input
                  id="bc-name-group"
                  value={draft.nameGroup}
                  onChange={(e) => setDraft({ ...draft, nameGroup: e.target.value })}
                  placeholder="e.g. username"
                />
              </FormField>
              <FormField
                label="Reason Capture Group"
                htmlFor="bc-reason"
                hint="Named capture group that extracts the ban reason."
                error={
                  saveAttempted && !draft.reasonGroup.trim()
                    ? "Reason capture group is required."
                    : undefined
                }
              >
                <Input
                  id="bc-reason"
                  value={draft.reasonGroup}
                  onChange={(e) => setDraft({ ...draft, reasonGroup: e.target.value })}
                  placeholder="e.g. reason"
                />
              </FormField>
            </CardContent>
          </Card>
          <ConfigurationTestPanel
            sampleLabel="Sample webhook body"
            sample={testSample}
            onSampleChange={setTestSample}
            onTest={() => setTestRequested(true)}
            placeholder="Paste a representative text webhook body"
            description="Preview the platform ID, display name, and reason using the current unsaved extraction rule. Nothing is saved or sent."
            result={
              extractionTestResult ? (
                extractionTestResult.kind === "match" ? (
                  <dl className="grid gap-3 rounded-[4px] border bg-background/70 p-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Platform ID</dt>
                      <dd
                        className={
                          extractionTestResult.missingGroups.includes("Subject ID")
                            ? "mt-1 text-amber-300"
                            : "mt-1 break-all font-mono"
                        }
                      >
                        {extractionTestResult.missingGroups.includes("Subject ID")
                          ? "Missing"
                          : `${extractionTestResult.details.subject.platform}:${extractionTestResult.details.subject.id}`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Display name</dt>
                      <dd
                        className={
                          extractionTestResult.missingGroups.includes("Display name")
                            ? "mt-1 text-amber-300"
                            : "mt-1 break-words"
                        }
                      >
                        {extractionTestResult.missingGroups.includes("Display name")
                          ? "Missing"
                          : extractionTestResult.details.username}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Reason</dt>
                      <dd
                        className={
                          extractionTestResult.missingGroups.includes("Reason")
                            ? "mt-1 text-amber-300"
                            : "mt-1 break-words"
                        }
                      >
                        {extractionTestResult.missingGroups.includes("Reason")
                          ? "Missing"
                          : extractionTestResult.details.reason}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="rounded-[4px] border bg-background/70 p-3 text-sm text-muted-foreground">
                    {extractionTestResult.message}
                  </p>
                )
              ) : null
            }
          />
          <EditorActions>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={discardSourceChanges}
              disabled={!hasUnsavedChanges || saving}
            >
              Discard changes
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={startNew}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveSource()}
              disabled={saveBlocked}
              loading={saving}
              loadingLabel="Saving..."
              title={validationError ?? sampleValidationError ?? undefined}
            >
              {draft.publicId ? "Update Source" : "Create Source"}
            </Button>
          </EditorActions>
        </div>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Forum Channel"
          description="The forum channel where Ban Case threads will be created."
        />
        <FormField label="Forum Channel" htmlFor="bc-forum-channel">
          <ChannelSelect
            id="bc-forum-channel"
            value={config?.forumChannelId ?? ""}
            onChange={async (channelId) => {
              if (!channelId) return;
              api.setError(null);
              try {
                await createAdminLoaderClient().postJson(
                  "/admin/api/ban-cases/config/forum-channel",
                  { guildId: selectedGuildId, forumChannelId: channelId },
                  { workspaceId: selectedWorkspaceId },
                );
                toast.success("Forum channel updated.");
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to update forum channel.");
              }
            }}
            channels={forumChannels}
            placeholder="Select a forum channel"
            creation={{
              guildId: selectedGuildId,
              workspaceId: selectedWorkspaceId,
              surfaceKey: "ban_cases",
              dependencyKey: "forum_channel",
              label: "Ban Cases forum",
              recommendedName: "ban-cases",
              accessRoleIds: config?.modRoleIds ?? [],
            }}
          />
        </FormField>
        {!forumChannels.length && (
          <p className="text-xs text-muted-foreground mt-1">
            No Forum channels found. Use Create Ban Cases forum above.
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          The bot will create a thread per banned player. Tags like &quot;NEW&quot; and
          &quot;COMPLETED&quot; are resolved automatically by the bot.
        </p>
      </SettingsBlock>

      <SettingsBlock>
        <SectionHeader
          title="Mod Roles"
          description="Roles allowed to mark cases as completed. Leave empty for guild admins only."
        />
        <FormField label="Mod Roles" htmlFor="bc-mod-roles">
          <MultiRoleSelect
            id="bc-mod-roles"
            value={config?.modRoleIds ?? []}
            onChange={async (roleIds) => {
              api.setError(null);
              try {
                await createAdminLoaderClient().postJson(
                  "/admin/api/ban-cases/config/mod-roles",
                  { guildId: selectedGuildId, modRoleIds: roleIds },
                  { workspaceId: selectedWorkspaceId },
                );
                toast.success("Mod roles updated.");
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to update mod roles.");
              }
            }}
            roles={roles}
            creation={{
              guildId: selectedGuildId,
              workspaceId: selectedWorkspaceId,
              surfaceKey: "ban_cases",
              dependencyKey: "mod_role",
              label: "mod role",
              recommendedName: "Ban Case Moderator",
              accessChannelIds: config?.forumChannelId ? [config.forumChannelId] : [],
            }}
          />
        </FormField>
      </SettingsBlock>

      <PageFeedback error={api.error} />
    </SettingsPanel>
  );
}
