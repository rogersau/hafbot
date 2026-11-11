import { ConfigurationAvailabilityActions } from "./configuration-availability-actions";
import { useState, type ReactNode } from "react";

import type { PlatformLink, PlatformLinkConfig } from "../../runtime/contracts/platform-link-store";
import { AdminPageHeader } from "./admin-page-header";
import { DiscordMessagePreview } from "./discord-message-preview";
import {
  EditorPanel,
  FormField,
  SectionHeader,
  SettingsBlock,
  SettingsPanel,
} from "./admin-form-layout";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { ChannelSelect, RoleSelect } from "./guild-resource-select";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { useAutoSaveToggle } from "../hooks/use-auto-save-toggle";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { InfoTooltip } from "./ui/info-tooltip";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { ColorInput, formatHexColor } from "./ui/color-input";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { useAdminApi } from "../hooks/use-admin-api";
import { useGuildResources } from "../hooks/use-guild-resources";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { UpgradeBanner } from "./upgrade-banner";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import type { PlayerLinkLoaderData as AdminPlayerLinkLoaderData } from "../lib/admin-route-loaders";
import { resolveSteamLinkCustomLinks } from "../../runtime/steam-link-custom-links";
import { parseSteamGameOwnership } from "../../services/platform-identity-adapter";
import { ConfigurationTestPanel } from "./configuration-test-panel";
import { playerLinkClient } from "../generated/admin-client/player-link";
import { parseSafeMemberVerificationReturnTo } from "../lib/member-verification-prerequisite";
import { copyTextToClipboard } from "../lib/clipboard";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import { adminRefreshWarning, reconcileAdminMutation } from "../lib/mutation-reconciliation";

type PlayerLinkPlatform = "steam" | "xbox" | "playstation";
type PlayerLinkConfig = PlatformLinkConfig;
type PlayerLinkRecord = PlatformLink;
type PlayerLinkPageLoaderData = AdminPlayerLinkLoaderData;

type SteamLinkAutoSaveKey = "allowRelink" | "allowMultipleLinks" | "requireRelinkOnRejoin";

interface PlayerLinkResource {
  guildId: string;
  platform?: PlayerLinkPlatform;
  config: PlayerLinkConfig | null;
  links: PlayerLinkRecord[];
}

interface PlayerLinkDraft {
  guildId: string;
  linkedRoleId: string;
  logChannelId: string;
  gameAppIds: string;
  whoisFields: string;
  panelTitle: string;
  panelDescription: string;
  panelButtonLabel: string;
  panelButtonStyle: PlatformLinkConfig["panelButtonStyle"];
  panelColor: number;
  allowRelink: boolean;
  allowMultipleLinks: boolean;
  requireRelinkOnRejoin: boolean;
  panelChannelId: string;
  customLinks: Array<{ label: string; url: string }>;
}

type PlatformLinkMetadata = (typeof PLATFORM_METADATA)[PlayerLinkPlatform];

/**
 * Builds the full config POST body for the current Player Link config endpoint (or the
 * player-link variant). Shared by the manual Save button and the auto-save
 * toggles so both send an identical payload.
 */
export function buildSteamLinkSavePayload(
  draft: PlayerLinkDraft,
  activePlatform: PlayerLinkPlatform,
  metadata: PlatformLinkMetadata,
): Parameters<typeof playerLinkClient.save>[0] {
  return {
    guildId: draft.guildId,
    platform: activePlatform,
    linkedRoleId: draft.linkedRoleId.trim() || null,
    logChannelId: draft.logChannelId.trim() || null,
    gameAppIds: activePlatform === "steam" ? parseGameAppIdsInput(draft.gameAppIds) : [],
    whoisFields: parseCommaSeparatedInput(draft.whoisFields),
    customLinks:
      activePlatform === "steam"
        ? draft.customLinks
            .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
            .filter((link) => link.label.length > 0 && link.url.length > 0)
        : [],
    panelTitle: draft.panelTitle.trim() || metadata.defaultPanelTitle,
    panelDescription: draft.panelDescription.trim() || metadata.defaultPanelDescription,
    panelButtonLabel: draft.panelButtonLabel.trim() || metadata.defaultPanelButtonLabel,
    panelButtonStyle: draft.panelButtonStyle as "Primary" | "Secondary" | "Success" | "Danger",
    panelColor: draft.panelColor,
    allowRelink: draft.allowRelink,
    allowMultipleLinks: draft.allowMultipleLinks,
    requireRelinkOnRejoin: draft.requireRelinkOnRejoin,
  };
}

const STEAM_APP_LABELS: Record<string, string> = {
  "440": "Team Fortress 2",
  "730": "Counter-Strike 2",
  "221100": "DayZ",
  "346110": "ARK: Survival Evolved",
  "393380": "Squad",
};

const WHOIS_FIELD_OPTIONS: Record<
  PlayerLinkPlatform,
  Array<{ key: string; label: string; description: string }>
> = {
  steam: [
    { key: "profile", label: "Profile link", description: "Steam profile URL" },
    { key: "gameOwnership", label: "Game ownership", description: "Configured ownership checks" },
  ],
  xbox: [{ key: "profile", label: "Profile link", description: "Xbox profile URL" }],
  playstation: [
    { key: "profile", label: "Profile link", description: "PSNProfiles URL (self-attested ID)" },
  ],
};

export function parseGameAppIdsInput(value: string): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const entry of value.split(/[,\n]+/)) {
    const id = entry.trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  return valid;
}

export function getWhoisFieldOptions(
  platform: PlayerLinkPlatform,
  customLinks: Array<{ label: string; url: string }> = [],
) {
  const options = [...WHOIS_FIELD_OPTIONS[platform]];
  if (platform === "steam") {
    for (const link of customLinks) {
      const key = link.label.trim();
      if (key && !options.some((option) => option.key === key)) {
        options.push({ key, label: key, description: "Configured custom profile link" });
      }
    }
  }
  return options;
}

const DEFAULT_PANEL_TITLE = "Link your Steam account";
const DEFAULT_PANEL_DESCRIPTION =
  "Click the button below to securely link your Discord account to your Steam account.";
