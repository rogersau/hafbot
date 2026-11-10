import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../lib/utils";
import type { TicketInstance, TicketPanelConfig } from "../../types";
import type {
  TicketSetupCheck,
  TicketSetupCheckResponse,
  TicketTestAction,
} from "../../runtime/admin-types";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import { UpgradeBanner } from "./upgrade-banner";
import { AdminTabs } from "./admin-tabs";
import { TicketPanelEditor, type GuildResources } from "./ticket-panel-editor";
import {
  TicketSetupWizard,
  formatTicketSetupWizardMinimumErrors,
  validateTicketSetupWizardMinimum,
} from "./ticket-setup-wizard";
import { AdminBottomActionBar, areAdminActionSnapshotsEqual } from "./admin-bottom-action-bar";
import { NoGuildSelected } from "./no-guild-selected";
import { NavigationGuard } from "./navigation-guard";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { EmptyState } from "./ui/empty-state";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { AlertTriangleIcon, CheckIcon, RefreshIcon, TicketIcon, ChevronDownIcon } from "./ui/icons";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { useConfirmDialog } from "./ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { useAdminApi } from "../hooks/use-admin-api";
import { useAutoSaveToggle } from "../hooks/use-auto-save-toggle";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { ticketsClient } from "../generated/admin-client/tickets";
import type { TicketsLoaderData } from "../lib/admin-route-loaders";
import { useAdminRouteContext } from "../routes/page-context";
import { buildTicketsTabHref } from "../lib/admin-route-state";
import { AdminPageHeader } from "./admin-page-header";
import { AdminRefreshNotice } from "./admin-refresh-notice";
import { adminRefreshWarning, reconcileAdminMutation } from "../lib/mutation-reconciliation";
import { firstTicketModalFieldValidationIssue } from "../../tickets/validation";

type TicketAutoSaveKey = "enableTicketClaiming" | "aiTranscriptSummariesEnabled";

interface NavigationLocationLike {
  pathname?: string;
  searchStr?: string;
}

interface PendingPanelAction {
  title: string;
  description: string;
  continueAction: () => void | Promise<void>;
}

export function isTicketsTabOnlyNavigation({
  current,
  next,
}: {
  current: unknown;
  next: unknown;
}): boolean {
  const currentLocation = current as NavigationLocationLike;
  const nextLocation = next as NavigationLocationLike;
  if (!currentLocation.pathname || currentLocation.pathname !== nextLocation.pathname) {
    return false;
  }

  const currentParams = new URLSearchParams(currentLocation.searchStr ?? "");
  const nextParams = new URLSearchParams(nextLocation.searchStr ?? "");
  currentParams.delete("tab");
  currentParams.delete("wizard");
  nextParams.delete("tab");
  nextParams.delete("wizard");
  return currentParams.toString() === nextParams.toString();
}

export function validateTicketPanelBeforeSubmit(panel: TicketPanelConfig): string | null {
  const setupError = formatTicketSetupWizardMinimumErrors(validateTicketSetupWizardMinimum(panel));
  if (setupError) return setupError;

  const modalFieldError = firstTicketModalFieldValidationIssue(panel);
  if (modalFieldError) return modalFieldError.message;

  return validateTicketCreationLimit(panel.ticketCreationLimit);
}

export function AdminTicketsPage({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  initialData?: TicketsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Tickets"
        description="Configure how your guild handles support tickets."
        readinessFeature="tickets"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      <TicketPanelsEditor
        selectedWorkspaceId={selectedWorkspaceId}
        selectedGuildId={selectedGuildId}
        entitlement={entitlement}
        initialData={initialData}
        onRouteDataRefresh={onRouteDataRefresh}
      />
    </section>
  );
}

function emptyPanelConfig(guildId: string): TicketPanelConfig {
  return {
    guildId,
    panelId: "main",
    panelName: "Main panel",
    panelChannelId: "",
    categoryChannelId: "",
    transcriptChannelId: "",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [],
  };
}

