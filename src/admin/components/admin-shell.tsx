import { useEffect, useRef, useState, type ReactNode } from "react";

import { getPaidAdminFeature, type AdminDashboardPath } from "../dashboard-routes";
import { cn } from "../lib/utils";
import { AdminCommandPalette, captureCommandPaletteReturnFocus } from "./admin-command-palette";
import { AdminBottomActionBarProvider } from "./admin-bottom-action-bar";
import { AdminShellHeader, BrandMark } from "./admin-shell-header";
import { AdminShellNav, getCurrentPageLabel } from "./admin-shell-nav";
import { AdminShellSwitcher } from "./admin-shell-switcher";
import { AdminWorkspaceTabs, getAdminWorkspaceRouteId } from "./admin-workspace-tabs";
import { useAdminFeedback } from "./admin-feedback-dialog";
import { Button } from "./ui/button";
import {
  ActivityIcon,
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  ImageIcon,
  LayoutDashboardIcon,
  RadioIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  TicketIcon,
  UsersIcon,
  WrenchIcon,
  XIcon,
} from "./ui/icons";
import type {
  AdminGuildDirectoryEntry,
  UserPreferences,
  UserPreferencesPatch,
} from "../../runtime/admin-types";
import type { GuildEntitlementTier } from "../../types";
import type { AdminPageMetadata } from "../routes/context";
import type { ApplyUserPreferencesOptions } from "../hooks/use-user-preferences";
import { reportDashboardMilestone } from "../lib/product-analytics";

