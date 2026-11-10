import { useCallback, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { discordGuildIconUrl } from "../lib/discord-guild-icon";
import { AdminPageHeader } from "./admin-page-header";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { EyeIcon, EyeOffIcon, ServerIcon, StarIcon } from "./ui/icons";
import {
  USER_PREFERENCES_THEMES,
  type AdminGuildDirectoryEntry,
  type UserPreferences,
  type UserPreferencesPatch,
  type UserPreferencesTheme,
} from "../../runtime/admin-types";

const THEME_LABELS: Record<UserPreferencesTheme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const GUARD_DESCRIPTION = "Settings save automatically when you change them.";

export function UserProfilePage({
  preferences,
  user,
  guilds,
  entitlementLabel,
  applyUserPreferencesPatch,
}: {
  preferences: UserPreferences;
  user: { name: string; email?: string | null; image: string };
  guilds: AdminGuildDirectoryEntry[];
  entitlementLabel?: string | null;
  applyUserPreferencesPatch: (
    patch: UserPreferencesPatch,
    options?: {
      successMessage?: string;
      onError?: (error: string) => void;
      onSuccess?: () => void;
    },
  ) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const toast = useToast();

  const applyPatch = useCallback(
    async (action: string, patch: UserPreferencesPatch, successMessage?: string) => {
      setError(null);
      setPendingAction(action);
      try {
        await applyUserPreferencesPatch(patch, {
          successMessage,
          onError: (err) => setError(err),
          onSuccess: () => {
            if (successMessage) toast.success(successMessage);
          },
        });
      } finally {
        setPendingAction(null);
      }
    },
    [applyUserPreferencesPatch, toast],
  );

  const handleToggleGuildVisibility = useCallback(
    (guildId: string, nextHidden: boolean) => {
      void applyPatch(
        `visibility:${guildId}`,
        buildGuildVisibilityPatch(preferences, guildId, nextHidden),
        nextHidden ? "Guild hidden from your dashboard." : "Guild visible in your dashboard.",
      );
    },
    [applyPatch, preferences],
  );

  const handleSetDefaultGuild = useCallback(
    (guildId: string) => {
      if (preferences.defaultGuildId === guildId) return;
      if (preferences.hiddenGuildIds.includes(guildId)) return;
      void applyPatch(
        `default:${guildId}`,
        { defaultGuildId: guildId },
        `Default guild set to ${guilds.find((g) => g.guildId === guildId)?.name ?? guildId}.`,
      );
    },
    [applyPatch, guilds, preferences.defaultGuildId, preferences.hiddenGuildIds],
  );

  const handleThemeChange = useCallback(
    (next: UserPreferencesTheme) => {
      void applyPatch(`theme:${next}`, { theme: next }, `Theme set to ${THEME_LABELS[next]}.`);
    },
    [applyPatch],
  );

  const initials = useMemo(
    () =>
      user.name
        .trim()
        .split(/\s+/)
        .map((part) => part[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase() || "AU",
    [user.name],
  );
  const defaultGuildUnavailable =
    preferences.defaultGuildId !== null &&
    (!guilds.some((guild) => guild.guildId === preferences.defaultGuildId) ||
      preferences.hiddenGuildIds.includes(preferences.defaultGuildId));

  return (
    <section className="admin-feature-page admin-page-system space-y-6">
      <AdminPageHeader
        title="Profile"
        actions={entitlementLabel ? <Badge variant="success">{entitlementLabel}</Badge> : null}
      />
      <p className="text-xs text-muted-foreground">{GUARD_DESCRIPTION}</p>

      <PageFeedback error={error} />

      <div className="grid min-w-0 gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg">Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex min-w-0 flex-wrap items-center gap-4">
              {user.image ? (
                <img
                  src={user.image}
                  alt={user.name}
                  className="h-24 w-24 rounded-full bg-primary object-cover"
                />
              ) : (
                <div
                  className="flex h-24 w-24 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-foreground"
                  aria-hidden="true"
                >
                  {initials}
                </div>
              )}
              <div className="min-w-0 space-y-1">
                <p className="text-lg font-semibold text-foreground">{user.name}</p>
                {user.email ? (
                  <p className="break-all text-sm text-muted-foreground">{user.email}</p>
                ) : null}
                {entitlementLabel ? <Badge variant="success">{entitlementLabel}</Badge> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Guilds</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {defaultGuildUnavailable ? (
              <PageFeedback
                error={null}
                message="Your saved default guild is unavailable. Choose a visible guild below to set a new default."
              />
            ) : null}
            {guilds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You haven&apos;t linked any guilds yet.
              </p>
            ) : (
              guilds.map((guild) => {
                const isHidden = preferences.hiddenGuildIds.includes(guild.guildId);
                const isDefault = preferences.defaultGuildId === guild.guildId;
                return (
                  <div
                    key={guild.guildId}
                    className={cn(
                      "flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 sm:flex-nowrap sm:gap-3",
                      isHidden && "border-dashed bg-muted/20 opacity-60",
                    )}
                  >
                    <ProfileGuildIcon guild={guild} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{guild.label}</p>
                    </div>
                    {!isHidden && isDefault ? <Badge variant="warning">Default</Badge> : null}
                    {!isHidden ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pendingAction === `default:${guild.guildId}`}
                        onClick={() => handleSetDefaultGuild(guild.guildId)}
                        aria-label={`Set ${guild.label} as default guild`}
                      >
                        <StarIcon className="h-4 w-4" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      disabled={pendingAction === `visibility:${guild.guildId}`}
                      onClick={() => handleToggleGuildVisibility(guild.guildId, !isHidden)}
                      aria-label={isHidden ? `Show ${guild.label}` : `Hide ${guild.label}`}
                    >
                      {isHidden ? (
                        <EyeOffIcon className="h-4 w-4" />
                      ) : (
                        <EyeIcon className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-lg">Appearance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Theme</p>
              <div className="flex flex-wrap gap-2">
                {USER_PREFERENCES_THEMES.map((theme) => (
                  <Button
                    key={theme}
                    type="button"
                    variant={preferences.theme === theme ? "default" : "outline"}
                    size="sm"
                    disabled={pendingAction === `theme:${theme}`}
                    onClick={() => handleThemeChange(theme)}
                    aria-pressed={preferences.theme === theme}
                  >
                    {THEME_LABELS[theme]}
                  </Button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {pendingAction ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Saving…
        </p>
      ) : null}
    </section>
  );
}

export function buildGuildVisibilityPatch(
  preferences: UserPreferences,
  guildId: string,
  nextHidden: boolean,
): UserPreferencesPatch {
  const hiddenGuildIds = nextHidden
    ? Array.from(new Set([...preferences.hiddenGuildIds, guildId]))
    : preferences.hiddenGuildIds.filter((id) => id !== guildId);
  return {
    hiddenGuildIds,
    ...(nextHidden && preferences.defaultGuildId === guildId ? { defaultGuildId: null } : {}),
  };
}

function ProfileGuildIcon({ guild }: { guild: AdminGuildDirectoryEntry }) {
  const url = discordGuildIconUrl(guild.guildId, guild.icon);
  if (!url) {
    return (
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary-foreground"
        aria-hidden="true"
      >
        <ServerIcon className="h-4 w-4" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className="h-9 w-9 shrink-0 rounded-lg object-cover"
    />
  );
}
