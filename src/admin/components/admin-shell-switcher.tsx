import * as Popover from "@radix-ui/react-popover";
import { lazy, Suspense, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { discordGuildIconUrl } from "../lib/discord-guild-icon";
import { ChevronDownIcon, ServerIcon } from "./ui/icons";
import type {
  AdminGuildDirectoryEntry,
  UserPreferences,
  UserPreferencesPatch,
} from "../../runtime/admin-types";
import type { ApplyUserPreferencesOptions } from "../hooks/use-user-preferences";

const GuildMenu = lazy(() => import("./admin-guild-menu"));

export function AdminShellSwitcher({
  collapsed,
  menuOpen,
  guildDirectory,
  guildLookupError,
  selectedGuildId,
  refreshGuildDirectory,
  userPreferences,
  applyUserPreferencesPatch,
  onToggleMenu,
  onCloseMenu,
  onSelectedGuildChange,
}: {
  collapsed: boolean;
  menuOpen: boolean;
  guildDirectory: AdminGuildDirectoryEntry[] | null;
  guildLookupError: string | null;
  selectedGuildId: string;
  refreshGuildDirectory: () => Promise<void>;
  userPreferences: UserPreferences;
  applyUserPreferencesPatch: (
    patch: UserPreferencesPatch,
    options?: ApplyUserPreferencesOptions,
  ) => Promise<void>;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onSelectedGuildChange: (nextGuildId: string) => void;
}) {
  const [isRetrying, setIsRetrying] = useState(false);
  const retryInFlightRef = useRef(false);
  const activeGuildLabel = getSelectedGuildLabel(selectedGuildId, guildDirectory);
  const selectedGuild = guildDirectory?.find((guild) => guild.guildId === selectedGuildId);
  const menuId = "admin-guild-menu";
  return (
    <div
      className={cn(
        "admin-shell-context-switcher px-3 transition-all",
        collapsed ? "lg:h-0 lg:overflow-hidden lg:px-0 lg:opacity-0" : "py-3 opacity-100",
      )}
    >
      <Popover.Root
        open={menuOpen}
        onOpenChange={(open) => (open ? onToggleMenu() : onCloseMenu())}
      >
        <Popover.Trigger asChild>
          <button
            id="sidebar-guild"
            type="button"
            className="flex w-full items-center gap-3 rounded-lg border bg-muted/40 p-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            disabled={!!guildLookupError}
          >
            <span className="flex aspect-square h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SwitcherTriggerIcon guild={selectedGuild} />
            </span>
            <span className="min-w-0 flex-1 leading-none">
              <span className="block text-xs text-muted-foreground">Current guild</span>
              <span className="mt-1 block truncate text-sm font-medium text-foreground">
                {activeGuildLabel}
              </span>
            </span>
            <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
          </button>
        </Popover.Trigger>
        <Popover.Content
          id={menuId}
          role="menu"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="admin-context-menu z-50 max-h-80 w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-[4px] border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
        >
          <Suspense fallback={<p role="status">Loading guilds…</p>}>
            <GuildMenu
              guildDirectory={guildDirectory}
              selectedGuildId={selectedGuildId}
              hiddenGuildIds={userPreferences.hiddenGuildIds}
              defaultGuildId={userPreferences.defaultGuildId}
              applyUserPreferencesPatch={applyUserPreferencesPatch}
              onSelect={(guildId) => {
                onSelectedGuildChange(guildId);
                onCloseMenu();
              }}
            />
          </Suspense>
        </Popover.Content>
      </Popover.Root>
      {guildLookupError ? (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">We couldn't load your Discord servers.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isRetrying}
              onClick={() => {
                if (retryInFlightRef.current) return;
                retryInFlightRef.current = true;
                setIsRetrying(true);
                void refreshGuildDirectory()
                  .catch(() => undefined)
                  .finally(() => {
                    retryInFlightRef.current = false;
                    setIsRetrying(false);
                  });
              }}
            >
              {isRetrying ? "Retrying…" : "Retry"}
            </button>
            <a
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              href="https://discord.gg/HpRPkdm6dv"
              target="_blank"
              rel="noopener noreferrer"
            >
              Contact support
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SwitcherTriggerIcon({ guild }: { guild: AdminGuildDirectoryEntry | undefined }) {
  if (!guild) {
    return <ServerIcon className="h-4 w-4" />;
  }
  const url = discordGuildIconUrl(guild.guildId, guild.icon);
  if (!url) {
    return <ServerIcon className="h-4 w-4" />;
  }
  return (
    <img
      src={url}
      alt={guild.label}
      loading="lazy"
      className="h-full w-full rounded-md object-cover"
    />
  );
}

function getSelectedGuildLabel(
  selectedGuildId: string,
  guildDirectory: AdminGuildDirectoryEntry[] | null,
) {
  if (!guildDirectory) return selectedGuildId || "Loading guilds...";
  return (
    guildDirectory.find((guild) => guild.guildId === selectedGuildId)?.label || "select a guild"
  );
}