const DEFAULT_PANEL_BUTTON_LABEL = "Link Steam";
const DEFAULT_PANEL_BUTTON_STYLE: PlatformLinkConfig["panelButtonStyle"] = "Primary";
const PANEL_BUTTON_STYLES: PlatformLinkConfig["panelButtonStyle"][] = [
  "Primary",
  "Secondary",
  "Success",
  "Danger",
];

export const PLATFORM_METADATA = {
  steam: {
    title: "Steam Link",
    overviewTitle: "Steam link overview",
    linkedRoleLabel: "Steam linked role",
    idLabel: "SteamID64",
    manualCommand: "/steamlink manual-link",
    defaultPanelTitle: DEFAULT_PANEL_TITLE,
    defaultPanelDescription: DEFAULT_PANEL_DESCRIPTION,
    defaultPanelButtonLabel: DEFAULT_PANEL_BUTTON_LABEL,
    description:
      "Members link through Steam OpenID, then the bot can assign a role and optionally log the result in Discord. Steam OpenID only returns the user’s SteamID64 — no username, password, or email is ever shared with the bot.",
  },
  xbox: {
    title: "Xbox Link",
    overviewTitle: "Xbox link overview",
    linkedRoleLabel: "Xbox linked role",
    idLabel: "Xbox gamertag",
    manualCommand: "/xboxlink manual-link",
    defaultPanelTitle: "Link your Xbox account",
    defaultPanelDescription:
      "Click the button below to securely link your Discord account to your Xbox account.",
    defaultPanelButtonLabel: "Link Xbox",
    description:
      "Members link through Microsoft Xbox sign-in, then the bot can assign a role and optionally log the result in Discord. The bot stores the Xbox gamertag returned by Xbox services.",
  },
  playstation: {
    title: "PlayStation Link",
    overviewTitle: "PlayStation link overview",
    linkedRoleLabel: "PlayStation linked role",
    idLabel: "PSN Online ID",
    manualCommand: "/playstationlink manual-link",
    defaultPanelTitle: "Link your PlayStation account",
    defaultPanelDescription:
      "Click the button below to link your Discord account to your PlayStation account. HAF Bot stores the PSN Online ID exactly as typed and does not verify it with Sony.",
    defaultPanelButtonLabel: "Link PlayStation",
    description:
      "Members type their PSN Online ID into a modal. The bot stores the member-submitted ID without Sony verification, then can assign a role and log the result in Discord.",
  },
} as const;

export function AdminSteamLinkPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  activePlatform = "steam",
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  activePlatform?: PlayerLinkPlatform;
  initialData?: PlayerLinkPageLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-settings space-y-6">
      <AdminPageHeader
        title="Player Link"
        description="Configure platform linking, role assignment, logging, and member-facing panels."
        readinessFeature="player-link"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Player Link settings" />
      ) : (
        <PlayerLinkEditor
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          entitlement={entitlement}
          activePlatform={activePlatform}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      )}
    </section>
  );
}

