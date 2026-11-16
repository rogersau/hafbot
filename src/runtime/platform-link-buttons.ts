import type { PlatformLinkConfig } from "./contracts/platform-link-store";
import type { CreateChannelMessageInput } from "../discord";
import { DISCORD_BUTTON_COMPONENT, DISCORD_MESSAGE_COMPONENT_ROW } from "../discord/constants";

export type PrimaryLinkPlatform = "steam" | "xbox" | "playstation";

type LinkPanelConfig = Pick<
  PlatformLinkConfig,
  "panelTitle" | "panelDescription" | "panelButtonLabel" | "panelButtonStyle" | "panelColor"
>;

type LinkButtonConfig = Pick<LinkPanelConfig, "panelButtonLabel" | "panelButtonStyle">;

const BUTTON_STYLE_MAP: Record<string, number> = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
};

const PLATFORM_BUTTONS: Record<
  PrimaryLinkPlatform,
  { customId: string; color: number; displayName: string }
> = {
  steam: { customId: "steam_link_button", color: 0x5865f2, displayName: "Steam" },
  xbox: { customId: "xbox_link_button", color: 0x107c10, displayName: "Xbox" },
  playstation: {
    customId: "playstation_link_button",
    color: 0x003791,
    displayName: "PlayStation",
  },
};

export function buildPlatformLinkMessage(
  platform: PrimaryLinkPlatform,
  config: LinkPanelConfig,
  options: { buttonOnly?: boolean } = {},
): CreateChannelMessageInput {
  const metadata = PLATFORM_BUTTONS[platform];
  const components = [buildPlatformLinkActionRow(platform, config)];

  if (options.buttonOnly) {
    return { components };
  }

  return {
    embeds: [
      {
        title: config.panelTitle,
        description: config.panelDescription,
        color: config.panelColor ?? metadata.color,
      },
    ],
    components,
  };
}

export function buildPlatformLinkActionRow(
  platform: PrimaryLinkPlatform,
  config: LinkButtonConfig,
): unknown {
  return {
    type: DISCORD_MESSAGE_COMPONENT_ROW,
    components: [
      {
        type: DISCORD_BUTTON_COMPONENT,
        custom_id: PLATFORM_BUTTONS[platform].customId,
        label: config.panelButtonLabel,
        style: BUTTON_STYLE_MAP[config.panelButtonStyle] ?? 1,
      },
    ],
  };
}

export function getPlatformDisplayName(platform: PrimaryLinkPlatform): string {
  return PLATFORM_BUTTONS[platform].displayName;
}
