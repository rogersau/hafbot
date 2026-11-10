import { Link, useRouterState } from "@tanstack/react-router";

import { getAdminGuideUrl } from "../dashboard-routes";
import { Button } from "./ui/button";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LogOutIcon,
  MenuIcon,
  MessagesSquareIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
} from "./ui/icons";
import { useRef, type RefObject } from "react";
import type { AdminPageMetadata } from "../routes/context";
import { useAdminFeedback } from "./admin-feedback-dialog";
import { reportDashboardMilestone } from "../lib/product-analytics";

export function AdminShellHeader({
  pageMetadata,
  sidebarCollapsed,
  accountMenuOpen,
  billingHref,
  profileHref,
  showBilling,
  signOutAction,
  userProfile,
  selectedGuildId = "",
  selectedWorkspaceId = "",
  onOpenMobileNavigation,
  onToggleSidebar,
  onToggleAccountMenu,
  onCloseAccountMenu,
  onOpenCommandPalette,
  mobileNavigationTriggerRef,
}: {
  pageMetadata: AdminPageMetadata;
  sidebarCollapsed: boolean;
  accountMenuOpen: boolean;
  billingHref: string;
  profileHref: string;
  showBilling: boolean;
  signOutAction: string;
  userProfile: {
    name: string;
    image: string;
  };
  selectedGuildId?: string;
  selectedWorkspaceId?: string;
  onOpenMobileNavigation: () => void;
  onToggleSidebar: () => void;
  onToggleAccountMenu: () => void;
  onCloseAccountMenu: () => void;
  onOpenCommandPalette: () => void;
  mobileNavigationTriggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const accountMenuId = "admin-account-menu";
  const userName = userProfile.name.trim() || "Admin User";
  const userImage = userProfile.image.trim();
  const currentPath = useRouterState({ select: (state) => state.location.pathname });
  const guideUrl = getAdminGuideUrl(currentPath);
  const openFeedback = useAdminFeedback();
  const accountMenuTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <header
      className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card/70 px-4 text-card-foreground backdrop-blur md:px-6 admin-shell-header"
      aria-label={`${pageMetadata.title} controls`}
    >
      <Button
        ref={mobileNavigationTriggerRef}
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 lg:hidden"
        aria-label="Open navigation menu"
        onClick={onOpenMobileNavigation}
      >
        <MenuIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="hidden h-9 w-9 lg:inline-flex"
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggleSidebar}
      >
        {sidebarCollapsed ? (
          <ChevronRightIcon className="h-4 w-4" />
        ) : (
          <ChevronLeftIcon className="h-4 w-4" />
        )}
      </Button>
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        {pageMetadata.actions ? (
          <div className="hidden flex-wrap items-center gap-2 lg:flex">{pageMetadata.actions}</div>
        ) : null}
        <Button asChild variant="outline" size="sm" className="h-9">
          <a
            href={guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View guide"
            title="View guide"
            onClick={() => {
              void reportDashboardMilestone({
                guildId: selectedGuildId,
                workspaceId: selectedWorkspaceId,
                action: "help_opened",
              }).catch(() => undefined);
            }}
          >
            View guide
          </a>
        </Button>
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label="Open command palette"
          data-command-palette-trigger="true"
          onClick={onOpenCommandPalette}
        >
          <SearchIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="hidden truncate sm:inline">Search…</span>
          <kbd className="ml-1 hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground md:inline">
            ⌘K
          </kbd>
        </button>
        <div className="relative">
          <button
            ref={accountMenuTriggerRef}
            type="button"
            className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-muted"
            aria-haspopup="menu"
            aria-label={`Open account menu for ${userName}`}
            aria-expanded={accountMenuOpen}
            aria-controls={accountMenuOpen ? accountMenuId : undefined}
            onClick={onToggleAccountMenu}
          >
            <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-primary text-primary-foreground">
              {userImage ? (
                <img src={userImage} alt={userName} className="h-full w-full object-cover" />
              ) : (
                <UserIcon className="h-4 w-4" />
              )}
            </span>
            <span className="hidden text-foreground md:inline">{userName}</span>
            <ChevronDownIcon className="h-3 w-3 text-muted-foreground" />
          </button>
          <div hidden={!accountMenuOpen}>
            {accountMenuOpen ? (
              <button
                type="button"
                aria-label="Close account menu"
                className="fixed inset-0 z-40 bg-transparent"
                onClick={onCloseAccountMenu}
              />
            ) : null}
            <div
              id={accountMenuId}
              role="menu"
              className="absolute right-0 top-full z-50 mt-2 w-56 rounded-[4px] border bg-card p-1 text-card-foreground shadow-lg"
            >
              <div className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Account
              </div>
              <Link
                to={profileHref}
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={onCloseAccountMenu}
              >
                <SettingsIcon className="h-4 w-4 text-muted-foreground" />
                Profile
              </Link>
              {showBilling ? (
                <Link
                  to={billingHref}
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={onCloseAccountMenu}
                >
                  <ShieldIcon className="h-4 w-4 text-muted-foreground" />
                  Billing
                </Link>
              ) : null}
              {openFeedback ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onCloseAccountMenu();
                    openFeedback({ returnFocus: accountMenuTriggerRef.current });
                  }}
                >
                  Send feedback
                </button>
              ) : null}
              <a
                href="/changelog"
                target="_blank"
                rel="noreferrer"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={onCloseAccountMenu}
              >
                <ShieldIcon className="h-4 w-4 text-muted-foreground" />
                What's New
              </a>
              <a
                href="https://discord.gg/HpRPkdm6dv"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={onCloseAccountMenu}
              >
                <MessagesSquareIcon className="h-4 w-4 text-muted-foreground" />
                Support
              </a>
              <div className="my-1 h-px bg-border" />
              <form method="post" action={signOutAction}>
                <button
                  type="submit"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-muted"
                >
                  <LogOutIcon className="h-4 w-4" />
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export function BrandMark() {
  return (
    <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[4px] border border-accent/50 bg-[#05070b] p-0.5">
      <img src="/logo.png" alt="" aria-hidden="true" className="h-full w-full object-contain" />
    </span>
  );
}
