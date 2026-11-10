import { cn } from "../lib/utils";
import { discordGuildIconUrl } from "../lib/discord-guild-icon";
import { CheckIcon, EyeIcon, ServerIcon, StarIcon } from "./ui/icons";
import type { AdminGuildDirectoryEntry, UserPreferencesPatch } from "../../runtime/admin-types";
import type { ApplyUserPreferencesOptions } from "../hooks/use-user-preferences";

export default function GuildMenu({
  guildDirectory,
  selectedGuildId,
  hiddenGuildIds,
  defaultGuildId,
  applyUserPreferencesPatch,
  onSelect,
}: {
  guildDirectory: AdminGuildDirectoryEntry[] | null;
  selectedGuildId: string;
  hiddenGuildIds: string[];
  defaultGuildId: string | null;
  applyUserPreferencesPatch: (
    patch: UserPreferencesPatch,
    options?: ApplyUserPreferencesOptions,
  ) => Promise<void>;
  onSelect: (guildId: string) => void;
}) {
  if (!guildDirectory || guildDirectory.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">
        {guildDirectory ? "No guilds available" : "Loading guilds..."}
      </p>
    );
  }

  const hidden = new Set(hiddenGuildIds);
  const visibleGuilds = guildDirectory
    .filter((guild) => !hidden.has(guild.guildId))
    .sort((left, right) => {
      if (left.guildId === defaultGuildId) return -1;
      if (right.guildId === defaultGuildId) return 1;
      return 0;
    });

  if (visibleGuilds.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">No visible guilds</p>;
  }

  return (
    <>
      {visibleGuilds.map((guild) => {
        const isDefault = defaultGuildId === guild.guildId;
        return (
          <div
            key={guild.guildId}
            role="menuitemradio"
            aria-checked={guild.guildId === selectedGuildId}
            tabIndex={0}
            onClick={() => onSelect(guild.guildId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(guild.guildId);
              }
            }}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
            )}
          >
            <GuildIcon guild={guild} />
            <span className="min-w-0 flex-1 truncate">{guild.label}</span>
            {isDefault ? (
              <StarIcon className="h-3.5 w-3.5 text-amber-500" aria-label="Default guild" />
            ) : null}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={true}
              aria-label={`Hide ${guild.label} from the sidebar`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                const nextHiddenGuildIds = Array.from(new Set([...hiddenGuildIds, guild.guildId]));
                void applyUserPreferencesPatch(
                  { hiddenGuildIds: nextHiddenGuildIds },
                  {
                    successMessage: `${guild.label} hidden from your sidebar.`,
                  },
                );
              }}
            >
              <EyeIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={
                isDefault
                  ? `${guild.label} is your default guild`
                  : `Set ${guild.label} as your default guild`
              }
              aria-pressed={isDefault}
              disabled={isDefault}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
                isDefault && "text-amber-500",
              )}
              onClick={(event) => {
                event.stopPropagation();
                if (isDefault) return;
                void applyUserPreferencesPatch(
                  { defaultGuildId: guild.guildId },
                  { successMessage: `${guild.label} set as your default guild.` },
                );
              }}
            >
              <StarIcon className="h-4 w-4" />
            </button>
            {guild.guildId === selectedGuildId ? (
              <CheckIcon className="h-4 w-4 text-primary" />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function GuildIcon({ guild }: { guild: AdminGuildDirectoryEntry }) {
  const url = discordGuildIconUrl(guild.guildId, guild.icon);
  if (!url) {
    return <ServerIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className="h-5 w-5 shrink-0 rounded-sm object-cover"
    />
  );
}
