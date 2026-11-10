import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../lib/utils";
import { LockIcon, XIcon } from "./ui/icons";

export interface AdminWorkspaceTab {
  id: string;
  label: string;
  href: string;
  pinned: boolean;
  locked?: boolean;
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
    return section === "steam-link" ? "player-link" : section;
  }

  return path.slice("/admin/".length) || "overview";
}

export function AdminWorkspaceTabs({
  currentPath,
  currentSearch,
  currentLabel,
  currentLocked,
  selectedGuildId,
  contextKey,
  overviewHref,
  showOverview,
}: {
  currentPath: string;
  currentSearch: string;
  currentLabel: string;
  currentLocked: boolean;
  selectedGuildId: string;
  contextKey: string;
  overviewHref: string;
  showOverview: boolean;
}) {
  const navigate = useNavigate();
  const currentId = getAdminWorkspaceRouteId(currentPath, selectedGuildId);
  const currentHref = `${currentPath}${currentSearch}`;
  const [tabs, setTabs] = useState<AdminWorkspaceTab[]>(() =>
    buildInitialTabs(
      showOverview,
      overviewHref,
      currentId,
      currentLabel,
      currentHref,
      currentLocked,
    ),
  );
  const [recentIds, setRecentIds] = useState<string[]>([currentId]);
  const previousContextKeyRef = useRef(contextKey);
  const pendingCloseRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  // eslint-disable-next-line custom/no-use-effect -- Projects router state into session-local workspace tabs.
  useEffect(() => {
    const nextCurrent: AdminWorkspaceTab = {
      id: currentId,
      label: currentLabel,
      href: currentHref,
      pinned: showOverview && currentId === "overview",
      locked: currentLocked,
    };

    if (previousContextKeyRef.current !== contextKey) {
      previousContextKeyRef.current = contextKey;
      setTabs(
        buildInitialTabs(
          showOverview,
          overviewHref,
          currentId,
          currentLabel,
          currentHref,
          currentLocked,
        ),
      );
      setRecentIds([currentId]);
      pendingCloseRef.current = null;
      return;
    }

    setTabs((openTabs) => {
      const withoutClosed = pendingCloseRef.current
        ? openTabs.filter((tab) => tab.id !== pendingCloseRef.current)
        : openTabs;
      pendingCloseRef.current = null;
      return upsertAdminWorkspaceTab(withoutClosed, nextCurrent);
    });
    setRecentIds((ids) => [...ids.filter((id) => id !== currentId), currentId]);
  }, [contextKey, currentHref, currentId, currentLabel, currentLocked, overviewHref, showOverview]);

  // eslint-disable-next-line custom/no-use-effect -- Restores predictable tab focus after route navigation.
  useEffect(() => {
    const focusId = pendingFocusRef.current;
    if (!focusId || focusId !== currentId) return;
    pendingFocusRef.current = null;
    tabRefs.current.get(focusId)?.focus();
  }, [currentId]);

  const activateTab = (tab: AdminWorkspaceTab) => {
    if (tab.id === currentId) return;
    pendingFocusRef.current = tab.id;
    void navigate({ to: tab.href });
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

  const closeTab = (tab: AdminWorkspaceTab) => {
    if (tab.pinned) return;
    if (tab.id !== currentId) {
      setTabs((openTabs) => openTabs.filter((openTab) => openTab.id !== tab.id));
      setRecentIds((ids) => ids.filter((id) => id !== tab.id));
      return;
    }

    const target = getAdminWorkspaceCloseTarget(tabs, recentIds, tab.id);
    if (!target) return;
    pendingCloseRef.current = tab.id;
    pendingFocusRef.current = target.id;
    void navigate({ to: target.href });
  };

  return (
    <div className="admin-workspace-tabs-shell">
      <div className="admin-workspace-tabs" role="tablist" aria-label="Open admin pages">
        {tabs.map((tab) => {
          const active = tab.id === currentId;
          return (
            <div
              key={tab.id}
              className={cn("admin-workspace-tab", active && "is-active")}
              role="presentation"
            >
              <button
                id={`admin-workspace-tab-${tab.id}`}
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.id, element);
                  else tabRefs.current.delete(tab.id);
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
                <span className={cn("admin-workspace-tab-state", tab.locked && "is-locked")} />
                <span>{tab.label}</span>
                {tab.locked ? <LockIcon className="h-3 w-3" aria-label="Paid feature" /> : null}
              </button>
              {!tab.pinned ? (
                <button
                  type="button"
                  className="admin-workspace-tab-close"
                  aria-label={`Close ${tab.label}`}
                  onClick={() => closeTab(tab)}
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

function buildInitialTabs(
  showOverview: boolean,
  overviewHref: string,
  currentId: string,
  currentLabel: string,
  currentHref: string,
  currentLocked: boolean,
): AdminWorkspaceTab[] {
  const overview: AdminWorkspaceTab = {
    id: "overview",
    label: "Overview",
    href: overviewHref,
    pinned: true,
  };
  const current: AdminWorkspaceTab = {
    id: currentId,
    label: currentLabel,
    href: currentHref,
    pinned: showOverview && currentId === "overview",
    locked: currentLocked,
  };
  if (!showOverview) return [current];
  return currentId === "overview" ? [overview] : [overview, current];
}
