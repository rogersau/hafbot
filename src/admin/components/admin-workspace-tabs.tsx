import { useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import type { GuildEntitlementTier } from "../../types";
import { getPaidAdminFeature } from "../dashboard-routes";

import { cn } from "../lib/utils";
import { useAdminSession, useAdminSessionState } from "../lib/admin-session";
import { LockIcon, XIcon } from "./ui/icons";

export interface AdminWorkspaceTab {
  id: string;
  label: string;
  href: string;
  pinned: boolean;
}

export interface AdminWorkspaceTabHistory {
  contextKey: string;
  tabs: AdminWorkspaceTab[];
  recentIds: string[];
}

export function adminWorkspaceContextKey(workspaceId: string, guildId: string) {
  return `${workspaceId || "no-workspace"}:${guildId || "no-guild"}`;
}

export function recordAdminWorkspaceVisit(
  history: AdminWorkspaceTabHistory | null,
  contextKey: string,
  overviewHref: string,
  current: AdminWorkspaceTab,
): AdminWorkspaceTabHistory {
  const previous = history?.contextKey === contextKey ? history : null;
  return {
    contextKey,
    tabs: upsertAdminWorkspaceTab(previous?.tabs ?? [overviewTab(overviewHref)], current),
    recentIds: [...(previous?.recentIds.filter((id) => id !== current.id) ?? []), current.id],
  };
}

export function upsertAdminWorkspaceTab(
  tabs: AdminWorkspaceTab[],
  nextTab: AdminWorkspaceTab,
): AdminWorkspaceTab[] {
  if (!tabs.some((tab) => tab.id === nextTab.id)) return [...tabs, nextTab];
  return tabs.map((tab) => (tab.id === nextTab.id ? { ...tab, ...nextTab } : tab));
}

export function getAdminWorkspaceCloseTarget(
  tabs: AdminWorkspaceTab[],
  recentIds: string[],
  closingId: string,
): AdminWorkspaceTab | null {
  const targetId = [...recentIds]
    .reverse()
    .find((id) => id !== closingId && tabs.some((tab) => tab.id === id));
  return tabs.find((tab) => tab.id === targetId) ?? tabs.find((tab) => tab.pinned) ?? null;
}

export function getAdminWorkspaceRouteId(pathname: string, selectedGuildId: string): string {
  const path = pathname.replace(/\/$/, "");
  if (path === "/admin") return "overview";

  const guildPrefix = selectedGuildId ? `/admin/${encodeURIComponent(selectedGuildId)}` : "";
  if (guildPrefix && path === guildPrefix) return "overview";
  if (guildPrefix && path.startsWith(`${guildPrefix}/`)) {
    const section = path.slice(guildPrefix.length + 1);
    return section;
  }

  return path.slice("/admin/".length) || "overview";
}

export function AdminWorkspaceTabs({
  currentPath,
  currentSearch,
  currentLabel,
  selectedGuildTier,
  selectedGuildId,
  contextKey,
  overviewHref,
  showOverview,
}: {
  currentPath: string;
  currentSearch: string;
  currentLabel: string;
  selectedGuildTier?: GuildEntitlementTier | null;
  selectedGuildId: string;
  contextKey: string;
  overviewHref: string;
  showOverview: boolean;
}) {
  const router = useRouter();
  const session = useAdminSession();
  const currentId = getAdminWorkspaceRouteId(currentPath, selectedGuildId);
  const currentHref = `${currentPath}${currentSearch}`;
  const tabState = useAdminSessionState((state) => state.workspaceTabs);
  const currentTabState = tabState?.contextKey === contextKey ? tabState : null;
  const currentTab: AdminWorkspaceTab = {
    id: currentId,
    label: currentLabel,
    href: currentHref,
    pinned: showOverview && currentId === "overview",
  };
  const tabs = upsertAdminWorkspaceTab(
    currentTabState?.tabs ?? (showOverview ? [overviewTab(overviewHref)] : []),
    currentTab,
  );
  const recentIds = currentTabState?.recentIds ?? [currentId];
  const pendingFocusRef = useRef<string | null>(null);

  const activateTab = (tab: AdminWorkspaceTab) => {
    if (tab.id === currentId) return;
    pendingFocusRef.current = tab.id;
    void router.navigate({ to: tab.href });
  };

  const moveTabFocus = (tab: AdminWorkspaceTab, key: string) => {
    const index = tabs.findIndex((openTab) => openTab.id === tab.id);
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? tabs.length - 1
          : key === "ArrowLeft"
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (nextTab) activateTab(nextTab);
  };

  const closeTab = async (tab: AdminWorkspaceTab) => {
    if (tab.pinned) return;
    if (tab.id === currentId) {
      const target = getAdminWorkspaceCloseTarget(tabs, recentIds, tab.id);
      if (!target) return;
      pendingFocusRef.current = target.id;
      const next = router.buildLocation({ to: target.href });
      await router.navigate({ to: target.href });
      if (router.state.resolvedLocation?.href !== next.href) {
        if (pendingFocusRef.current === target.id) pendingFocusRef.current = null;
        return;
      }
    }
    session.update(({ workspaceTabs }) =>
      workspaceTabs?.contextKey === contextKey
        ? {
            workspaceTabs: {
              ...workspaceTabs,
              tabs: workspaceTabs.tabs.filter((openTab) => openTab.id !== tab.id),
              recentIds: workspaceTabs.recentIds.filter((id) => id !== tab.id),
            },
          }
        : {},
    );
  };

  return (
    <div className="admin-workspace-tabs-shell">
      <div className="admin-workspace-tabs" role="tablist" aria-label="Open admin pages">
        {tabs.map((tab) => {
          const active = tab.id === currentId;
          const locked = selectedGuildTier === "free" && getPaidAdminFeature(`/admin/${tab.id}`);
          return (
            <div
              key={tab.id}
              className={cn("admin-workspace-tab", active && "is-active")}
              role="presentation"
            >
              <button
                id={`admin-workspace-tab-${tab.id}`}
                ref={(element) => {
                  if (element && active && pendingFocusRef.current === tab.id) {
                    pendingFocusRef.current = null;
                    element.focus();
                  }
                }}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="admin-workspace-panel"
                tabIndex={active ? 0 : -1}
                className="admin-workspace-tab-target"
                onClick={() => activateTab(tab)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  moveTabFocus(tab, event.key);
                }}
              >
                <span className={cn("admin-workspace-tab-state", locked && "is-locked")} />
                <span>{tab.label}</span>
                {locked ? <LockIcon className="h-3 w-3" aria-label="Paid feature" /> : null}
              </button>
              {!tab.pinned ? (
                <button
                  type="button"
                  className="admin-workspace-tab-close"
                  aria-label={`Close ${tab.label}`}
                  onClick={() => void closeTab(tab)}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              ) : (
                <span className="admin-workspace-tab-pin" aria-label="Pinned tab">
                  PIN
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function overviewTab(overviewHref: string): AdminWorkspaceTab {
  return {
    id: "overview",
    label: "Overview",
    href: overviewHref,
    pinned: true,
  };
}