function TicketPanelsEditor({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  initialData?: TicketsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const [guildResources, setGuildResources] = useState<GuildResources | null>(
    initialData?.resources ?? null,
  );
  const [panelConfig, setPanelConfig] = useState<TicketPanelConfig | null>(
    initialData?.panel ?? null,
  );
  const [panels, setPanels] = useState<TicketPanelConfig[]>(initialData?.panels ?? []);
  const [savedPanelConfig, setSavedPanelConfig] = useState<TicketPanelConfig | null>(
    initialData?.panel ?? null,
  );
  const [closedTickets, setClosedTickets] = useState<TicketInstance[]>(
    initialData?.closedTicketsPage.tickets ?? [],
  );
  const [closedTicketsTotal, setClosedTicketsTotal] = useState(
    initialData?.closedTicketsPage.total ?? 0,
  );
  const [closedTicketsNextCursor, setClosedTicketsNextCursor] = useState<number | null>(
    initialData?.closedTicketsPage.nextCursor ?? null,
  );
  const [setupCheck, setSetupCheck] = useState<TicketSetupCheckResponse | null>(
    initialData?.setupCheck ?? null,
  );
  const [editorVersion, setEditorVersion] = useState(0);
  const [loadedGuildId, setLoadedGuildId] = useState<string>(
    initialData ? selectedGuildId.trim() : "",
  );
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [testActionLoading, setTestActionLoading] = useState<TicketTestAction | null>(null);
  const [testActionMessage, setTestActionMessage] = useState<string | null>(null);
  const [testActionError, setTestActionError] = useState<string | null>(null);
  const [pendingPanelAction, setPendingPanelAction] = useState<PendingPanelAction | null>(null);
  const [pendingPanelActionBusy, setPendingPanelActionBusy] = useState(false);
  const trimmedGuildId = selectedGuildId.trim();
  const api = useAdminApi();
  const toast = useToast();
  const { setPageMetadata, ticketsTab, currentSearch } = useAdminRouteContext();
  const navigate = useNavigate();
  const wizardFromUrl = new URLSearchParams(currentSearch).get("wizard") === "1";
  const [showWizard, setShowWizard] = useState(wizardFromUrl);
  const { dialog: confirmDialog, confirm } = useConfirmDialog();

  async function loadResources(id: string, refreshDiscordCache = false) {
    const normalized = id.trim();
    if (!normalized) {
      setGuildResources(null);
      setPanelConfig(null);
      setPanels([]);
      setSavedPanelConfig(null);
      setClosedTickets([]);
      setClosedTicketsTotal(0);
      setClosedTicketsNextCursor(null);
      setSetupCheck(null);
      setLoadedGuildId("");
      return;
    }

    await api.run(
      async () => {
        const routePanelId = getRoutePanelId();
        const query = {
          workspaceId: selectedWorkspaceId || undefined,
          guildId: normalized,
        };
        const [resources, panelData, closedTicketsPage, nextSetupCheck] = await Promise.all([
          ticketsClient.resources({
            ...query,
            ...(refreshDiscordCache ? { refresh: "1" } : {}),
          }),
          ticketsClient.panel(query).catch(() => ({ panel: null, panels: [] })),
          ticketsClient
            .closed({ ...query, limit: "20", ...(routePanelId ? { panelId: routePanelId } : {}) })
            .catch(emptyClosedTicketsPage),
          ticketsClient
            .setupCheck({ ...query, ...(routePanelId ? { panelId: routePanelId } : {}) })
            .catch(() => emptyTicketSetupCheck(normalized)),
        ]);
        const loadedPanels =
          panelData.panels && panelData.panels.length > 0 ? panelData.panels : [];
        const panel =
          loadedPanels.find((entry) => entry.panelId === routePanelId) ??
          panelData.panel ??
          emptyPanelConfig(normalized);
        return {
          resources,
          panel,
          panels: loadedPanels.length > 0 ? loadedPanels : [panel],
          closedTicketsPage,
          setupCheck: nextSetupCheck,
        };
      },
      (result) => {
        setGuildResources(result.resources);
        setPanelConfig(result.panel);
        setSavedPanelConfig(result.panel);
        setPanels(result.panels);
        setClosedTickets(result.closedTicketsPage.tickets);
        setClosedTicketsTotal(result.closedTicketsPage.total);
        setClosedTicketsNextCursor(result.closedTicketsPage.nextCursor);
        setSetupCheck(result.setupCheck);
        setEditorVersion((current) => current + 1);
        setLoadedGuildId(normalized);
      },
    );
  }

  async function loadMoreClosedTickets() {
    if (!closedTicketsNextCursor) return;
    await api.run(
      async () => {
        return ticketsClient
          .closed({
            workspaceId: selectedWorkspaceId || undefined,
            guildId: loadedGuildId,
            beforeOpenedAtMs: String(closedTicketsNextCursor),
            ...(panelConfig?.panelId ? { panelId: panelConfig.panelId } : {}),
          })
          .catch(emptyClosedTicketsPage);
      },
      (page) => {
        setClosedTickets((current) => [...current, ...page.tickets]);
        setClosedTicketsTotal(page.total);
        setClosedTicketsNextCursor(page.nextCursor);
      },
    );
  }

  const hasUnsavedChanges =
    panelConfig !== null && !areTicketPanelConfigsEqual(panelConfig, savedPanelConfig);
  const debouncedTicketCreationLimit = useDebouncedValue(panelConfig?.ticketCreationLimit ?? null);
  const ticketCreationLimitError = validateTicketCreationLimit(debouncedTicketCreationLimit);
  const autoSave = useAutoSaveToggle<TicketAutoSaveKey>({
    onSave: async (key, nextValue) => {
      if (!panelConfig) return;
      const nextPanelConfig = { ...panelConfig, [key]: nextValue };
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        () =>
          ticketsClient.savePanel({
            ...nextPanelConfig,
            workspaceId: selectedWorkspaceId || undefined,
          }),
        onRouteDataRefresh,
      );
      setPanelConfig((current) => (current ? { ...current, [key]: nextValue } : current));
      setSavedPanelConfig((current) => (current ? { ...current, [key]: nextValue } : current));
      setPanels((current) => {
        const existing = current.find(
          (entry) => (entry.panelId ?? "main") === (nextPanelConfig.panelId ?? "main"),
        );
        return replacePanel(current, {
          ...(existing ?? nextPanelConfig),
          [key]: nextValue,
        });
      });
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Ticket preference save", nextRefreshError));
      } else setRefreshError(null);
    },
  });

  function discardChanges() {
    setPanelConfig(savedPanelConfig);
    setEditorVersion((current) => current + 1);
    setSaveMessage(null);
    setSaveError(null);
    setSaveAttempted(false);
    api.setError(null);
  }

  async function handleDiscardChanges() {
    const confirmed = await confirm({
      title: "Discard ticket panel changes?",
      description: "This restores the last saved ticket panel settings on this page.",
      confirmLabel: "Discard changes",
      variant: "destructive",
    });
    if (confirmed) discardChanges();
  }

  async function handleSave(): Promise<boolean> {
    if (!panelConfig) return false;
    setSaveAttempted(true);
    const validationError = validateTicketPanelBeforeSubmit(panelConfig);
    if (validationError) {
      setSaveError(validationError);
      return false;
    }
    setSaving(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      await ticketsClient.savePanel({
        ...panelConfig,
        workspaceId: selectedWorkspaceId || undefined,
      });
      setSaveMessage("Panel configuration saved.");
      setSaveAttempted(false);
      toast.success("Panel configuration saved.");
      setSavedPanelConfig(panelConfig);
      setPanels((current) => replacePanel(current, panelConfig));
      const refreshResult = await reconcileAdminMutation(async () => undefined, onRouteDataRefresh);
      if (refreshResult.refreshError) {
        setRefreshError(refreshResult.refreshError);
        toast.info(adminRefreshWarning("Ticket panel save", refreshResult.refreshError));
      }
      await reloadSetupCheck(panelConfig.panelId ?? "main");
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Failed to save panel config.";
      toast.error(error);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!panelConfig) return;
    setSaveAttempted(true);
    const validationError = validateTicketPanelBeforeSubmit(panelConfig);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setPublishing(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      const data = await ticketsClient.publishPanel({
        ...panelConfig,
        workspaceId: selectedWorkspaceId || undefined,
      });
      let publishedPanelConfig = panelConfig;
      if (data.panelMessageId) {
        publishedPanelConfig = { ...panelConfig, panelMessageId: data.panelMessageId };
        setPanelConfig(publishedPanelConfig);
      }
      setSavedPanelConfig(publishedPanelConfig);
      setPanels((current) => replacePanel(current, publishedPanelConfig));
      setSaveMessage("Panel published to Discord.");
      setSaveAttempted(false);
      toast.success("Panel published to Discord.");
      const { refreshError: nextRefreshError } = await reconcileAdminMutation(
        async () => undefined,
        onRouteDataRefresh,
      );
      if (nextRefreshError) {
        setRefreshError(nextRefreshError);
        toast.info(adminRefreshWarning("Ticket panel publish", nextRefreshError));
      } else setRefreshError(null);
      await reloadSetupCheck(publishedPanelConfig.panelId ?? "main");
    } catch (err) {
      const error = err instanceof Error ? err.message : "Failed to publish panel.";
      toast.error(error);
    } finally {
      setPublishing(false);
    }
  }

  // eslint-disable-next-line custom/no-use-effect -- Synchronizes route-owned page metadata with the shell.
  useEffect(() => {
    setPageMetadata({
      title: "Tickets",
      description: "Configure how your guild handles support tickets.",
      icon: <TicketIcon className="h-6 w-6" />,
    });
  }, [setPageMetadata]);

  const tabs: { id: "setup" | "panel" | "types" | "rules" | "closed"; label: string }[] = [
    { id: "setup", label: "Setup Check" },
    { id: "panel", label: "Panel" },
    { id: "types", label: "Types" },
    { id: "rules", label: "Rules" },
    { id: "closed", label: "Closed Tickets" },
  ];

  function handleTabChange(nextTab: "setup" | "panel" | "types" | "rules" | "closed") {
    if (typeof window === "undefined") return;
    void navigate({
      to: buildTicketsTabHref(`${window.location.pathname}${window.location.search}`, nextTab),
    });
  }

  function handlePanelChangeNow(panelId: string) {
    const nextPanel = panels.find((panel) => panel.panelId === panelId);
    if (!nextPanel || typeof window === "undefined") return;
    setPanelConfig(nextPanel);
    setSavedPanelConfig(nextPanel);
    setEditorVersion((current) => current + 1);
    setClosedTickets([]);
    setClosedTicketsTotal(0);
    setClosedTicketsNextCursor(null);
    setSetupCheck(null);
    void navigate({
      to: buildTicketsPanelHref(`${window.location.pathname}${window.location.search}`, panelId),
    });
    void reloadClosedTickets(panelId);
    void reloadSetupCheck(panelId);
  }

  function requestPanelAction(action: PendingPanelAction) {
    if (!hasUnsavedChanges) {
      void action.continueAction();
      return;
    }
    setPendingPanelAction(action);
  }

  function handlePanelChange(panelId: string) {
    const nextPanel = panels.find((panel) => panel.panelId === panelId);
    if (!nextPanel || nextPanel.panelId === panelConfig?.panelId) return;
    requestPanelAction({
      title: "Switch ticket panel?",
      description: "Your current Ticket Panel draft has unsaved changes.",
      continueAction: () => handlePanelChangeNow(panelId),
    });
  }

  async function reloadClosedTickets(panelId: string) {
    await api.run(
      async () => {
        return ticketsClient
          .closed({
            workspaceId: selectedWorkspaceId || undefined,
            guildId: loadedGuildId,
            panelId,
          })
          .catch(emptyClosedTicketsPage);
      },
      (page) => {
        setClosedTickets(page.tickets);
        setClosedTicketsTotal(page.total);
        setClosedTicketsNextCursor(page.nextCursor);
      },
    );
  }

  async function reloadSetupCheck(panelId: string | null = panelConfig?.panelId ?? null) {
    if (!loadedGuildId) return;
    setSetupCheck(
      await ticketsClient
        .setupCheck({
          workspaceId: selectedWorkspaceId || undefined,
          guildId: loadedGuildId,
          ...(panelId ? { panelId } : {}),
        })
        .catch(() => emptyTicketSetupCheck(loadedGuildId)),
    );
  }

  async function handleCreatePanelNow(mode: "blank" | "clone") {
    if (!panelConfig) return;
    setSaveMessage(null);
    setSaveError(null);
    await api.run(
      async () =>
        ticketsClient
          .createPanel({
            workspaceId: selectedWorkspaceId || undefined,
            guildId: loadedGuildId,
            mode,
            sourcePanelId: panelConfig.panelId,
          })
          .then((res) => res.panel),
      (panel) => {
        setPanels((current) => [...current, panel]);
        setPanelConfig(panel);
        setSavedPanelConfig(panel);
        setEditorVersion((current) => current + 1);
        toast.success(`${panel.panelName ?? "Panel"} created.`);
        if (typeof window !== "undefined" && panel.panelId) {
          void navigate({
            to: buildTicketsPanelHref(
              `${window.location.pathname}${window.location.search}`,
              panel.panelId,
            ),
          });
        }
      },
      (message) => toast.error(message),
    );
  }

  function handleCreatePanel(mode: "blank" | "clone") {
    requestPanelAction({
      title: mode === "blank" ? "Create a blank Ticket Panel?" : "Clone this Ticket Panel?",
      description: "Your current Ticket Panel draft has unsaved changes.",
      continueAction: () => handleCreatePanelNow(mode),
    });
  }

  async function saveAndContinuePanelAction() {
    if (!pendingPanelAction) return;
    setPendingPanelActionBusy(true);
    const savedSuccessfully = await handleSave();
    setPendingPanelActionBusy(false);
    if (!savedSuccessfully) return;
    const action = pendingPanelAction;
    setPendingPanelAction(null);
    await action.continueAction();
  }

  function discardPanelAction() {
    if (!pendingPanelAction) return;
    const action = pendingPanelAction;
    setPendingPanelAction(null);
    discardChanges();
    void action.continueAction();
  }

  async function handleUnpublish() {
    if (!panelConfig?.panelId) return;
    const confirmed = await confirm({
      title: "Unpublish ticket panel?",
      description:
        "This removes the published panel message from Discord when the backend can reach it. Saved configuration stays intact.",
      confirmLabel: "Unpublish panel",
      variant: "destructive",
    });
    if (!confirmed) return;

    setSaveMessage(null);
    setSaveError(null);
    await api.run(
      async () =>
        ticketsClient
          .unpublishPanel({
            workspaceId: selectedWorkspaceId || undefined,
            guildId: loadedGuildId,
            panelId: panelConfig.panelId!,
          })
          .then(({ panel }) => panel),
      (panel) => {
        setPanelConfig(panel);
        setSavedPanelConfig(panel);
        setPanels((current) => replacePanel(current, panel));
        toast.success("Panel unpublished.");
      },
      (message) => toast.error(message),
    );
  }

  async function handleDeleteOrReset() {
    if (!panelConfig?.panelId) return;
    const onlyPanel = panels.length <= 1;
    const confirmed = await confirm({
      title: onlyPanel ? "Restore panel defaults?" : "Delete ticket panel?",
      description: onlyPanel
        ? "This restores this ticket panel to defaults. Existing open tickets will block the reset."
        : "This deletes this ticket panel. Existing open tickets will block deletion.",
      confirmLabel: onlyPanel ? "Restore defaults" : "Delete panel",
      variant: "destructive",
    });
    if (!confirmed) return;
    setSaveMessage(null);
    setSaveError(null);
    await api.run(
      async () => {
        await ticketsClient.deletePanel({
          workspaceId: selectedWorkspaceId || undefined,
          guildId: loadedGuildId,
          panelId: panelConfig.panelId!,
        });
        return onlyPanel
          ? emptyPanelConfig(loadedGuildId)
          : (panels.find((panel) => panel.panelId !== panelConfig.panelId) ?? null);
      },
      (nextPanel) => {
        const nextPanels = onlyPanel
          ? [nextPanel ?? emptyPanelConfig(loadedGuildId)]
          : panels.filter((panel) => panel.panelId !== panelConfig.panelId);
        const selected = nextPanel ?? nextPanels[0] ?? emptyPanelConfig(loadedGuildId);
        setPanels(nextPanels);
        setPanelConfig(selected);
        setSavedPanelConfig(selected);
        setEditorVersion((current) => current + 1);
        toast.success(onlyPanel ? "Panel defaults restored." : "Panel deleted.");
      },
      (message) => toast.error(message),
    );
  }

  async function handleRunTicketTestAction(action: TicketTestAction) {
    if (!panelConfig?.panelId || !loadedGuildId) return;
    setTestActionLoading(action);
    setTestActionMessage(null);
    setTestActionError(null);
    try {
      const result = await ticketsClient.testAction({
        workspaceId: selectedWorkspaceId,
        guildId: loadedGuildId,
        panelId: panelConfig.panelId,
        action,
      });
      if (result.ok) {
        setTestActionMessage(result.message);
        toast.success(result.message);
        await reloadSetupCheck(panelConfig.panelId);
      } else if (result.status === "skipped") {
        setTestActionMessage(result.message);
      } else {
        setTestActionError(result.message);
      }
    } catch (error) {
      setTestActionError(error instanceof Error ? error.message : "Failed to run ticket test.");
    } finally {
      setTestActionLoading(null);
    }
  }

  const typesCount = panelConfig?.ticketTypes.length ?? 0;
  const atTypesLimit =
    entitlement &&
    entitlement.tier === "free" &&
    typeof entitlement.limits.ticketsMaxTypesPerPanel === "number" &&
    typesCount >= entitlement.limits.ticketsMaxTypesPerPanel;
  const atPanelsLimit =
    entitlement &&
    entitlement.tier === "free" &&
    typeof entitlement.limits.ticketsMaxPanels === "number" &&
    panels.length >= entitlement.limits.ticketsMaxPanels;

  return (
    <div className="space-y-4">
      <NavigationGuard
        hasChanges={hasUnsavedChanges}
        onDiscardChanges={discardChanges}
        allowNavigation={isTicketsTabOnlyNavigation}
      />
      <AdminRefreshNotice action="Tickets" error={refreshError} refresh={onRouteDataRefresh} />
      {confirmDialog}
      <Dialog
        open={pendingPanelAction !== null}
        onOpenChange={(open) => {
          if (!open && !pendingPanelActionBusy) setPendingPanelAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingPanelAction?.title}</DialogTitle>
            <DialogDescription>{pendingPanelAction?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={pendingPanelActionBusy}
              onClick={() => setPendingPanelAction(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingPanelActionBusy}
              onClick={discardPanelAction}
            >
              Discard and continue
            </Button>
            <Button
              type="button"
              loading={pendingPanelActionBusy}
              disabled={pendingPanelActionBusy}
              onClick={() => void saveAndContinuePanelAction()}
            >
              Save and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UnsavedChangesIndicator hasChanges={hasUnsavedChanges} />
      <AdminTabs
        tabs={tabs}
        activeTab={ticketsTab === "history" ? "panel" : ticketsTab}
        ariaLabel="Ticket settings"
        className="-mt-4 mb-4 bg-background md:-mt-7 md:mb-7"
        onTabChange={handleTabChange}
        leftContent={
          panelConfig ? (
            <PanelTabDropdown
              panels={panels}
              selectedPanelId={panelConfig.panelId ?? "main"}
              status={getPanelPublishStatus(panelConfig, hasUnsavedChanges)}
              onSelect={handlePanelChange}
              onCreateBlank={() => void handleCreatePanel("blank")}
              onClone={() => void handleCreatePanel("clone")}
              canCreatePanel={!atPanelsLimit}
              onUnpublish={() => void handleUnpublish()}
              onDeleteOrReset={() => void handleDeleteOrReset()}
            />
          ) : null
        }
      />
      <PageFeedback message={null} error={api.error} />
      {entitlement && entitlement.tier === "free" ? (
        <p className="text-xs text-muted-foreground">
          {typesCount} / {entitlement.limits.ticketsMaxTypesPerPanel} types per panel
        </p>
      ) : null}
      {atTypesLimit || atPanelsLimit ? (
        <UpgradeBanner supportInvite={entitlement?.supportInvite ?? null} />
      ) : null}
      {!trimmedGuildId ? (
        <NoGuildSelected
          feature="ticket panel"
          description="Pick a server from the sidebar to load its ticket panel. We will fetch live Discord data automatically."
        />
      ) : api.error && !guildResources ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <Alert variant="destructive">
              <AlertDescription>{api.error}</AlertDescription>
            </Alert>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={api.loading}
              onClick={() => void loadResources(trimmedGuildId, true)}
            >
              <RefreshIcon className="h-4 w-4" />
              Load ticket panel
            </Button>
          </CardContent>
        </Card>
      ) : api.loading && !guildResources ? (
        <TicketPanelSkeleton />
      ) : !guildResources || !panelConfig ? (
        <TicketPanelSkeleton />
      ) : showWizard && ticketsTab === "panel" ? (
        <>
          <TicketSetupWizard
            guildResources={guildResources}
            selectedGuildId={trimmedGuildId}
            selectedWorkspaceId={selectedWorkspaceId}
            value={panelConfig}
            onChange={setPanelConfig}
            onSaveDraft={() =>
              void handleSave().then((didSave) => {
                if (didSave) setShowWizard(false);
              })
            }
            onSaveAndPublish={() => void handlePublish().then(() => setShowWizard(false))}
          />
          {saveError ? (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowWizard(false)}>
              Use full editor
            </Button>
          </div>
        </>
      ) : (
        <>
          {ticketsTab === "panel" &&
          !panelConfig.panelMessageId &&
          panelConfig.ticketTypes.length === 0 ? (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowWizard(true)}>
                Start setup wizard
              </Button>
            </div>
          ) : null}
          {ticketsTab === "setup" && (
            <TicketSetupCheckSection
              setupCheck={setupCheck ?? emptyTicketSetupCheck(loadedGuildId)}
              hasUnsavedChanges={hasUnsavedChanges}
              loadingAction={testActionLoading}
              message={testActionMessage}
              error={testActionError}
              onRefresh={() => void reloadSetupCheck(panelConfig.panelId ?? "main")}
              onRunTest={(action) => void handleRunTicketTestAction(action)}
            />
          )}
          {ticketsTab !== "closed" && ticketsTab !== "setup" && ticketsTab !== "history" && (
            <TicketPanelEditor
              key={`${loadedGuildId}:${editorVersion}`}
              guildResources={guildResources}
              value={panelConfig}
              onChange={setPanelConfig}
              tab={ticketsTab}
              ticketCreationLimitError={ticketCreationLimitError}
              saveAttempted={saveAttempted}
              paidAutomationAvailable={entitlement?.tier !== "free"}
              ticketTypeLimitReached={Boolean(atTypesLimit)}
              autoSaveToggleStatus={{
                savingKey: autoSave.savingKey,
                savedKey: autoSave.savedKey,
              }}
              onAutoSaveToggle={(key, nextValue) => {
                const previousValue = Boolean(panelConfig[key]);
                void autoSave.saveToggle({
                  key,
                  nextValue,
                  previousValue,
                  applyValue: (value) =>
                    setPanelConfig((current) => (current ? { ...current, [key]: value } : current)),
                  hasUnrelatedChanges: hasUnsavedChanges,
                  successMessage:
                    key === "enableTicketClaiming"
                      ? "Saved ticket claiming preference."
                      : "Saved AI transcript summaries preference.",
                });
              }}
            />
          )}
          {saveError && (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          {ticketsTab === "closed" && (
            <ClosedTicketsSection
              workspaceId={selectedWorkspaceId}
              guildId={loadedGuildId}
              tickets={closedTickets}
              total={closedTicketsTotal}
              nextCursor={closedTicketsNextCursor}
              loading={api.loading}
              onLoadMore={loadMoreClosedTickets}
            />
          )}
          {ticketsTab !== "setup" ? (
            <TicketPanelActions
              saving={saving}
              publishing={publishing}
              saved={saveMessage === "Panel configuration saved."}
              saveDisabled={!hasUnsavedChanges || saving || publishing}
              publishDisabled={publishing || saving}
              discardDisabled={!hasUnsavedChanges || saving || publishing}
              onSave={() => void handleSave()}
              onPublish={() => void handlePublish()}
              onDiscard={() => void handleDiscardChanges()}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function TicketSetupCheckSection({
  setupCheck,
  hasUnsavedChanges,
  loadingAction,
  message,
  error,
  onRefresh,
  onRunTest,
}: {
  setupCheck: TicketSetupCheckResponse;
  hasUnsavedChanges: boolean;
  loadingAction: TicketTestAction | null;
  message: string | null;
  error: string | null;
  onRefresh: () => void;
  onRunTest: (action: TicketTestAction) => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">Ticket Setup Check</CardTitle>
            <Badge variant={setupStatusBadgeVariant(setupCheck.overallStatus)}>
              {setupStatusLabel(setupCheck.overallStatus)}
            </Badge>
          </div>
          <Button type="button" size="sm" variant="outline" className="gap-2" onClick={onRefresh}>
            <RefreshIcon className="h-4 w-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasUnsavedChanges ? (
            <Alert>
              <AlertDescription>
                Save this panel before running tests. Test actions use the saved Discord setup.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="divide-y rounded-md border">
            {setupCheck.checks.map((check) => (
              <TicketSetupCheckRow key={check.id} check={check} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {setupCheck.testActions.map((action) => (
              <Button
                key={action.action}
                type="button"
                size="sm"
                variant="outline"
                disabled={hasUnsavedChanges || !action.enabled || loadingAction !== null}
                className="gap-2"
                title={action.reason ?? undefined}
                onClick={() => onRunTest(action.action)}
              >
                {loadingAction === action.action ? (
                  <RefreshIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckIcon className="h-4 w-4" />
                )}
                {loadingAction === action.action ? "Testing..." : action.label}
              </Button>
            ))}
          </div>
          {message ? (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function TicketSetupCheckRow({ check }: { check: TicketSetupCheck }) {
  const Icon = check.status === "ok" ? CheckIcon : AlertTriangleIcon;
  return (
    <div className="grid gap-3 p-4 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] md:items-start">
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          className={cn(
            "h-4 w-4",
            check.status === "ok"
              ? "text-emerald-300"
              : check.status === "warning"
                ? "text-amber-300"
                : "text-red-300",
          )}
        />
        <span className="truncate text-sm font-medium">{check.label}</span>
      </div>
      <p className="min-w-0 text-sm text-muted-foreground">{check.detail}</p>
      <Badge variant={setupStatusBadgeVariant(check.status)}>
        {setupStatusLabel(check.status)}
      </Badge>
    </div>
  );
}

function PanelTabDropdown({
  panels,
  selectedPanelId,
  status,
  onSelect,
  onCreateBlank,
  onClone,
  canCreatePanel,
  onUnpublish,
  onDeleteOrReset,
}: {
  panels: TicketPanelConfig[];
  selectedPanelId: string;
  status: string;
  onSelect: (panelId: string) => void;
  onCreateBlank: () => void;
  onClone: () => void;
  canCreatePanel: boolean;
  onUnpublish: () => void;
  onDeleteOrReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const selectedPanel = panels.find((panel) => (panel.panelId ?? "main") === selectedPanelId);

  return (
    <div className="relative">
      <button
        type="button"
        className="relative flex min-w-[8rem] items-center justify-center gap-2 px-4 py-2 text-center text-sm font-display font-semibold text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => {
          setOpen((prev) => !prev);
          setCreateMode(false);
        }}
      >
        <span className="max-w-[10rem] truncate">{selectedPanel?.panelName ?? "Main panel"}</span>
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full shrink-0",
            status === "Published"
              ? "bg-green-500"
              : status === "Needs publish"
                ? "bg-amber-500"
                : "bg-muted-foreground",
          )}
        />
        <ChevronDownIcon className="h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close panel menu"
            className="fixed inset-0 z-40 bg-transparent"
            onClick={() => {
              setOpen(false);
              setCreateMode(false);
            }}
          />
          <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border bg-popover text-popover-foreground shadow-md">
            {!createMode ? (
              <div className="py-1">
                {panels.map((panel) => (
                  <button
                    key={panel.panelId ?? "main"}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent",
                      (panel.panelId ?? "main") === selectedPanelId && "bg-accent/50",
                    )}
                    onClick={() => {
                      onSelect(panel.panelId ?? "main");
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{panel.panelName ?? "Main panel"}</span>
                    {(panel.panelId ?? "main") === selectedPanelId && (
                      <span className="ml-2 inline-block h-2 w-2 rounded-full bg-accent" />
                    )}
                  </button>
                ))}
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-2 text-sm font-medium text-primary hover:bg-accent"
                  disabled={!canCreatePanel}
                  title={!canCreatePanel ? "Free supports one Ticket Panel." : undefined}
                  onClick={() => setCreateMode(true)}
                >
                  {canCreatePanel ? "Create New Panel" : "One-panel Free limit reached"}
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    onUnpublish();
                    setOpen(false);
                  }}
                >
                  Unpublish
                </button>
                <button
                  type="button"
                  className="flex w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    onDeleteOrReset();
                    setOpen(false);
                  }}
                >
                  {panels.length <= 1 ? "Restore defaults" : "Delete panel"}
                </button>
              </div>
            ) : (
              <div className="py-1">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Create New Panel
                </div>
                <button
                  type="button"
                  className="flex w-full px-3 py-2 text-sm hover:bg-accent"
                  onClick={() => {
                    onCreateBlank();
                    setOpen(false);
                    setCreateMode(false);
                  }}
                >
                  Blank
                </button>
                <button
                  type="button"
                  className="flex w-full px-3 py-2 text-sm hover:bg-accent"
                  onClick={() => {
                    onClone();
                    setOpen(false);
                    setCreateMode(false);
                  }}
                >
                  Clone from {selectedPanel?.panelName ?? "Main panel"}
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
                  onClick={() => setCreateMode(false)}
                >
                  Back
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function replacePanel(panels: TicketPanelConfig[], panel: TicketPanelConfig): TicketPanelConfig[] {
  const panelId = panel.panelId ?? "main";
  const index = panels.findIndex((entry) => (entry.panelId ?? "main") === panelId);
  if (index === -1) return [...panels, panel];
  return panels.map((entry, entryIndex) => (entryIndex === index ? panel : entry));
}

function getPanelPublishStatus(panel: TicketPanelConfig, hasUnsavedChanges: boolean): string {
  if (!panel.panelMessageId) return "Unpublished";
  return hasUnsavedChanges ? "Needs publish" : "Published";
}

function getRoutePanelId(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("panelId")?.trim() ?? "";
}

function buildTicketsPanelHref(href: string, panelId: string): string {
  const [pathnameAndSearch = ""] = href.split("#");
  const [pathname = "", search = ""] = pathnameAndSearch.split("?");
  const params = new URLSearchParams(search);
  params.set("panelId", panelId);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function TicketPanelActions({
  saving,
  publishing,
  saved,
  saveDisabled,
  publishDisabled,
  discardDisabled,
  onSave,
  onPublish,
  onDiscard,
}: {
  saving: boolean;
  publishing: boolean;
  saved: boolean;
  saveDisabled: boolean;
  publishDisabled: boolean;
  discardDisabled: boolean;
  onSave: () => void;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  return (
    <AdminBottomActionBar
      actions={[
        {
          label: "Discard changes",
          disabled: discardDisabled,
          variant: "outline",
          onClick: onDiscard,
        },
        {
          label: "Publish Panel",
          loadingLabel: "Publishing…",
          loading: publishing,
          disabled: publishDisabled,
          variant: "secondary",
          onClick: onPublish,
        },
        {
          label: "Save Changes",
          loadingLabel: "Saving…",
          loading: saving,
          successLabel: "Saved",
          success: saved,
          disabled: saveDisabled,
          variant: "accent",
          onClick: onSave,
        },
      ]}
    />
  );
}

export function areTicketPanelConfigsEqual(
  current: TicketPanelConfig | null,
  saved: TicketPanelConfig | null,
): boolean {
  return areAdminActionSnapshotsEqual(current, saved);
}

export function validateTicketCreationLimit(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1)
    return "Ticket creation limit must be a positive integer.";
  if (value > 50) return "Ticket creation limit cannot be higher than 50.";
  return null;
}

function emptyClosedTicketsPage() {
  return { tickets: [], total: 0, nextCursor: null };
}

export function ClosedTicketsSection({
  workspaceId,
  guildId,
  tickets,
  total,
  nextCursor,
  loading,
  onLoadMore,
}: {
  workspaceId?: string;
  guildId: string;
  tickets: TicketInstance[];
  total: number;
  nextCursor: number | null;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const toast = useToast();
  const [transcriptUrls, setTranscriptUrls] = useState<Record<string, string>>({});
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);
  const transcriptKey = (channelId: string) => `${guildId}:${channelId}`;

  async function generateTranscriptLink(channelId: string) {
    const key = transcriptKey(channelId);
    setPendingTranscript(key);
    try {
      const result = await ticketsClient.rotateTranscript({
        workspaceId: workspaceId || undefined,
        guildId,
        channelId,
      });
      setTranscriptUrls((current) => ({ ...current, [key]: result.url }));
      toast.success("Generated a new 30-day transcript link.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not generate the transcript link.",
      );
    } finally {
      setPendingTranscript(null);
    }
  }

  async function revokeTranscriptLink(channelId: string) {
    const key = transcriptKey(channelId);
    setPendingTranscript(key);
    try {
      await ticketsClient.revokeTranscript({
        workspaceId: workspaceId || undefined,
        guildId,
        channelId,
      });
      setTranscriptUrls((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      toast.success("Revoked the transcript link.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the transcript link.");
    } finally {
      setPendingTranscript(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Closed Tickets</CardTitle>
        <p className="text-sm text-muted-foreground">
          Read-only transcript access for tickets that have already been closed.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {`${tickets.length} of ${total} closed tickets`}
        </p>
        {tickets.length === 0 ? (
          <EmptyState>No closed tickets found for this server.</EmptyState>
        ) : (
          <ClosedTicketsTable
            guildId={guildId}
            tickets={tickets}
            transcriptUrls={transcriptUrls}
            pendingTranscript={pendingTranscript}
            onGenerateLink={generateTranscriptLink}
            onRevokeLink={revokeTranscriptLink}
          />
        )}
        {nextCursor !== null ? (
          <Button type="button" variant="outline" disabled={loading} onClick={onLoadMore}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatClosedAt(value: number | null): string {
  return value === null ? "Unknown" : new Date(value).toLocaleString();
}

function ClosedTicketsTable({
  guildId,
  tickets,
  transcriptUrls,
  pendingTranscript,
  onGenerateLink,
  onRevokeLink,
}: {
  guildId: string;
  tickets: TicketInstance[];
  transcriptUrls: Record<string, string>;
  pendingTranscript: string | null;
  onGenerateLink: (channelId: string) => void;
  onRevokeLink: (channelId: string) => void;
}) {
  const columns: ResponsiveTableColumn<TicketInstance>[] = [
    {
      header: "Channel name/ID",
      cell: (ticket) => <span className="font-mono text-xs">{ticket.channelId}</span>,
      className: "font-mono text-xs",
    },
    { header: "Type", cell: (ticket) => ticket.ticketTypeLabel },
    {
      header: "Opened by",
      cell: (ticket) => <span className="font-mono text-xs">{ticket.openerUserId}</span>,
      className: "font-mono text-xs",
    },
    { header: "Closed at", cell: (ticket) => formatClosedAt(ticket.closedAtMs) },
    {
      header: "Transcript",
      cell: (ticket) => {
        const key = `${guildId}:${ticket.channelId}`;
        const transcriptUrl = transcriptUrls[key];
        const pending = pendingTranscript === key;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onGenerateLink(ticket.channelId)}
            >
              {pending ? "Working…" : transcriptUrl ? "Regenerate link" : "Generate link"}
            </Button>
            {transcriptUrl ? (
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={transcriptUrl}
                target="_blank"
                rel="noreferrer"
              >
                View transcript
              </a>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onRevokeLink(ticket.channelId)}
            >
              Revoke
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <ResponsiveTable
      rows={tickets}
      rowKey={(ticket) => ticket.channelId}
      columns={columns}
      emptyMessage="No closed tickets found for this server."
    />
  );
}

function emptyTicketSetupCheck(guildId: string): TicketSetupCheckResponse {
  return {
    guildId,
    panelId: null,
    overallStatus: "warning",
    checks: [
      {
        id: "setup-check",
        label: "Setup check",
        status: "warning",
        detail: "Ticket setup checks could not be loaded. Refresh this page and try again.",
      },
    ],
    testActions: [],
  };
}

function setupStatusLabel(status: TicketSetupCheck["status"]): string {
  if (status === "ok") return "Ready";
  if (status === "warning") return "Needs attention";
  return "Blocked";
}

function setupStatusBadgeVariant(
  status: TicketSetupCheck["status"],
): "success" | "warning" | "danger" {
  if (status === "ok") return "success";
  if (status === "warning") return "warning";
  return "danger";
}

function TicketPanelSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex items-center justify-between">
          <SkeletonBar className="h-3 w-48" />
          <SkeletonBar className="h-9 w-44" />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <SkeletonField />
          <SkeletonField />
          <SkeletonField />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <SkeletonField />
          <SkeletonField />
        </div>
        <SkeletonField tall />
        <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
          <SkeletonBar className="h-4 w-32" />
          <SkeletonBar className="h-3 w-72" />
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonField({ tall = false }: { tall?: boolean }) {
  return (
    <div className="space-y-2">
      <SkeletonBar className="h-3 w-24" />
      <SkeletonBar className={tall ? "h-24 w-full" : "h-10 w-full"} />
    </div>
  );
}

function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted/40 ${className}`.trim()} />;
}
