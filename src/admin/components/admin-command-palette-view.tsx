import { useMemo } from "react";
import { CommandPalette, type CommandPaletteItem } from "./command-palette";
import type { AdminCommandPaletteProps } from "./admin-command-palette";

export default function AdminCommandPaletteView({
  routes,
  recentActions,
  guildDirectory,
  selectedGuildId,
  onDismiss,
  onSelect,
}: Required<
  Pick<AdminCommandPaletteProps, "routes" | "recentActions" | "guildDirectory" | "selectedGuildId">
> & {
  onDismiss: () => void;
  onSelect: (id: string) => void;
}) {
  const items = useMemo<CommandPaletteItem[]>(() => {
    const pageItems: CommandPaletteItem[] = routes.map((route) => ({
      id: `page:${route.path}`,
      label: route.label,
      group: "pages",
      keywords: [route.path],
    }));

    const directory = guildDirectory ?? [];
    const guildItems: CommandPaletteItem[] = directory
      .filter((guild) => guild.guildId !== selectedGuildId)
      .map((guild) => ({
        id: `guild:${guild.guildId}`,
        label: guild.label,
        group: "resources",
        keywords: [guild.name, guild.guildId],
      }));

    const recentItems: CommandPaletteItem[] = recentActions.map((action) => ({
      id: `recent:${action.id}`,
      label: action.label,
      group: "recent",
      keywords: action.keywords,
      hint: action.hint,
    }));

    return [...pageItems, ...guildItems, ...recentItems];
  }, [routes, guildDirectory, selectedGuildId, recentActions]);

  return (
    <CommandPalette
      open
      items={items}
      onDismiss={onDismiss}
      onSelect={(item) => onSelect(item.id)}
    />
  );
}
