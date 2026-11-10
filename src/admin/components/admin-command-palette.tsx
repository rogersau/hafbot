import { lazy, Suspense, useRef, type MutableRefObject } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useCommandPaletteShortcut } from "../hooks/use-command-palette-shortcut";

import { ADMIN_DASHBOARD_ROUTES } from "../dashboard-routes";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";
import type { AdminGuildDirectoryEntry } from "../../runtime/admin-types";

const CommandPaletteView = lazy(() => import("./admin-command-palette-view"));

export interface RecentCommandAction {
  id: string;
  label: string;
  /** Path the action navigates to when selected. */
  href: string;
  /** Optional keywords for matching (e.g. "last closed ticket"). */
  keywords?: string[];
  hint?: string;
}

export interface AdminCommandPaletteProps {
  /** Recent actions (e.g. last closed ticket). Empty by default. */
  recentActions?: RecentCommandAction[];
  /** Routes to surface in the "Dashboard pages" group. */
  routes?: ReadonlyArray<{
    path: (typeof ADMIN_DASHBOARD_ROUTES)[number]["path"];
    label: string;
  }>;
  /** Guild directory entries to surface as switchable servers. */
  guildDirectory?: AdminGuildDirectoryEntry[] | null;
  /** Workspace + guild context used to build navigation hrefs. */
  selectedWorkspaceId: string;
  selectedGuildId: string;
  /** Control whether the palette is open. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: MutableRefObject<HTMLElement | null>;
}

/**
 * Shell-level wrapper around the presentational `CommandPalette` that builds
 * the searchable items (dashboard pages, switchable guilds, and recent actions)
 * and dispatches selection through `useNavigate()`.
 */
export function AdminCommandPalette({
  recentActions = [],
  routes = ADMIN_DASHBOARD_ROUTES,
  guildDirectory = null,
  selectedWorkspaceId,
  selectedGuildId,
  open,
  onOpenChange,
  returnFocusRef,
}: AdminCommandPaletteProps) {
  const navigate = useNavigate();
  const setOpen = onOpenChange;

  const fallbackReturnFocusRef = useRef<HTMLElement | null>(null);
  const focusRef = returnFocusRef ?? fallbackReturnFocusRef;

  const openPalette = () => {
    captureCommandPaletteReturnFocus(focusRef);
    setOpen(true);
  };

  const closePalette = () => {
    setOpen(false);
    restoreCommandPaletteFocus(focusRef);
  };

  useCommandPaletteShortcut(openPalette);

  const resolveHref = (itemId: string) =>
    resolveAdminCommandPaletteHref(itemId, selectedWorkspaceId, selectedGuildId, recentActions);

  return (
    <Suspense fallback={null}>
      {open ? (
        <CommandPaletteView
          routes={routes}
          recentActions={recentActions}
          guildDirectory={guildDirectory}
          selectedGuildId={selectedGuildId}
          onDismiss={closePalette}
          onSelect={(itemId) => {
            const href = resolveHref(itemId);
            closePalette();
            if (href) void navigate({ to: href });
          }}
        />
      ) : null}
    </Suspense>
  );
}

export function resolveAdminCommandPaletteHref(
  itemId: string,
  selectedWorkspaceId: string,
  selectedGuildId: string,
  recentActions: ReadonlyArray<RecentCommandAction> = [],
): string | null {
  if (itemId.startsWith("page:")) {
    const path = itemId.slice("page:".length);
    return buildAdminDashboardHref(path, selectedWorkspaceId, selectedGuildId);
  }
  if (itemId.startsWith("guild:")) {
    const guildId = itemId.slice("guild:".length);
    return buildAdminDashboardHref("/admin", selectedWorkspaceId, guildId);
  }
  if (itemId.startsWith("recent:")) {
    const recent = recentActions.find((action) => "recent:" + action.id === itemId);
    return recent?.href ?? null;
  }
  return null;
}

export function captureCommandPaletteReturnFocus(
  returnFocusRef: MutableRefObject<HTMLElement | null>,
) {
  if (document.activeElement instanceof HTMLElement) {
    returnFocusRef.current = document.activeElement;
  }
}

export function restoreCommandPaletteFocus(returnFocusRef: MutableRefObject<HTMLElement | null>) {
  queueMicrotask(() => {
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
  });
}