export function AdminShell({
  currentPath,
  currentSearch,
  guildDirectory,
  guildLookupError,
  selectedGuildId,
  onSelectedGuildChange,
  refreshGuildDirectory,
  selectedWorkspaceId,
  buildNavigationHref,
  playstationLinkEnabled,
  selectedGuildTier,
  userProfile,
  userPreferences,
  applyUserPreferencesPatch,
  pageMetadata,
  isRoutePending = false,
  children,
}: {
  currentPath: AdminDashboardPath;
  currentSearch: string;
  guildDirectory: AdminGuildDirectoryEntry[] | null;
  guildLookupError: string | null;
  selectedGuildId: string;
  onSelectedGuildChange: (nextGuildId: string) => void;
  refreshGuildDirectory: () => Promise<void>;
  selectedWorkspaceId: string;
  buildNavigationHref: (path: AdminDashboardPath) => string;
  playstationLinkEnabled: boolean;
  selectedGuildTier?: GuildEntitlementTier | null;
  userProfile: {
    name: string;
    image: string;
  };
  userPreferences: UserPreferences;
  applyUserPreferencesPatch: (
    patch: UserPreferencesPatch,
    options?: ApplyUserPreferencesOptions,
  ) => Promise<void>;
  pageMetadata: AdminPageMetadata | null;
  isRoutePending?: boolean;
  children: ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement>(null);
  const shellContentRef = useRef<HTMLDivElement>(null);
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const signOutAction = "/admin/logout";
  const currentPageLabel = getCurrentPageLabel(currentPath, selectedGuildId);
  const effectiveMetadata = pageMetadata ?? getDefaultPageMetadata(currentPath, currentPageLabel);
  const showRouteProgress = useMinimumVisible(isRoutePending, 300);
  const selectedGuild = guildDirectory?.find((guild) => guild.guildId === selectedGuildId);
  const currentRouteLocked =
    getPaidAdminFeaturePath(currentPath, selectedGuildId) !== null && selectedGuildTier === "free";
  const workspaceContextKey = `${selectedWorkspaceId || "no-workspace"}:${selectedGuildId || "no-guild"}`;

  // eslint-disable-next-line custom/no-use-effect -- Reports entry to the explicit billing surface.
  useEffect(() => {
    if (!selectedGuildId || !currentPath.endsWith("/billing")) return;
    void reportDashboardMilestone({
      guildId: selectedGuildId,
      workspaceId: selectedWorkspaceId,
      action: "upgrade_viewed",
    }).catch(() => undefined);
  }, [currentPath, selectedGuildId, selectedWorkspaceId]);

  const closeMobileNavigation = () => setMobileNavOpen(false);
  const toggleSidebar = () => setSidebarCollapsed((collapsed) => !collapsed);

  // eslint-disable-next-line custom/no-use-effect -- Coordinates modal focus, background inertness, and scroll locking.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const navigation = mobileNavigationRef.current;
    const shellContent = shellContentRef.current;
    const previousOverflow = document.body.style.overflow;
    shellContent?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";

    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      Array.from(navigation?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => {
          const style = window.getComputedStyle(element);
          return (
            !element.closest("[hidden]") &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        },
      );
    focusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      shellContent?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      mobileNavigationTriggerRef.current?.focus();
    };
  }, [mobileNavOpen]);

  return (
    <div
      className={cn(
        "admin-shell-root admin-operations-shell grid h-screen overflow-hidden bg-background text-foreground",
        sidebarCollapsed && "admin-sidebar-collapsed",
      )}
      data-current-path={currentPath}
    >
      <aside
        ref={mobileNavigationRef}
        role={mobileNavOpen ? "dialog" : undefined}
        aria-modal={mobileNavOpen ? "true" : undefined}
        aria-label={mobileNavOpen ? "Admin navigation" : undefined}
        className={cn(
          "admin-shell-sidebar fixed inset-y-0 left-0 z-50 flex min-h-0 w-[18rem] max-w-[calc(100vw-2rem)] flex-col border-r bg-card/95 text-card-foreground shadow-xl transition-all duration-200 lg:static lg:z-auto lg:w-[15.75rem] lg:max-w-none lg:shadow-none",
          sidebarCollapsed && "lg:w-16",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className={cn("admin-product-brand", sidebarCollapsed && "is-collapsed")}>
          <div className="admin-product-mark">
            <BrandMark />
          </div>
          <span>
            <strong>
              HAF <em>OPS DECK</em>
            </strong>
            <small>Guild administration</small>
          </span>
        </div>
        <MobileSidebarHeader onClose={() => setMobileNavOpen(false)} />
        <AdminShellSwitcher
          collapsed={sidebarCollapsed}
          menuOpen={switcherOpen}
          guildDirectory={guildDirectory}
          guildLookupError={guildLookupError}
          selectedGuildId={selectedGuildId}
          refreshGuildDirectory={refreshGuildDirectory}
          userPreferences={userPreferences}
          applyUserPreferencesPatch={applyUserPreferencesPatch}
          onToggleMenu={() => setSwitcherOpen((open) => !open)}
          onCloseMenu={() => setSwitcherOpen(false)}
          onSelectedGuildChange={(guildId) => {
            if (guildId !== selectedGuildId) {
              void reportDashboardMilestone({
                guildId,
                workspaceId: selectedWorkspaceId,
                action: "guild_selected",
              }).catch(() => undefined);
            }
            onSelectedGuildChange(guildId);
            closeMobileNavigation();
          }}
        />
        <AdminShellNav
          currentPath={currentPath}
          currentSearch={currentSearch}
          selectedGuildId={selectedGuildId}
          selectedGuildTier={selectedGuildTier}
          playstationLinkEnabled={playstationLinkEnabled}
          collapsed={sidebarCollapsed}
          buildNavigationHref={buildNavigationHref}
          onNavigate={closeMobileNavigation}
        />
        <SidebarFooter collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      </aside>
      {mobileNavOpen ? (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <div
        ref={shellContentRef}
        aria-hidden={mobileNavOpen ? "true" : undefined}
        className="admin-shell-content flex min-h-0 min-w-0 flex-col overflow-hidden"
      >
        <AdminWorkspaceTabs
          currentPath={currentPath}
          currentSearch={currentSearch}
          currentLabel={currentPageLabel}
          currentLocked={currentRouteLocked}
          selectedGuildId={selectedGuildId}
          contextKey={workspaceContextKey}
          overviewHref={buildNavigationHref("/admin")}
          showOverview
        />
        <AdminShellHeader
          pageMetadata={effectiveMetadata}
          sidebarCollapsed={sidebarCollapsed}
          accountMenuOpen={accountMenuOpen}
          billingHref={buildNavigationHref("/admin/billing")}
          profileHref={buildNavigationHref("/admin/profile")}
          showBilling
          signOutAction={signOutAction}
          userProfile={userProfile}
          selectedGuildId={selectedGuildId}
          selectedWorkspaceId={selectedWorkspaceId}
          onOpenMobileNavigation={() => setMobileNavOpen(true)}
          mobileNavigationTriggerRef={mobileNavigationTriggerRef}
          onToggleSidebar={toggleSidebar}
          onToggleAccountMenu={() => setAccountMenuOpen((open) => !open)}
          onCloseAccountMenu={() => setAccountMenuOpen(false)}
          onOpenCommandPalette={() => {
            captureCommandPaletteReturnFocus(commandPaletteReturnFocusRef);
            setCommandPaletteOpen(true);
          }}
        />
        <PageRouteProgress visible={showRouteProgress} />
        <AdminBottomActionBarProvider>
          <main
            id="admin-workspace-panel"
            role="tabpanel"
            aria-label={effectiveMetadata.title}
            aria-labelledby={`admin-workspace-tab-${getAdminWorkspaceRouteId(currentPath, selectedGuildId)}`}
            className="admin-shell-main min-h-0 min-w-0 overflow-auto p-4 md:p-7"
          >
            <div className="grid gap-6">
              <div className="min-w-0">{children}</div>
            </div>
          </main>
        </AdminBottomActionBarProvider>
        <AdminStatusBar
          guildName={selectedGuild?.label || selectedGuild?.name || "No Guild selected"}
          tier={selectedGuildTier ?? null}
          currentPageLabel={currentPageLabel}
        />
        <AdminCommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          returnFocusRef={commandPaletteReturnFocusRef}
          guildDirectory={guildDirectory}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={selectedGuildId}
        />
      </div>
    </div>
  );
}

function AdminStatusBar({
  guildName,
  tier,
  currentPageLabel,
}: {
  guildName: string;
  tier: GuildEntitlementTier | null;
  currentPageLabel: string;
}) {
  const openFeedback = useAdminFeedback();
  return (
    <footer className="admin-status-bar" aria-label="Admin status">
      <span className="admin-status-bar-item">
        <span className="admin-status-bar-pulse" aria-hidden="true" />
        {guildName}
      </span>
      {tier ? <span className="admin-status-bar-item">{formatStatusTier(tier)} plan</span> : null}
      <span className="admin-status-bar-spacer" />
      <span className="admin-status-bar-item">Active: {currentPageLabel}</span>
      {openFeedback ? (
        <button
          type="button"
          className="admin-status-bar-item underline"
          onClick={() => openFeedback()}
        >
          Send feedback
        </button>
      ) : null}
    </footer>
  );
}

function formatStatusTier(tier: GuildEntitlementTier) {
  return tier === "premium_plus" ? "Premium Plus" : tier === "premium" ? "Premium" : "Free";
}

function getPaidAdminFeaturePath(currentPath: string, selectedGuildId: string) {
  const guildPrefix = selectedGuildId ? `/admin/${encodeURIComponent(selectedGuildId)}` : "";
  const canonicalPath =
    guildPrefix && currentPath.startsWith(`${guildPrefix}/`)
      ? `/admin/${currentPath.slice(guildPrefix.length + 1)}`
      : currentPath;
  return getPaidAdminFeature(canonicalPath);
}

function PageRouteProgress({ visible }: { visible: boolean }) {
  return (
    <div className="pointer-events-none relative z-10 h-0 shrink-0 overflow-visible bg-transparent">
      {visible ? (
        <>
          <div
            role="progressbar"
            aria-label="Loading page"
            className="admin-route-progress-bar absolute left-0 top-0 h-1 w-1/3 bg-accent"
          />
          <span role="status" aria-live="polite" className="sr-only">
            Loading page...
          </span>
        </>
      ) : null}
    </div>
  );
}

function useMinimumVisible(active: boolean, minimumMs: number) {
  const [visible, setVisible] = useState(active);

  // eslint-disable-next-line custom/no-use-effect -- Synchronizes route pending state with a browser timer.
  useEffect(() => {
    if (active) {
      setVisible(true);
      return undefined;
    }

    const timeout = window.setTimeout(() => setVisible(false), minimumMs);
    return () => window.clearTimeout(timeout);
  }, [active, minimumMs]);

  return visible;
}

function getDefaultPageMetadata(
  currentPath: AdminDashboardPath,
  currentPageLabel: string,
): AdminPageMetadata {
  const pageKey = getPageMetadataKey(currentPath);
  const metadata = DEFAULT_PAGE_METADATA[pageKey];

  if (metadata) {
    return metadata;
  }

  return {
    title: currentPageLabel,
    description: "Manage this HAF Bot dashboard area.",
    icon: <LayoutDashboardIcon className="h-6 w-6" />,
  };
}

const DEFAULT_PAGE_METADATA: Record<string, AdminPageMetadata> = {
  overview: {
    title: "Overview",
    description: "See what is configured in this guild at a glance.",
    icon: <LayoutDashboardIcon className="h-6 w-6" />,
  },
  billing: {
    title: "Billing",
    description: "Choose, inspect, and manage your HAF Subscription.",
    icon: <ShieldIcon className="h-6 w-6" />,
  },
  troubleshooting: {
    title: "Troubleshooting",
    description: "Run permission diagnostics for the selected Discord server.",
    icon: <WrenchIcon className="h-6 w-6" />,
  },
  profile: {
    title: "Profile",
    description: "Manage your admin identity, guild access, and dashboard preferences.",
    icon: <SettingsIcon className="h-6 w-6" />,
  },
  blocklist: {
    title: "Reaction Rules",
    description: "Control blocked emoji reactions and reaction limit enforcement.",
    icon: <BanIcon className="h-6 w-6" />,
  },
  "timed-roles": {
    title: "Timed Roles",
    description: "Assign temporary roles and automate role expiry workflows.",
    icon: <ClockIcon className="h-6 w-6" />,
  },
  "reaction-roles": {
    title: "Reaction Roles",
    description: "Let members choose game roles by reacting to a welcome message.",
    icon: <ActivityIcon className="h-6 w-6" />,
  },
  tickets: {
    title: "Tickets",
    description: "Configure how your guild handles support tickets.",
    icon: <TicketIcon className="h-6 w-6" />,
  },
  "managed-messages": {
    title: "Managed Messages",
    description: "Publish durable bot-owned information messages with rich embeds.",
    icon: <ActivityIcon className="h-6 w-6" />,
  },
  commerce: {
    title: "Commerce",
    description: "Configure paid Discord roles and monitor seller operations.",
    icon: <ActivityIcon className="h-6 w-6" />,
  },
  marketplace: {
    title: "Marketplace",
    description: "Configure marketplace notices, moderation, and listing visibility.",
    icon: <ShieldIcon className="h-6 w-6" />,
  },
  lfg: {
    title: "LFG",
    description: "Manage looking-for-group notices and community coordination.",
    icon: <UsersIcon className="h-6 w-6" />,
  },
  clans: {
    title: "Clan Management",
    description: "Configure managed Clans and review Clan creation requests.",
    icon: <UsersIcon className="h-6 w-6" />,
  },
  playercount: {
    title: "Player Count",
    description: "Keep live player counts in sync with Discord channel names.",
    icon: <ServerIcon className="h-6 w-6" />,
  },
  "player-link": {
    title: "Player Link",
    description: "Connect Discord members to external platform accounts and roles.",
    icon: <RadioIcon className="h-6 w-6" />,
  },
  "evidence-vault": {
    title: "Evidence Vault",
    description: "Configure audit storage and access for moderation evidence.",
    icon: <ShieldIcon className="h-6 w-6" />,
  },
  "image-rules": {
    title: "Image Rules",
    description:
      "Automatically classify image attachments against a topic and route off-topic uploads.",
    icon: <ImageIcon className="h-6 w-6" />,
  },
  "bot-defense": {
    title: "Bot Defense",
    description: "Detect automated accounts with honeypot and repeated-message signals.",
    icon: <ShieldIcon className="h-6 w-6" />,
  },
  "member-verification": {
    title: "Member Verification",
    description:
      "DM new members a configurable welcome embed and grant a Verified Role when they click Verify.",
    icon: <ShieldIcon className="h-6 w-6" />,
  },
  webhooks: {
    title: "Webhooks",
    description: "Proxy inbound webhook traffic and route payloads to Discord destinations.",
    icon: <ActivityIcon className="h-6 w-6" />,
  },
  "audit-log": {
    title: "Guild Audit Log",
    description: "Review recorded moderation events and configuration changes for this Guild.",
    icon: <ActivityIcon className="h-6 w-6" />,
  },
};

function getPageMetadataKey(currentPath: AdminDashboardPath): string {
  const trimmedPath = currentPath.replace(/\/$/, "");
  if (trimmedPath === "/admin") return "overview";

  const segments = trimmedPath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? "overview";
  if (DEFAULT_PAGE_METADATA[lastSegment]) return lastSegment;
  if (segments.length === 2 && segments[0] === "admin") return "overview";
  return lastSegment;
}

function MobileSidebarHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="admin-mobile-brand flex items-center justify-between p-4 lg:hidden">
      <div className="flex items-center gap-3">
        <span className="admin-mobile-brand-mark">
          <BrandMark />
        </span>
        <div>
          <strong>
            HAF <em>OPS DECK</em>
          </strong>
          <small>Guild administration</small>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9"
        aria-label="Close navigation menu"
        onClick={onClose}
      >
        <XIcon className="h-4 w-4" />
      </Button>
    </div>
  );
}

function SidebarFooter({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="mt-auto border-t p-3">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "hidden w-full justify-start gap-2 text-xs text-muted-foreground hover:text-foreground lg:flex",
          collapsed && "justify-center px-2",
        )}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggle}
      >
        {collapsed ? (
          <ChevronRightIcon className="h-4 w-4" />
        ) : (
          <ChevronLeftIcon className="h-4 w-4" />
        )}
        <span className={cn(collapsed && "lg:hidden")}>Collapse sidebar</span>
      </Button>
    </div>
  );
}