function PlayerLinkEditor({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  activePlatform,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  activePlatform: PlayerLinkPlatform;
  initialData?: PlayerLinkPageLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const metadata = PLATFORM_METADATA[activePlatform];
  const prerequisiteReturn =
    activePlatform === "steam"
      ? parseSafeMemberVerificationReturnTo(
          typeof window === "undefined"
            ? null
            : new URLSearchParams(window.location.search).get("returnTo"),
          selectedGuildId,
          selectedWorkspaceId,
        )
      : null;
  const [resource, setResource] = useState<PlayerLinkResource | null>(initialData ?? null);
  const [draft, setDraft] = useState<PlayerLinkDraft>(() =>
    initialData
      ? createDraft(initialData.guildId, activePlatform, initialData.config)
      : createDefaultDraft(selectedGuildId, activePlatform),
  );
  const [savedDraft, setSavedDraft] = useState(draft);
  const [savedDraftSnapshot, setSavedDraftSnapshot] = useState(() =>
    createSteamLinkSaveSnapshot(draft, activePlatform, metadata),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [syncingRoles, setSyncingRoles] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const api = useAdminApi();
  const toast = useToast();
  const autoSave = useAutoSaveToggle<SteamLinkAutoSaveKey>({
    onSave: async (key, nextValue) => {
      const nextDraft = { ...draft, [key]: nextValue };
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        () =>
          playerLinkClient.save({
            ...buildSteamLinkSavePayload(nextDraft, activePlatform, metadata),
            workspaceId: selectedWorkspaceId,
          }),
        onRouteDataRefresh,
      );
      setSavedDraft((current) => ({ ...current, [key]: nextValue }));
      setSavedDraftSnapshot((current) => ({ ...current, [key]: nextValue }));
      setSaved(true);
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Player Link preference save", nextRefreshError));
      } else setRefreshError(null);
    },
  });
  const { dialog: confirmDialog, confirm } = useConfirmDialog();
  const { resources } = useGuildResources(selectedWorkspaceId, selectedGuildId);

  async function loadPlayerLinks() {
    await api.run(
      () =>
        playerLinkClient.get({
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
          platform: activePlatform,
        }),
      (nextResource) => {
        const nextDraft = createDraft(nextResource.guildId, activePlatform, nextResource.config);
        setResource(nextResource);
        setDraft(nextDraft);
        setSavedDraft(nextDraft);
        setSavedDraftSnapshot(createSteamLinkSaveSnapshot(nextDraft, activePlatform, metadata));
      },
    );
  }

  function discardChanges() {
    setDraft(savedDraft);
    setSaved(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: `Discard ${metadata.title} changes?`,
      description: `This restores the last saved ${metadata.title} settings on this page.`,
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function saveConfig() {
    api.setError(null);
    setSaved(false);
    setSaving(true);

    try {
      await playerLinkClient.save({
        ...buildSteamLinkSavePayload(draft, activePlatform, metadata),
        workspaceId: selectedWorkspaceId,
      });

      toast.success(`${metadata.title} settings saved.`);
      setSaved(true);
      setSavedDraft(draft);
      setSavedDraftSnapshot(createSteamLinkSaveSnapshot(draft, activePlatform, metadata));
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        async () => undefined,
        onRouteDataRefresh,
      );
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning(`${metadata.title} settings save`, nextRefreshError));
      } else setRefreshError(null);
      if (prerequisiteReturn && typeof window !== "undefined") {
        const returnUrl = new URL(prerequisiteReturn.href, "https://admin.hafbot.invalid");
        returnUrl.searchParams.set("mvOutcome", "complete");
        window.location.assign(`${returnUrl.pathname}${returnUrl.search}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Steam link settings.");
    } finally {
      setSaving(false);
    }
  }

  function cancelPrerequisiteSetup() {
    if (!prerequisiteReturn || typeof window === "undefined") return;
    const returnUrl = new URL(prerequisiteReturn.href, "https://admin.hafbot.invalid");
    returnUrl.searchParams.set("mvOutcome", "cancel");
    window.location.assign(`${returnUrl.pathname}${returnUrl.search}`);
  }

  async function handlePublish() {
    api.setError(null);
    setPublishing(true);

    try {
      await playerLinkClient.publish({
        workspaceId: selectedWorkspaceId,
        guildId: draft.guildId,
        platform: activePlatform,
        panelChannelId: draft.panelChannelId,
      });
      toast.success(`${metadata.title} panel published successfully.`);
      await refreshAdminRouteData(onRouteDataRefresh);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to publish Steam Link panel.");
    } finally {
      setPublishing(false);
    }
  }

  async function handleSyncRoles() {
    api.setError(null);
    setSyncingRoles(true);

    try {
      const result = await playerLinkClient.syncRoles({
        workspaceId: selectedWorkspaceId,
        guildId: selectedGuildId,
        platform: activePlatform,
      });
      toast.success(
        `Role sync complete. Linked users: ${result.total}. Roles fixed: ${result.fixed}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to sync Steam Link roles.");
    } finally {
      setSyncingRoles(false);
    }
  }

  const hasUnsavedChanges = !areAdminActionSnapshotsEqual(
    createSteamLinkSaveSnapshot(draft, activePlatform, metadata),
    savedDraftSnapshot,
  );

  return (
    <SettingsPanel>
      <NavigationGuard hasChanges={hasUnsavedChanges} onDiscardChanges={discardChanges} />
      <AdminRefreshNotice
        action={metadata.title}
        error={refreshError}
        refresh={onRouteDataRefresh}
      />
      {confirmDialog}
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      {prerequisiteReturn ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium">Steam Link is a Member Verification prerequisite</p>
          <p className="mt-1 text-muted-foreground">
            Save any Steam Link configuration to return to Member Verification with your unsaved
            draft intact. You can cancel and keep the draft without changing Member Verification.
          </p>
          <Button className="mt-3" variant="outline" onClick={cancelPrerequisiteSetup}>
            Cancel setup
          </Button>
        </div>
      ) : null}
      <SteamLinkSummary
        links={resource?.links ?? []}
        activePlatform={activePlatform}
        onRefresh={() => void loadPlayerLinks()}
        loading={api.loading}
        entitlement={entitlement}
      />
      <SteamLinkConfigForm
        actions={
          resource?.config ? (
            <ConfigurationAvailabilityActions
              label={metadata.title}
              enabled={resource.config.enabled !== false}
              disabled={saving || publishing || api.loading || hasUnsavedChanges}
              description="New account links, open sign-in requests, and automatic linked-role grants will stop. Existing links and roles are kept; members can still view or unlink their accounts."
              onEnabledChange={async (enabled) => {
                await api.run(
                  () =>
                    playerLinkClient.setEnabled({
                      platform: activePlatform,
                      enabled,
                      guildId: selectedGuildId,
                      workspaceId: selectedWorkspaceId,
                    }),
                  () => {
                    setResource((current) =>
                      current?.config
                        ? { ...current, config: { ...current.config, enabled } }
                        : current,
                    );
                    toast.success(`${metadata.title} ${enabled ? "enabled" : "disabled"}.`);
                  },
                );
              }}
            />
          ) : undefined
        }
        draft={draft}
        activePlatform={activePlatform}
        onChange={setDraft}
        roles={resources?.roles ?? []}
        channels={resources?.textChannels ?? []}
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
        autoSaveToggleStatus={{ savingKey: autoSave.savingKey, savedKey: autoSave.savedKey }}
        onAutoSaveToggle={(key, nextValue) => {
          const previousValue = draft[key];
          void autoSave.saveToggle({
            key,
            nextValue,
            previousValue,
            applyValue: (value) => setDraft((current) => ({ ...current, [key]: value })),
            hasUnrelatedChanges: hasUnsavedChanges,
            successMessage: `Saved ${
              key === "allowRelink"
                ? "relink"
                : key === "allowMultipleLinks"
                  ? "multiple-links"
                  : "relink-on-rejoin"
            } preference.`,
          });
        }}
      />
      <SteamLinkPanelPreview draft={draft} activePlatform={activePlatform} />
      {activePlatform === "steam" ? (
        <SteamLinkCustomLinksTest customLinks={draft.customLinks} />
      ) : null}
      <SteamLinkLinksTable links={resource?.links ?? []} activePlatform={activePlatform} />
      <PageFeedback error={api.error} />
      <AdminBottomActionBar
        actions={[
          {
            label: "Discard changes",
            disabled: !hasUnsavedChanges || saving || publishing,
            variant: "outline",
            onClick: () => void handleDiscardChanges(),
          },
          {
            label: "Sync roles",
            loadingLabel: "Syncing...",
            loading: syncingRoles,
            disabled: syncingRoles || !draft.linkedRoleId || resource?.config?.enabled === false,
            variant: "outline",
            onClick: () => void handleSyncRoles(),
          },
          {
            label: resource?.config?.panelMessageId ? "Update panel" : "Publish panel",
            loadingLabel: "Publishing...",
            loading: publishing,
            disabled: publishing || saving || hasUnsavedChanges || !draft.panelChannelId,
            variant: "secondary",
            onClick: () => void handlePublish(),
          },
          {
            label: `Save ${metadata.title} config`,
            loadingLabel: "Saving...",
            loading: saving,
            successLabel: "Saved",
            success: !hasUnsavedChanges && saved,
            disabled: !hasUnsavedChanges || saving || publishing,
            variant: "accent",
            onClick: () => void saveConfig(),
          },
        ]}
      />
      {hasUnsavedChanges ? (
        <p className="text-right text-xs text-muted-foreground">
          Save changes before publishing the panel.
        </p>
      ) : null}
    </SettingsPanel>
  );
}

