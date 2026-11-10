import { lazy, Suspense, useRef, useState } from "react";

import type {
  MemberVerificationConfig,
  MemberVerificationDeliveryMode,
  MemberVerificationMethod,
} from "../../types";
import { AdminPageHeader } from "./admin-page-header";
import {
  EditorActions,
  FormField,
  SectionHeader,
  SettingsBlock,
  SettingsPanel,
} from "./admin-form-layout";
import { ChannelSelect, RoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { MarkdownEditor } from "./markdown-editor";
import { EmojiPicker } from "./emoji-picker";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useToast } from "./toast";
import { refreshAdminRouteData, requireAdminRouteRefresh } from "../lib/mutation-reconciliation";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import {
  DISCORD_USER_ID_HINT,
  discordUserIdError,
  parseDiscordUserId,
} from "../lib/discord-user-id";
import { DiscordMessagePreview } from "./discord-message-preview";
import type { MemberVerificationLoaderData } from "../lib/admin-route-loaders";
import {
  buildMemberVerificationReturnTo,
  consumeMemberVerificationPrerequisiteReturn,
  createMemberVerificationDraftKey,
  parseSafeMemberVerificationReturnTo,
  persistMemberVerificationDraft,
} from "../lib/member-verification-prerequisite";

const ConfigurationHistoryCard = lazy(() =>
  import("./configuration-history-card").then((module) => ({
    default: module.ConfigurationHistoryCard,
  })),
);

export interface MemberVerificationConfigSnapshot {
  enabled: boolean;
  verifiedRoleId: string;
  title: string;
  description: string;
  color: number;
  imageUrl: string;
  thumbnailUrl: string;
  rulesUrl: string;
  verifyButtonEmoji: string;
  deliveryMode: MemberVerificationDeliveryMode;
  verificationMethod: MemberVerificationMethod;
  welcomeChannelId: string;
  panelMessageId: string;
}

const DEFAULT_CONFIG: MemberVerificationConfigSnapshot = {
  enabled: false,
  verifiedRoleId: "",
  title: "Welcome",
  description: "Welcome to the Guild! Please verify to gain access.",
  color: 0x5865f2,
  imageUrl: "",
  thumbnailUrl: "",
  rulesUrl: "",
  verifyButtonEmoji: "",
  deliveryMode: "dm",
  verificationMethod: "discord-button",
  welcomeChannelId: "",
  panelMessageId: "",
};

function normalizeConfig(
  config?: Partial<MemberVerificationConfig> | null,
): MemberVerificationConfigSnapshot {
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    verifiedRoleId: config?.verifiedRoleId ?? DEFAULT_CONFIG.verifiedRoleId,
    title: config?.title ?? DEFAULT_CONFIG.title,
    description: config?.description ?? DEFAULT_CONFIG.description,
    color: config?.color ?? DEFAULT_CONFIG.color,
    imageUrl: config?.imageUrl ?? DEFAULT_CONFIG.imageUrl,
    thumbnailUrl: config?.thumbnailUrl ?? DEFAULT_CONFIG.thumbnailUrl,
    rulesUrl: config?.rulesUrl ?? DEFAULT_CONFIG.rulesUrl,
    verifyButtonEmoji: config?.verifyButtonEmoji ?? DEFAULT_CONFIG.verifyButtonEmoji,
    deliveryMode: config?.deliveryMode === "channel" ? "channel" : DEFAULT_CONFIG.deliveryMode,
    verificationMethod:
      config?.verificationMethod === "turnstile" || config?.verificationMethod === "steam-link"
        ? config.verificationMethod
        : DEFAULT_CONFIG.verificationMethod,
    welcomeChannelId: config?.welcomeChannelId ?? DEFAULT_CONFIG.welcomeChannelId,
    panelMessageId: config?.panelMessageId ?? DEFAULT_CONFIG.panelMessageId,
  };
}

function isValidUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function hexToNumber(hex: string): number {
  const cleaned = hex.replace("#", "");
  const parsed = Number.parseInt(cleaned, 16);
  return Number.isNaN(parsed) ? DEFAULT_CONFIG.color : parsed;
}

function numberToHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function SteamLinkPrerequisitePanel({ onConfigure }: { onConfigure: () => void }) {
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
      <p className="font-medium">Steam Link setup is required</p>
      <p className="mt-1 text-muted-foreground">
        Save a Steam Platform Link configuration for this Guild before enabling Steam Link
        verification. Optional roles, logs, panels, and game filters are not required.
      </p>
      <Button className="mt-3" variant="outline" onClick={onConfigure}>
        Configure Steam Link
      </Button>
    </div>
  );
}

