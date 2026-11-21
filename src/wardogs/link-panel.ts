import type { CreateChannelMessageInput } from "../discord/messages";

export const WARDOGS_LINK_STEAM_BUTTON = "wardogs:link-steam";
export const WARDOGS_SYNC_STATS_BUTTON = "wardogs:sync-stats";
export const DEFAULT_WARDOGS_PANEL_TITLE = "Link your WARDOGS profile";
export const WARDOGS_PANEL_INSTRUCTIONS =
  "Link Steam to your Discord account, then close WARDOGS and sync your stats. Use /wardogs stats to view your public snapshot.";

export function buildWardogsLinkPanel(
  title: string,
  description: string,
): CreateChannelMessageInput {
  return {
    embeds: [
      {
        title,
        description: [description, WARDOGS_PANEL_INSTRUCTIONS].filter(Boolean).join("\n\n"),
        color: 0xd6a247,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: WARDOGS_LINK_STEAM_BUTTON, label: "Link Steam" },
          { type: 2, style: 2, custom_id: WARDOGS_SYNC_STATS_BUTTON, label: "Sync WARDOGS stats" },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