function SteamLinkSummary({
  links,
  activePlatform,
  loading,
  onRefresh,
  entitlement,
}: {
  links: PlayerLinkRecord[];
  activePlatform: PlayerLinkPlatform;
  loading: boolean;
  onRefresh: () => void;
  entitlement?: EntitlementInfo | null;
}) {
  const metadata = PLATFORM_METADATA[activePlatform];
  const activeLinks = links.filter((link) => link.active);
  const manualLinks = links.filter((link) => link.manual).length;
  const ownedChecks = links.reduce((count, link) => count + getOwnershipCount(link), 0);
  const atLimit =
    entitlement &&
    entitlement.tier === "free" &&
    typeof entitlement.limits.platformLinkMaxLinks === "number" &&
    links.length >= entitlement.limits.platformLinkMaxLinks;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={metadata.overviewTitle}
        description={metadata.description}
        actions={
          <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        }
      />
      {entitlement && entitlement.tier === "free" ? (
        <p className="text-xs text-muted-foreground">
          {links.length} / {entitlement.limits.platformLinkMaxLinks} links used
        </p>
      ) : entitlement ? (
        <p className="text-xs text-muted-foreground">Unlimited Platform Links under this plan.</p>
      ) : null}
      {atLimit ? <UpgradeBanner supportInvite={entitlement?.supportInvite ?? null} /> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard
          label="Linked members"
          value={activeLinks.length}
          detail={`${links.length - activeLinks.length} inactive retained link${links.length - activeLinks.length === 1 ? "" : "s"}`}
        />
        <MetricCard
          label="Manual links"
          value={manualLinks}
          detail={`Created with ${metadata.manualCommand}`}
        />
        {activePlatform === "steam" ? (
          <MetricCard
            label="Ownership checks"
            value={ownedChecks}
            detail="Stored game ownership results"
          />
        ) : null}
      </div>
    </div>
  );
}