export function AdminMemberVerificationPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement: EntitlementInfo | null;
  initialData?: MemberVerificationLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();
  const [editorGeneration, setEditorGeneration] = useState(0);
  const editorHasUnsavedChanges = useRef(false);
  const turnstileAvailable = initialData?.turnstileAvailable ?? false;
  const steamLinkAvailable = initialData?.steamLinkAvailable ?? false;

  return (
    <section className="admin-feature-page admin-page-settings space-y-6">
      <AdminPageHeader
        title="Member Verification"
        description="Welcome new members with a Verify button that grants a Verified Role — delivered as a DM or a channel panel."
        readinessFeature="member-verification"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Member Verification" />
      ) : (
        <>
          <MemberVerificationEditor
            key={editorGeneration}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={trimmedGuildId}
            initialData={initialData}
            turnstileAvailable={turnstileAvailable}
            steamLinkAvailable={steamLinkAvailable}
            steamLinkConfigured={initialData?.steamLinkConfigured ?? false}
            paidMethodsAvailable={initialData?.paidMethodsAvailable ?? entitlement?.tier !== "free"}
            onRouteDataRefresh={onRouteDataRefresh}
            onUnsavedChangesChange={(hasChanges) => {
              editorHasUnsavedChanges.current = hasChanges;
            }}
          />
          <Suspense fallback={<p role="status">Loading configuration history…</p>}>
            <ConfigurationHistoryCard
              guildId={trimmedGuildId}
              workspaceId={selectedWorkspaceId}
              feature="member-verification"
              enabled={Boolean(entitlement && entitlement.tier !== "free")}
              hasUnsavedChanges={() => editorHasUnsavedChanges.current}
              onDiscardUnsavedChanges={() => setEditorGeneration((value) => value + 1)}
              onRestoreCompleted={async () => {
                await requireAdminRouteRefresh(onRouteDataRefresh);
                setEditorGeneration((value) => value + 1);
              }}
            />
          </Suspense>
        </>
      )}
    </section>
  );
}

