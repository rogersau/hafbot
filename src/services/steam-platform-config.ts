import type { PlatformAuthConfig } from "./platform-auth-config";
import { buildSteamAuthUrl, verifySteamAssertion } from "./steam-openid";

export interface SteamPlatformConfigOptions {
  steamWebApiKey?: string;
}

export function createSteamPlatformConfig(
  _options: SteamPlatformConfigOptions = {},
): PlatformAuthConfig {
  return {
    platformName: "steam",
    displayName: "Steam",
    iconUrl: "https://cdn.cloudflare.steamstatic.com/store/home/store_home_share.jpg",
    profileUrl: (platformId: string) => `https://steamcommunity.com/profiles/${platformId}`,
    buildAuthUrl: ({ state, publicUrl }) =>
      new URL(
        buildSteamAuthUrl({
          realm: publicUrl,
          returnTo: `${publicUrl}/auth/steam/callback`,
          state,
        }),
      ),
    verifyAssertion: async (request: Request) => verifySteamAssertion(request.url),
  };
}