function SteamLinkConfigForm({
  actions,
  draft,
  activePlatform,
  onChange,
  roles,
  channels,
  selectedGuildId,
  selectedWorkspaceId,
  autoSaveToggleStatus,
  onAutoSaveToggle,
}: {
  actions?: ReactNode;
  draft: PlayerLinkDraft;
  activePlatform: PlayerLinkPlatform;
  onChange: (draft: PlayerLinkDraft) => void;
  roles: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string }>;
  selectedGuildId: string;
  selectedWorkspaceId: string;
  autoSaveToggleStatus?: {
    savingKey: SteamLinkAutoSaveKey | null;
    savedKey: SteamLinkAutoSaveKey | null;
  };
  onAutoSaveToggle?: (key: SteamLinkAutoSaveKey, nextValue: boolean) => void;
}) {
  const metadata = PLATFORM_METADATA[activePlatform];
  return (
    <SettingsBlock>
      <SectionHeader
        actions={actions}
        title={`${metadata.title} configuration`}
        description="Choose the role members receive after linking, where link events are logged, and what members see on the public link panel."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          label={
            <span className="inline-flex items-center gap-1.5">
              {metadata.linkedRoleLabel}
              <InfoTooltip
                content="Associates a member's gaming account with their Discord user. Members get this role after linking their account."
                learnMoreHref="https://docs.hafbot.xyz/features/player-link"
              />
            </span>
          }
          htmlFor="steam-linked-role-id"
        >
          <RoleSelect
            id="steam-linked-role-id"
            roles={roles}
            value={draft.linkedRoleId}
            onChange={(value) => onChange({ ...draft, linkedRoleId: value })}
            creation={{
              guildId: selectedGuildId,
              workspaceId: selectedWorkspaceId,
              surfaceKey: "player_link",
              dependencyKey: "linked_role",
              label: `${metadata.title} role`,
              recommendedName: `${metadata.title} Linked`,
            }}
          />
        </FormField>
        <FormField
          label="Log channel"
          htmlFor="steam-log-channel-id"
          hint="Optional channel where successful links, failed links, and manual link actions are posted."
        >
          <ChannelSelect
            allowClear
            id="steam-log-channel-id"
            channels={channels}
            value={draft.logChannelId}
            onChange={(value) => onChange({ ...draft, logChannelId: value })}
            creation={{
              guildId: selectedGuildId,
              workspaceId: selectedWorkspaceId,
              surfaceKey: "player_link",
              dependencyKey: "log_channel",
              label: "log channel",
              recommendedName: `${activePlatform}-link-log`,
            }}
          />
        </FormField>
      </div>

      {activePlatform === "steam" ? <SteamAppIdEditor draft={draft} onChange={onChange} /> : null}

      <WhoisFieldEditor draft={draft} activePlatform={activePlatform} onChange={onChange} />

      {activePlatform === "steam" ? (
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <SectionHeader
            title="Custom links"
            description={
              <>
                Add profile links with <span className="font-mono">{"{steamId64}"}</span> in the
                URL.
              </>
            }
            actions={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  onChange({
                    ...draft,
                    customLinks: [...draft.customLinks, { label: "", url: "" }],
                  })
                }
              >
                Add custom link
              </Button>
            }
          />
          {draft.customLinks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom links configured.</p>
          ) : (
            <div className="space-y-3">
              {draft.customLinks.map((customLink, index) => (
                <div
                  key={index}
                  className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
                >
                  <Input
                    value={customLink.label}
                    onChange={(event) => {
                      const customLinks = [...draft.customLinks];
                      customLinks[index] = { ...customLink, label: event.target.value };
                      onChange({ ...draft, customLinks });
                    }}
                    placeholder="CFTools"
                    aria-label="Custom link label"
                  />
                  <Input
                    value={customLink.url}
                    onChange={(event) => {
                      const customLinks = [...draft.customLinks];
                      customLinks[index] = { ...customLink, url: event.target.value };
                      onChange({ ...draft, customLinks });
                    }}
                    placeholder="https://example.com/profile/{steamId64}"
                    aria-label="Custom link URL"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onChange({
                        ...draft,
                        customLinks: draft.customLinks.filter(
                          (_, linkIndex) => linkIndex !== index,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          label="Panel title"
          htmlFor="steam-panel-title"
          hint="Title shown at the top of the public account-linking panel."
        >
          <Input
            id="steam-panel-title"
            value={draft.panelTitle}
            onChange={(event) => onChange({ ...draft, panelTitle: event.target.value })}
            placeholder={metadata.defaultPanelTitle}
          />
        </FormField>
        <FormField
          label="Button label"
          htmlFor="steam-panel-button-label"
          hint="Text on the button members click to start linking."
        >
          <Input
            id="steam-panel-button-label"
            value={draft.panelButtonLabel}
            onChange={(event) => onChange({ ...draft, panelButtonLabel: event.target.value })}
            placeholder={metadata.defaultPanelButtonLabel}
          />
        </FormField>
      </div>

      <FormField
        label="Panel description"
        htmlFor="steam-panel-description"
        hint="Short explanation shown above the link button. Tell members what account they are linking and what happens next."
      >
        <textarea
          id="steam-panel-description"
          className="min-h-[6rem] w-full rounded-[3px] border bg-background/60 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={draft.panelDescription}
          placeholder={metadata.defaultPanelDescription}
          onChange={(event) => onChange({ ...draft, panelDescription: event.target.value })}
        />
      </FormField>

      <FormField
        label="Embed colour"
        htmlFor="steam-panel-color"
        hint="Side colour used by the public account-linking embed."
      >
        <ColorInput
          id="steam-panel-color"
          value={draft.panelColor}
          onChange={(panelColor) => onChange({ ...draft, panelColor })}
        />
      </FormField>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <FormField
          label="Button style"
          htmlFor="steam-panel-button-style"
          hint="Discord button colour used on the public link panel."
        >
          <select
            id="steam-panel-button-style"
            className="flex h-9 w-full rounded-[3px] border border-input bg-background/60 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={draft.panelButtonStyle}
            onChange={(event) =>
              onChange({
                ...draft,
                panelButtonStyle: event.target.value as PlatformLinkConfig["panelButtonStyle"],
              })
            }
          >
            {PANEL_BUTTON_STYLES.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </FormField>
        <label className="flex h-10 items-center gap-2 rounded-md border bg-background pl-3 pr-8 text-sm font-medium">
          <Switch
            checked={draft.allowRelink}
            loading={autoSaveToggleStatus?.savingKey === "allowRelink"}
            success={autoSaveToggleStatus?.savedKey === "allowRelink"}
            onCheckedChange={(checked) =>
              onAutoSaveToggle
                ? onAutoSaveToggle("allowRelink", checked)
                : onChange({ ...draft, allowRelink: checked })
            }
            aria-label="Allow relink"
          />
          Allow relink
        </label>
      </div>

      <label className="flex h-10 items-center gap-2 rounded-md border bg-background pl-3 pr-8 text-sm font-medium md:w-fit">
        <Switch
          checked={draft.allowMultipleLinks}
          loading={autoSaveToggleStatus?.savingKey === "allowMultipleLinks"}
          success={autoSaveToggleStatus?.savedKey === "allowMultipleLinks"}
          onCheckedChange={(checked) =>
            onAutoSaveToggle
              ? onAutoSaveToggle("allowMultipleLinks", checked)
              : onChange({ ...draft, allowMultipleLinks: checked })
          }
          aria-label="Allow multiple links per Discord user"
        />
        Allow multiple links per Discord user
      </label>

      <label className="flex min-h-10 items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium md:w-fit">
        <Switch
          checked={draft.requireRelinkOnRejoin}
          loading={autoSaveToggleStatus?.savingKey === "requireRelinkOnRejoin"}
          success={autoSaveToggleStatus?.savedKey === "requireRelinkOnRejoin"}
          onCheckedChange={(checked) =>
            onAutoSaveToggle
              ? onAutoSaveToggle("requireRelinkOnRejoin", checked)
              : onChange({ ...draft, requireRelinkOnRejoin: checked })
          }
          aria-label="Require relink after rejoining"
        />
        Require members to relink after leaving and rejoining
      </label>

      <FormField
        label="Panel publish channel"
        htmlFor="steam-panel-channel-id"
        hint="Channel where the account-linking panel should be posted when you click Publish panel."
      >
        <ChannelSelect
          id="steam-panel-channel-id"
          channels={channels}
          value={draft.panelChannelId}
          onChange={(value) => onChange({ ...draft, panelChannelId: value })}
          creation={{
            guildId: selectedGuildId,
            workspaceId: selectedWorkspaceId,
            surfaceKey: "player_link",
            dependencyKey: "panel_channel",
            label: "panel channel",
            recommendedName: `link-${activePlatform}`,
          }}
        />
      </FormField>
    </SettingsBlock>
  );
}

function SteamLinkPanelPreview({
  draft,
  activePlatform,
}: {
  draft: PlayerLinkDraft;
  activePlatform: PlayerLinkPlatform;
}) {
  const metadata = PLATFORM_METADATA[activePlatform];

  return (
    <SettingsBlock>
      <SectionHeader title="Panel preview" />
      <DiscordMessagePreview
        embedTitle={draft.panelTitle.trim() || metadata.defaultPanelTitle}
        embedDescription={draft.panelDescription.trim() || metadata.defaultPanelDescription}
        embedColor={formatHexColor(draft.panelColor)}
        buttons={[
          {
            label: draft.panelButtonLabel.trim() || metadata.defaultPanelButtonLabel,
            variant: mapDiscordButtonVariant(draft.panelButtonStyle),
          },
        ]}
      />
    </SettingsBlock>
  );
}

function SteamLinkCustomLinksTest({
  customLinks,
}: {
  customLinks: PlayerLinkDraft["customLinks"];
}) {
  const [sampleSteamId, setSampleSteamId] = useState("");
  const [testRequested, setTestRequested] = useState(false);
  const normalizedSteamId = sampleSteamId.trim();
  const sampleError = !normalizedSteamId
    ? "Enter a sample SteamID64."
    : /^\d{17}$/.test(normalizedSteamId)
      ? null
      : "SteamID64 must contain exactly 17 digits.";
  const resolved =
    testRequested && !sampleError
      ? resolveSteamLinkCustomLinks(customLinks, normalizedSteamId)
      : [];

  return (
    <SettingsBlock>
      <ConfigurationTestPanel
        sampleLabel="Sample SteamID64"
        sample={sampleSteamId}
        onSampleChange={setSampleSteamId}
        onTest={() => setTestRequested(true)}
        placeholder="76561198000000000"
        multiline={false}
        description="Resolve the current unsaved custom-link templates locally. No Steam or Discord request is made."
        result={
          testRequested ? (
            sampleError ? (
              <p className="rounded-[4px] border bg-background/70 p-3 text-sm text-destructive">
                {sampleError}
              </p>
            ) : resolved.length === 0 ? (
              <p className="rounded-[4px] border bg-background/70 p-3 text-sm text-muted-foreground">
                No custom links are configured.
              </p>
            ) : (
              <ul className="space-y-2 rounded-[4px] border bg-background/70 p-3 text-sm">
                {resolved.map((customLink, index) => (
                  <li key={`${customLink.label}-${index}`} className="space-y-1">
                    <p className="font-medium">{customLink.label || `Custom link ${index + 1}`}</p>
                    <p className="break-all font-mono text-xs">{customLink.url}</p>
                    {customLink.issue ? (
                      <p className="text-xs text-destructive">{customLink.issue}</p>
                    ) : (
                      <p className="text-xs text-emerald-600">Template resolved.</p>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : null
        }
      />
    </SettingsBlock>
  );
}

function SteamAppIdEditor({
  draft,
  onChange,
}: {
  draft: PlayerLinkDraft;
  onChange: (draft: PlayerLinkDraft) => void;
}) {
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const configured = parseGameAppIdsInput(draft.gameAppIds);

  function addEntries(raw: string) {
    const entries = raw
      .split(/[,\n]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (entries.length === 0) return;
    const invalid = entries.filter((value) => !/^\d+$/.test(value));
    const existing = new Set(configured);
    const duplicates = entries.filter((value) => /^\d+$/.test(value) && existing.has(value));
    const next = [...configured];
    for (const value of entries) {
      if (/^\d+$/.test(value) && !existing.has(value)) {
        existing.add(value);
        next.push(value);
      }
    }
    setError(
      invalid.length > 0
        ? `Invalid App ID${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}. Use numbers only.`
        : duplicates.length > 0
          ? `Already configured: ${duplicates.join(", ")}.`
          : null,
    );
    if (next.length !== configured.length) onChange({ ...draft, gameAppIds: next.join(", ") });
    setEntry("");
  }

  function clearAll() {
    if (typeof window !== "undefined" && !window.confirm("Clear all required Steam App IDs?")) {
      return;
    }
    onChange({ ...draft, gameAppIds: "" });
    setError(null);
  }

  return (
    <FormField
      label="Required Steam App IDs"
      htmlFor="steam-game-app-ids"
      hint="Add one ID at a time, or paste a comma/newline-separated list. Members must own these games to pass ownership checks."
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="steam-game-app-ids"
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (/[\n,]/.test(pasted)) {
                event.preventDefault();
                addEntries(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addEntries(entry);
              }
            }}
            placeholder="221100"
            inputMode="numeric"
            aria-describedby="steam-game-app-ids-help"
          />
          <Button type="button" variant="outline" onClick={() => addEntries(entry)}>
            Add App ID
          </Button>
        </div>
        <p id="steam-game-app-ids-help" className="text-xs text-muted-foreground">
          {configured.length} configured App ID{configured.length === 1 ? "" : "s"}.
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {configured.length > 0 ? (
          <div className="flex flex-wrap gap-2" aria-label="Configured Steam App IDs">
            {configured.map((appId) => (
              <span
                key={appId}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-2.5 py-1 text-xs"
              >
                <span className="font-medium">
                  {STEAM_APP_LABELS[appId] ?? `Steam App ${appId}`}
                </span>
                <span className="font-mono text-muted-foreground">({appId})</span>
                <button
                  type="button"
                  className="ml-1 rounded px-1 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove Steam App ${appId}`}
                  onClick={() =>
                    onChange({
                      ...draft,
                      gameAppIds: configured.filter((value) => value !== appId).join(", "),
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={clearAll}>
              Clear all
            </Button>
          </div>
        ) : null}
      </div>
    </FormField>
  );
}

function WhoisFieldEditor({
  draft,
  activePlatform,
  onChange,
}: {
  draft: PlayerLinkDraft;
  activePlatform: PlayerLinkPlatform;
  onChange: (draft: PlayerLinkDraft) => void;
}) {
  const options = getWhoisFieldOptions(activePlatform, draft.customLinks);
  const configured = parseCommaSeparatedInput(draft.whoisFields);
  const supported = new Set(options.map((option) => option.key));
  const unknown = configured.filter((value) => !supported.has(value));

  function toggle(key: string, checked: boolean) {
    const next = configured.filter((value) => value !== key);
    if (checked) next.push(key);
    onChange({ ...draft, whoisFields: next.join(", ") });
  }

  return (
    <FormField
      label="Whois fields"
      htmlFor="steam-whois-fields"
      hint="Choose the fields shown by staff lookup commands. An empty selection keeps the command's default fields."
    >
      <div id="steam-whois-fields" className="space-y-2 rounded-md border bg-background/40 p-3">
        {options.map((option) => (
          <label key={option.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={configured.includes(option.key)}
              onChange={(event) => toggle(option.key, event.target.checked)}
              aria-label={option.label}
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
        {unknown.length > 0 ? (
          <div className="border-t pt-2 text-xs">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              Unsupported saved fields
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {unknown.map((value) => (
                <span
                  key={value}
                  className="rounded-full border border-amber-500/50 px-2 py-0.5 font-mono"
                >
                  {value}
                </span>
              ))}
            </div>
            <p className="mt-1 text-muted-foreground">
              These values will be preserved until you remove them from the saved configuration.
            </p>
          </div>
        ) : null}
        <p className="pt-1 text-xs text-muted-foreground">
          {configured.length} configured field{configured.length === 1 ? "" : "s"}.
        </p>
      </div>
    </FormField>
  );
}

function SteamLinkLinksTable({
  links,
  activePlatform,
}: {
  links: PlayerLinkRecord[];
  activePlatform: PlayerLinkPlatform;
}) {
  const metadata = PLATFORM_METADATA[activePlatform];
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<"all" | "manual" | "provider">("all");
  const [ownershipFilter, setOwnershipFilter] = useState<"all" | "owned" | "not-owned" | "none">(
    "all",
  );
  const [recentWindow, setRecentWindow] = useState<"all" | "7" | "30" | "90">("all");
  const [copied, setCopied] = useState<string | null>(null);

  const now = Date.now();
  const query = search.trim().toLocaleLowerCase();
  const filteredLinks = links.filter((link) => {
    if (query && !`${link.userId} ${link.platformId}`.toLocaleLowerCase().includes(query))
      return false;
    if (originFilter === "manual" && !link.manual) return false;
    if (originFilter === "provider" && link.manual) return false;
    if (activePlatform === "steam" && ownershipFilter !== "all") {
      const ownership = parseSteamGameOwnership(link.metadataJson);
      const owned = ownership.some((entry) => entry.owned);
      if (ownershipFilter === "none" && ownership.length > 0) return false;
      if (ownershipFilter === "owned" && (!ownership.length || !owned)) return false;
      if (ownershipFilter === "not-owned" && (!ownership.length || owned)) return false;
    }
    if (recentWindow !== "all") {
      const ageMs = now - link.linkedAtMs;
      if (ageMs < 0 || ageMs > Number(recentWindow) * 24 * 60 * 60 * 1000) return false;
    }
    return true;
  });

  async function copy(value: string, key: string, label: string) {
    try {
      await copyTextToClipboard(value);
      setCopied(key);
      toast.success(`${label} copied.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not copy ${label.toLocaleLowerCase()}.`,
      );
    }
  }

  const commandName = `${activePlatform}link`;
  const command = `/${commandName} unlink user:<Discord user> ${activePlatform === "steam" ? "steamid:<platform ID>" : activePlatform === "xbox" ? "xuid:<platform ID>" : "psn_id:<platform ID>"}`;
  const columns: ResponsiveTableColumn<PlayerLinkRecord>[] = [
    {
      header: "Discord user ID",
      className: "font-mono text-xs",
      cell: (link) => (
        <div className="flex items-center gap-2">
          <span className="break-all">{link.userId}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void copy(link.userId, `${link.userId}:discord`, "Discord user ID")}
          >
            {copied === `${link.userId}:discord` ? "Copied" : "Copy"}
          </Button>
        </div>
      ),
    },
    {
      header: metadata.idLabel,
      className: "font-mono text-xs",
      cell: (link) => {
        const platformId = getLinkPlatformId(link);
        return (
          <div className="flex items-center gap-2">
            <span className="break-all">{platformId}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void copy(platformId, `${platformId}:platform`, metadata.idLabel)}
            >
              {copied === `${platformId}:platform` ? "Copied" : "Copy"}
            </Button>
          </div>
        );
      },
    },
    {
      header: "Trust / source",
      cell: (link) => <span>{getLinkTrustLabel(link, activePlatform)}</span>,
    },
    ...(activePlatform === "steam"
      ? [
          {
            header: "Ownership",
            cell: (link: PlayerLinkRecord) => (
              <div className="space-y-1">
                <span>{formatOwnershipSummary(link)}</span>
                <OwnershipDetails link={link} />
              </div>
            ),
          } satisfies ResponsiveTableColumn<PlayerLinkRecord>,
        ]
      : []),
    {
      header: "Status",
      cell: (link) => (link.active ? "Active" : "Inactive, relink required"),
    },
    {
      header: "Linked",
      cell: (link) => formatLinkedTime(link.linkedAtMs),
    },
  ];

  return (
    <EditorPanel>
      <SectionHeader
        title="Linked accounts"
        description="Search and filter loaded records to audit links. IDs are copied locally; unlinking and corrections still use Discord commands."
      />
      {links.length === 0 ? (
        <EmptyState>No linked accounts yet.</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
            <Input
              aria-label="Search linked accounts"
              placeholder="Search Discord or platform ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Link source filter"
              className="h-9 rounded-[3px] border bg-background/60 px-3 text-sm"
              value={originFilter}
              onChange={(event) => setOriginFilter(event.target.value as typeof originFilter)}
            >
              <option value="all">All sources</option>
              <option value="manual">Manual staff links</option>
              <option value="provider">Provider sign-ins</option>
            </select>
            {activePlatform === "steam" ? (
              <select
                aria-label="Ownership filter"
                className="h-9 rounded-[3px] border bg-background/60 px-3 text-sm"
                value={ownershipFilter}
                onChange={(event) =>
                  setOwnershipFilter(event.target.value as typeof ownershipFilter)
                }
              >
                <option value="all">All ownership results</option>
                <option value="owned">At least one owned</option>
                <option value="not-owned">No owned games</option>
                <option value="none">No check data</option>
              </select>
            ) : (
              <span />
            )}
            <select
              aria-label="Recent links filter"
              className="h-9 rounded-[3px] border bg-background/60 px-3 text-sm"
              value={recentWindow}
              onChange={(event) => setRecentWindow(event.target.value as typeof recentWindow)}
            >
              <option value="all">Any linked time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {filteredLinks.length} of {links.length} loaded record
            {links.length === 1 ? "" : "s"}.
          </p>
          <ResponsiveTable
            rows={filteredLinks}
            rowKey={(link) => `${link.guildId}:${link.userId}:${getLinkPlatformId(link)}`}
            columns={columns}
            emptyMessage="No linked accounts match these filters."
          />
          <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span>
              For unlinking or manual correction, run{" "}
              <code className="rounded bg-background px-1 py-0.5 font-mono">{command}</code>.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copy(command, "unlink-command", "Unlink command")}
            >
              {copied === "unlink-command" ? "Copied" : "Copy command"}
            </Button>
          </div>
        </div>
      )}
    </EditorPanel>
  );
}

export function getLinkTrustLabel(link: PlayerLinkRecord, platform: PlayerLinkPlatform): string {
  if (platform === "playstation" && link.actionedByUserId === null) {
    return "Member-submitted · unverified";
  }
  if (link.manual) return "Manual staff link";
  return `${PLATFORM_METADATA[platform].title.replace(" Link", "")} sign-in`;
}

function OwnershipDetails({ link }: { link: PlayerLinkRecord }) {
  const ownership = parseSteamGameOwnership(link.metadataJson);
  if (ownership.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">View details</summary>
      <ul className="mt-1 space-y-0.5">
        {ownership.map((entry) => (
          <li key={entry.appId}>
            {entry.name || `Steam App ${entry.appId}`}: {entry.owned ? "Owned" : "Not owned"}
            {entry.playtimeHours !== null ? ` · ${entry.playtimeHours}h` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatLinkedTime(timestampMs: number): string {
  const exact = new Date(timestampMs).toLocaleString();
  const ageMs = Math.max(0, Date.now() - timestampMs);
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return `${exact} (just now)`;
  if (minutes < 60) return `${exact} (${minutes}m ago)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${exact} (${hours}h ago)`;
  const days = Math.floor(hours / 24);
  return `${exact} (${days}d ago)`;
}

function MetricCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function createDraft(
  guildId: string,
  activePlatform: PlayerLinkPlatform,
  config: PlayerLinkConfig | null,
): PlayerLinkDraft {
  if (!config) {
    return createDefaultDraft(guildId, activePlatform);
  }

  return {
    guildId,
    linkedRoleId: getConfigLinkedRoleId(config),
    logChannelId: config.logChannelId ?? "",
    gameAppIds: config.gameAppIds.join(", "),
    whoisFields: config.whoisFields.join(", "),
    panelTitle: config.panelTitle ?? "",
    panelDescription: config.panelDescription ?? "",
    panelButtonLabel: config.panelButtonLabel ?? "",
    panelButtonStyle: config.panelButtonStyle ?? DEFAULT_PANEL_BUTTON_STYLE,
    panelColor: config.panelColor ?? getPlatformEmbedColor(activePlatform),
    allowRelink: config.allowRelink,
    allowMultipleLinks: config.allowMultipleLinks,
    requireRelinkOnRejoin: config.requireRelinkOnRejoin,
    panelChannelId: config.panelChannelId ?? "",
    customLinks: config.customLinks,
  };
}

function createDefaultDraft(guildId: string, activePlatform: PlayerLinkPlatform): PlayerLinkDraft {
  const metadata = PLATFORM_METADATA[activePlatform];
  return {
    guildId,
    linkedRoleId: "",
    logChannelId: "",
    gameAppIds: "",
    whoisFields: "",
    panelTitle: metadata.defaultPanelTitle,
    panelDescription: metadata.defaultPanelDescription,
    panelButtonLabel: metadata.defaultPanelButtonLabel,
    panelButtonStyle: DEFAULT_PANEL_BUTTON_STYLE,
    panelColor: getPlatformEmbedColor(activePlatform),
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    panelChannelId: "",
    customLinks: [],
  };
}

function createSteamLinkSaveSnapshot(
  draft: PlayerLinkDraft,
  activePlatform: PlayerLinkPlatform,
  metadata: (typeof PLATFORM_METADATA)[PlayerLinkPlatform],
) {
  return {
    guildId: draft.guildId,
    platform: activePlatform,
    linkedRoleId: draft.linkedRoleId.trim() || null,
    logChannelId: draft.logChannelId.trim() || null,
    gameAppIds: activePlatform === "steam" ? parseGameAppIdsInput(draft.gameAppIds) : [],
    whoisFields: parseCommaSeparatedInput(draft.whoisFields),
    customLinks:
      activePlatform === "steam"
        ? draft.customLinks
            .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
            .filter((link) => link.label.length > 0 && link.url.length > 0)
        : [],
    panelTitle: draft.panelTitle.trim() || metadata.defaultPanelTitle,
    panelDescription: draft.panelDescription.trim() || metadata.defaultPanelDescription,
    panelButtonLabel: draft.panelButtonLabel.trim() || metadata.defaultPanelButtonLabel,
    panelButtonStyle: draft.panelButtonStyle,
    panelColor: draft.panelColor,
    allowRelink: draft.allowRelink,
    allowMultipleLinks: draft.allowMultipleLinks,
    requireRelinkOnRejoin: draft.requireRelinkOnRejoin,
  };
}

function parseCommaSeparatedInput(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mapDiscordButtonVariant(
  style: PlatformLinkConfig["panelButtonStyle"],
): "primary" | "secondary" | "success" | "danger" {
  if (style === "Secondary") return "secondary";
  if (style === "Success") return "success";
  if (style === "Danger") return "danger";
  return "primary";
}

function getPlatformEmbedColor(activePlatform: PlayerLinkPlatform): number {
  if (activePlatform === "playstation") return 0x003791;
  if (activePlatform === "xbox") return 0x107c10;
  return 0x5865f2;
}

function getConfigLinkedRoleId(config: PlayerLinkConfig): string {
  return config.linkedRoleId ?? "";
}

function getLinkPlatformId(link: PlayerLinkRecord): string {
  return link.platformId;
}

function getOwnershipCount(link: PlayerLinkRecord): number {
  return parseSteamGameOwnership(link.metadataJson).length;
}

function formatOwnershipSummary(link: PlayerLinkRecord): string {
  const ownership = parseSteamGameOwnership(link.metadataJson);
  if (ownership.length === 0) {
    return "None";
  }

  const owned = ownership.filter((entry) => entry.owned).length;
  return `${owned}/${ownership.length} owned`;
}