function MemberVerificationEditor({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  turnstileAvailable,
  steamLinkAvailable,
  steamLinkConfigured,
  paidMethodsAvailable,
  onRouteDataRefresh,
  onUnsavedChangesChange,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: MemberVerificationLoaderData | null;
  turnstileAvailable: boolean;
  steamLinkAvailable: boolean;
  steamLinkConfigured: boolean;
  paidMethodsAvailable: boolean;
  onRouteDataRefresh?: () => Promise<void>;
  onUnsavedChangesChange?: (hasChanges: boolean) => void;
}) {
  const [prerequisiteReturn] = useState(() =>
    consumeMemberVerificationPrerequisiteReturn(
      selectedGuildId,
      typeof window === "undefined" ? "" : window.location.search,
      selectedWorkspaceId,
    ),
  );
  const restoredConfig = prerequisiteReturn
    ? {
        ...prerequisiteReturn.draft,
        verificationMethod:
          prerequisiteReturn.outcome === "complete"
            ? ("steam-link" as const)
            : ("discord-button" as const),
      }
    : null;
  const [config, setConfig] = useState<MemberVerificationConfigSnapshot>(
    () => restoredConfig ?? normalizeConfig(initialData?.config),
  );
  const [savedConfig, setSavedConfig] = useState<MemberVerificationConfigSnapshot>(() =>
    normalizeConfig(initialData?.config),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publishingPanel, setPublishingPanel] = useState(false);
  const [panelRepairRequired, setPanelRepairRequired] = useState(false);
  const [sendDmUserId, setSendDmUserId] = useState("");
  const [sendDmUserIdError, setSendDmUserIdError] = useState<string | null>(null);
  const [sendingDm, setSendingDm] = useState(false);
  const [restoredDraftUnsaved, setRestoredDraftUnsaved] = useState(
    () => prerequisiteReturn?.outcome === "complete",
  );
  const [steamPrerequisitePrompt, setSteamPrerequisitePrompt] = useState(() =>
    Boolean(
      prerequisiteReturn?.outcome === "cancel" ||
      (!steamLinkConfigured && restoredConfig?.verificationMethod === "steam-link"),
    ),
  );
  const api = useAdminApi();
  const toast = useToast();
  const { resources, loading: loadingResources } = useGuildResources(
    selectedWorkspaceId,
    selectedGuildId,
  );

  const hasUnsavedChanges =
    restoredDraftUnsaved || JSON.stringify(config) !== JSON.stringify(savedConfig);
  onUnsavedChangesChange?.(hasUnsavedChanges);
  const savedSuccessfully = !hasUnsavedChanges && saved;
  const configurationDisabled = !config.enabled;

  function discardChanges() {
    setConfig(savedConfig);
    setRestoredDraftUnsaved(false);
    setSaved(false);
    api.setError(null);
  }

  function validate(): string | null {
    if (!config.enabled) {
      return null;
    }
    if (config.enabled && !config.verifiedRoleId.trim()) {
      return "Select a Verified Role to enable Member Verification.";
    }
    if (config.enabled && config.deliveryMode === "channel" && !config.welcomeChannelId.trim()) {
      return "Select a Welcome Channel when using Channel panel delivery.";
    }
    if (config.enabled && config.verificationMethod === "steam-link") {
      if (!steamLinkAvailable) {
        return "Steam Link verification is not available for this runtime.";
      }
      if (!steamLinkConfigured) {
        setSteamPrerequisitePrompt(true);
        return "Configure Steam Link for this Guild before saving Member Verification.";
      }
    }
    if (config.title.trim().length === 0) {
      return "Title is required.";
    }
    if (config.description.trim().length === 0) {
      return "Description is required.";
    }
    if (!isValidUrl(config.imageUrl)) {
      return "Image URL must be a valid URL.";
    }
    if (!isValidUrl(config.thumbnailUrl)) {
      return "Thumbnail URL must be a valid URL.";
    }
    if (!isValidUrl(config.rulesUrl)) {
      return "Rules URL must be a valid URL.";
    }
    return null;
  }

  async function handleSave() {
    setSaved(false);
    api.setError(null);

    const error = validate();
    if (error) {
      api.setError(error);
      return;
    }

    setSaving(true);
    try {
      const data = await createAdminLoaderClient().postJson<{
        config?: MemberVerificationConfig;
        outcome?: "saved" | "saved-panel-repair-required";
      }>(
        "/admin/api/member-verification/config",
        {
          guildId: selectedGuildId,
          enabled: config.enabled,
          verifiedRoleId: config.verifiedRoleId.trim() || null,
          title: config.title.trim(),
          description: config.description.trim(),
          color: config.color,
          imageUrl: config.imageUrl.trim() || null,
          thumbnailUrl: config.thumbnailUrl.trim() || null,
          rulesUrl: config.rulesUrl.trim() || null,
          verifyButtonEmoji: config.verifyButtonEmoji.trim() || null,
          deliveryMode: config.deliveryMode,
          verificationMethod: config.verificationMethod,
          welcomeChannelId: config.welcomeChannelId.trim() || null,
        },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );

      // The backend publishes/refreshes the channel panel on save and returns
      // the up-to-date panelMessageId; reconcile so the published indicator
      // reflects reality rather than the stale local snapshot.
      const nextPanelMessageId = data.config?.panelMessageId ?? config.panelMessageId;
      const reconciled = { ...config, panelMessageId: nextPanelMessageId };
      setConfig(reconciled);
      setSavedConfig(reconciled);
      setRestoredDraftUnsaved(false);
      const repairRequired = data.outcome === "saved-panel-repair-required";
      setPanelRepairRequired(repairRequired);
      if (repairRequired) {
        toast.info(
          "Member Verification configuration was saved, but the Welcome Panel needs repair.",
        );
      } else {
        toast.success("Saved Member Verification configuration.");
      }
      setSaved(true);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save Member Verification.";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSendWelcomeDm() {
    const parsedUserId = parseDiscordUserId(sendDmUserId);
    if (!parsedUserId.ok) {
      setSendDmUserIdError(parsedUserId.error);
      return;
    }
    const userId = parsedUserId.id;
    setSendDmUserIdError(null);

    setSendingDm(true);
    api.setError(null);
    try {
      await createAdminLoaderClient().postJson(
        "/admin/api/member-verification/send-welcome-dm",
        { guildId: selectedGuildId, userId },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      toast.success(`Welcome DM sent to user ${userId}.`);
      setSendDmUserId("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send Welcome DM.";
      toast.error(message);
    } finally {
      setSendingDm(false);
    }
  }

  async function handlePublishPanel() {
    setPublishingPanel(true);
    api.setError(null);
    try {
      const data = await createAdminLoaderClient().postJson<{
        panelMessageId: string;
        outcome: "created" | "refreshed";
      }>(
        "/admin/api/member-verification/panel/publish",
        { guildId: selectedGuildId },
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      const reconciled = { ...config, panelMessageId: data.panelMessageId };
      setConfig(reconciled);
      setSavedConfig(reconciled);
      setPanelRepairRequired(false);
      toast.success(
        data.outcome === "created"
          ? "Published Member Verification panel."
          : "Repaired Member Verification panel.",
      );
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to publish or repair the Member Verification panel.";
      toast.error(message);
    } finally {
      setPublishingPanel(false);
    }
  }

  function openSteamLinkPrerequisite() {
    const draftKey = createMemberVerificationDraftKey(selectedGuildId);
    persistMemberVerificationDraft(draftKey, selectedGuildId, selectedWorkspaceId, config);
    const returnTo = buildMemberVerificationReturnTo(
      selectedGuildId,
      selectedWorkspaceId,
      draftKey,
    );
    const safeReturn = parseSafeMemberVerificationReturnTo(returnTo, selectedGuildId);
    if (!safeReturn || typeof window === "undefined") return;
    const params = new URLSearchParams({ platform: "steam", returnTo: safeReturn.href });
    if (selectedWorkspaceId.trim()) params.set("workspaceId", selectedWorkspaceId.trim());
    const destination = `/admin/${encodeURIComponent(selectedGuildId)}/player-link?${params.toString()}`;
    window.location.assign(destination);
  }

  return (
    <div className="space-y-5">
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <p className="text-sm text-muted-foreground">
        When enabled, members verify themselves by clicking Verify to gain the Verified Role. Choose
        whether to deliver the welcome message as a DM to each new member, or as a persistent panel
        in a channel. Verified members who leave and rejoin have the role restored automatically.
      </p>

      <SettingsPanel>
        <SettingsBlock>
          <SectionHeader
            title="Member Verification"
            description="Toggle the feature, choose the Verified Role, and pick how the welcome message is delivered."
          />

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable Member Verification</p>
              <p className="text-xs text-muted-foreground">
                Send the welcome message and grant the Verified Role on Verify.
              </p>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, enabled: checked }))}
              aria-label="Enable Member Verification"
            />
          </div>

          <FormField label="Delivery mode" htmlFor="delivery-mode">
            <Select
              value={config.deliveryMode}
              disabled={configurationDisabled}
              onValueChange={(value) =>
                setConfig((prev) => ({
                  ...prev,
                  deliveryMode: value === "channel" ? "channel" : "dm",
                }))
              }
            >
              <SelectTrigger id="delivery-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dm">Welcome DM</SelectItem>
                <SelectItem value="channel">Channel panel</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Verification method"
            htmlFor="verification-method"
            hint="What a member must do after clicking Verify."
          >
            <Select
              value={config.verificationMethod}
              disabled={configurationDisabled}
              onValueChange={(value) => {
                setConfig((prev) => ({
                  ...prev,
                  verificationMethod: value as MemberVerificationMethod,
                }));
                setSteamPrerequisitePrompt(value === "steam-link" && !steamLinkConfigured);
              }}
            >
              <SelectTrigger id="verification-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="discord-button">Discord button only</SelectItem>
                {(turnstileAvailable || config.verificationMethod === "turnstile") && (
                  <SelectItem
                    value="turnstile"
                    disabled={!paidMethodsAvailable || !turnstileAvailable}
                  >
                    Turnstile challenge
                  </SelectItem>
                )}
                {(steamLinkAvailable || config.verificationMethod === "steam-link") && (
                  <SelectItem
                    value="steam-link"
                    disabled={!paidMethodsAvailable || !steamLinkAvailable}
                  >
                    Steam Link required
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {!turnstileAvailable && !steamLinkAvailable && (
              <p className="text-xs text-muted-foreground">
                Enhanced verification methods are not configured for this runtime.
              </p>
            )}
            {config.verificationMethod === "turnstile" && !turnstileAvailable ? (
              <p className="text-xs text-muted-foreground">
                Saved method: Turnstile challenge (currently unavailable). Disable Member
                Verification or choose an available method before saving.
              </p>
            ) : null}
            {!paidMethodsAvailable && (turnstileAvailable || steamLinkAvailable) ? (
              <p className="text-xs text-muted-foreground">
                Turnstile and Steam Link verification require a paid plan. Discord button
                verification remains available on Free.
              </p>
            ) : null}
          </FormField>

          {steamPrerequisitePrompt &&
          config.verificationMethod !== "steam-link" &&
          !steamLinkConfigured ? (
            <SteamLinkPrerequisitePanel onConfigure={openSteamLinkPrerequisite} />
          ) : null}
          {config.verificationMethod === "steam-link" && !steamLinkConfigured ? (
            <SteamLinkPrerequisitePanel onConfigure={openSteamLinkPrerequisite} />
          ) : null}

          {config.deliveryMode === "channel" && (
            <FormField
              label="Welcome Channel"
              htmlFor="welcome-channel"
              hint="Channel where the persistent welcome panel (embed + Verify button) is posted. It is created or refreshed automatically when you Save."
              required={config.enabled}
            >
              <ChannelSelect
                id="welcome-channel"
                value={config.welcomeChannelId}
                onChange={(value) => setConfig((prev) => ({ ...prev, welcomeChannelId: value }))}
                channels={resources?.textChannels ?? []}
                placeholder="Select a channel"
                creation={{
                  guildId: selectedGuildId,
                  workspaceId: selectedWorkspaceId,
                  surfaceKey: "member_verification",
                  dependencyKey: "welcome_channel",
                  label: "welcome channel",
                  recommendedName: "verification",
                }}
              />
            </FormField>
          )}

          <FormField
            label="Verified Role"
            htmlFor="verified-role"
            hint="The role granted when a member clicks Verify."
            required={config.enabled}
          >
            <RoleSelect
              id="verified-role"
              value={config.verifiedRoleId}
              onChange={(value) => setConfig((prev) => ({ ...prev, verifiedRoleId: value }))}
              roles={resources?.roles ?? []}
              placeholder="Select a role"
              creation={{
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                surfaceKey: "member_verification",
                dependencyKey: "verified_role",
                label: "Verified role",
                recommendedName: "Verified",
              }}
            />
          </FormField>
        </SettingsBlock>

        <SettingsBlock className={configurationDisabled ? "opacity-60" : undefined}>
          <SectionHeader
            title={config.deliveryMode === "channel" ? "Welcome Panel" : "Welcome DM"}
            description={
              configurationDisabled
                ? "Enable Member Verification to edit the welcome message."
                : config.deliveryMode === "channel"
                  ? "Configure the embed shown in the welcome channel. The footer is fixed to hafbot.xyz. The panel is posted/refreshed on Save."
                  : "Configure the embed sent to new members. The footer is fixed to hafbot.xyz."
            }
          />

          {config.deliveryMode === "channel" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div className="space-y-1">
                {panelRepairRequired ? (
                  <p className="text-sm font-medium text-amber-300">
                    Configuration is saved, but the Welcome Panel needs repair.
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {config.panelMessageId
                    ? "Panel is published. Repair edits it in place, or recreates it if the message was deleted."
                    : "No panel is published yet. Publish uses the last saved configuration."}
                </p>
                {hasUnsavedChanges ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Save your changes before publishing or repairing the panel.
                  </p>
                ) : null}
              </div>
              <Button
                variant="secondary"
                onClick={handlePublishPanel}
                disabled={
                  publishingPanel ||
                  saving ||
                  hasUnsavedChanges ||
                  !config.enabled ||
                  !config.verifiedRoleId.trim() ||
                  !config.welcomeChannelId.trim()
                }
                loading={publishingPanel}
                loadingLabel="Publishing…"
              >
                Publish or repair panel
              </Button>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Title" htmlFor="welcome-title" required>
              <Input
                id="welcome-title"
                value={config.title}
                onChange={(event) => setConfig((prev) => ({ ...prev, title: event.target.value }))}
                disabled={configurationDisabled}
              />
            </FormField>

            <FormField label="Colour" htmlFor="welcome-color">
              <div className="flex items-center gap-3">
                <input
                  id="welcome-color"
                  type="color"
                  value={numberToHex(config.color)}
                  onChange={(event) =>
                    setConfig((prev) => ({ ...prev, color: hexToNumber(event.target.value) }))
                  }
                  disabled={configurationDisabled}
                  className="h-10 w-10 cursor-pointer rounded-md border bg-transparent p-1"
                />
                <Input
                  value={numberToHex(config.color)}
                  onChange={(event) =>
                    setConfig((prev) => ({ ...prev, color: hexToNumber(event.target.value) }))
                  }
                  disabled={configurationDisabled}
                  className="font-mono"
                />
              </div>
            </FormField>
          </div>

          <FormField label="Description" htmlFor="welcome-description" required>
            <MarkdownEditor
              id="welcome-description"
              flavor="full"
              rows={5}
              value={config.description}
              onChange={(next) => setConfig((prev) => ({ ...prev, description: next }))}
              helpText="Embed descriptions support headings, lists, quotes, links, spoilers, and code."
              disabled={configurationDisabled}
            />
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Image URL" htmlFor="welcome-image-url" hint="Optional large image.">
              <Input
                id="welcome-image-url"
                type="url"
                value={config.imageUrl}
                onChange={(event) =>
                  setConfig((prev) => ({ ...prev, imageUrl: event.target.value }))
                }
                placeholder="https://example.com/image.png"
                disabled={configurationDisabled}
              />
            </FormField>

            <FormField
              label="Thumbnail URL"
              htmlFor="welcome-thumbnail-url"
              hint="Optional thumbnail."
            >
              <Input
                id="welcome-thumbnail-url"
                type="url"
                value={config.thumbnailUrl}
                onChange={(event) =>
                  setConfig((prev) => ({ ...prev, thumbnailUrl: event.target.value }))
                }
                placeholder="https://example.com/thumbnail.png"
                disabled={configurationDisabled}
              />
            </FormField>
          </div>

          <FormField
            label="Rules URL"
            htmlFor="welcome-rules-url"
            hint="Optional link button shown next to Verify."
          >
            <Input
              id="welcome-rules-url"
              type="url"
              value={config.rulesUrl}
              onChange={(event) => setConfig((prev) => ({ ...prev, rulesUrl: event.target.value }))}
              placeholder="https://example.com/rules"
              disabled={configurationDisabled}
            />
          </FormField>

          <FormField
            label="Verify button emoji"
            htmlFor="welcome-verify-emoji"
            hint="Optional emoji shown on the Verify button."
          >
            <EmojiPicker
              emojis={resources?.emojis ?? []}
              loading={loadingResources}
              selectedValue={config.verifyButtonEmoji || null}
              onSelect={(selection) =>
                setConfig((prev) => ({ ...prev, verifyButtonEmoji: selection.value }))
              }
              disabled={configurationDisabled}
            />
          </FormField>

          {config.enabled ? (
            <DiscordMessagePreview
              embedTitle={config.title}
              embedDescription={config.description}
              embedColor={numberToHex(config.color)}
              embedImage={config.imageUrl.trim() || undefined}
              embedThumbnail={config.thumbnailUrl.trim() || undefined}
              embedFooter={{ text: "hafbot.xyz" }}
              buttons={[
                {
                  label: "Verify",
                  variant: "success",
                  emoji: config.verifyButtonEmoji.trim() || undefined,
                },
                ...(config.rulesUrl ? [{ label: "Rules", variant: "secondary" as const }] : []),
              ]}
            />
          ) : null}
        </SettingsBlock>

        {config.deliveryMode === "dm" && (
          <SettingsBlock>
            <SectionHeader
              title="Re-send Welcome DM"
              description="Send the Welcome DM to a specific member. This does not clear their verified state."
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <FormField
                label="Discord user ID"
                htmlFor="member-verification-dm-user"
                hint={DISCORD_USER_ID_HINT}
                error={sendDmUserIdError ?? undefined}
              >
                <Input
                  id="member-verification-dm-user"
                  value={sendDmUserId}
                  onChange={(event) => {
                    setSendDmUserId(event.target.value);
                    setSendDmUserIdError(discordUserIdError(event.target.value));
                  }}
                  placeholder="123456789012345678 or <@123456789012345678>"
                  className="min-w-[18rem]"
                  disabled={configurationDisabled}
                />
              </FormField>
              <Button
                onClick={handleSendWelcomeDm}
                disabled={configurationDisabled || sendingDm || !sendDmUserId.trim()}
                loading={sendingDm}
              >
                Send Welcome DM
              </Button>
            </div>
          </SettingsBlock>
        )}
      </SettingsPanel>

      <PageFeedback error={api.error} />

      <EditorActions>
        <Button
          variant="secondary"
          onClick={discardChanges}
          disabled={!hasUnsavedChanges || saving || publishingPanel}
        >
          Discard
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving || publishingPanel || !hasUnsavedChanges}
          loading={saving}
        >
          {savedSuccessfully ? "Saved" : "Save"}
        </Button>
      </EditorActions>
    </div>
  );
}
