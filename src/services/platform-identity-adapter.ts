import type {
  PlatformLink,
  PlatformLinkConfig,
  PlatformLinkPlatform,
} from "../runtime/contracts/platform-link-store";
import { resolveSteamLinkCustomLinks } from "../runtime/steam-link-custom-links";
import { isRecord } from "../unknown-parse";

interface SteamGameOwnership {
  appId: string;
  name: string;
  owned: boolean;
  playtimeHours: number | null;
  note: string;
}

export interface PlatformIdentityDescription {
  accountLines: string[];
  detailFields: Array<{ name: string; value: string }>;
  whoisLines: string[];
}

export interface PlatformIdentityAdapter {
  readonly platform: PlatformLinkPlatform;
  enrichMetadata(platformId: string, config: PlatformLinkConfig): Promise<string | null>;
  describe(link: PlatformLink, config: PlatformLinkConfig | null): PlatformIdentityDescription;
}

export function createPlatformIdentityAdapter(
  platform: PlatformLinkPlatform,
): PlatformIdentityAdapter {
  return {
    platform,
    async enrichMetadata() {
      return null;
    },
    describe() {
      return { accountLines: [], detailFields: [], whoisLines: [] };
    },
  };
}

export function createSteamIdentityAdapter(options: {
  steamWebApiKey?: string;
  fetch?: typeof fetch;
}): PlatformIdentityAdapter {
  const fetchImplementation = options.fetch ?? fetch;
  return {
    platform: "steam",
    async enrichMetadata(platformId, config) {
      if (!options.steamWebApiKey || config.gameAppIds.length === 0) return JSON.stringify([]);
      const ownership = await readSteamGameOwnership(
        platformId,
        config.gameAppIds,
        options.steamWebApiKey,
        fetchImplementation,
      );
      return JSON.stringify(ownership);
    },
    describe(link, config) {
      const ownership = parseSteamGameOwnership(link.metadataJson);
      const customLinks = resolveSteamLinkCustomLinks(config?.customLinks ?? [], link.platformId);
      const whoisFields = config?.whoisFields ?? [];
      const visibleCustomLinks = customLinks.filter(
        (entry) => whoisFields.length === 0 || whoisFields.includes(entry.label),
      );
      const showOwnership = whoisFields.length === 0 || whoisFields.includes("gameOwnership");
      return {
        accountLines: customLinks.map((entry) => `${entry.label}: ${entry.url}`),
        detailFields:
          ownership.length > 0
            ? [
                {
                  name: "Game Ownership",
                  value: ownership.map(formatOwnershipLine).join("\n"),
                },
              ]
            : [],
        whoisLines: [
          ...visibleCustomLinks.map((entry) => `**${entry.label}:** ${entry.url}`),
          ...(showOwnership && ownership.length > 0
            ? [
                "**Game Ownership:**",
                ...ownership.map((entry) => `- ${formatOwnershipLine(entry)}`),
              ]
            : []),
        ],
      };
    },
  };
}

export function parseSteamGameOwnership(metadataJson: string | null): SteamGameOwnership[] {
  if (!metadataJson) return [];
  try {
    const value = JSON.parse(metadataJson) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isGameOwnership);
  } catch {
    return [];
  }
}

function isGameOwnership(value: unknown): value is SteamGameOwnership {
  if (!isRecord(value)) return false;
  const entry = value as Partial<SteamGameOwnership>;
  return (
    typeof entry.appId === "string" &&
    typeof entry.name === "string" &&
    typeof entry.owned === "boolean" &&
    (entry.playtimeHours === null || typeof entry.playtimeHours === "number") &&
    typeof entry.note === "string"
  );
}

async function readSteamGameOwnership(
  steamId64: string,
  appIds: number[],
  apiKey: string,
  fetchImplementation: typeof fetch,
): Promise<SteamGameOwnership[]> {
  try {
    const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("steamid", steamId64);
    url.searchParams.set("include_appinfo", "true");
    url.searchParams.set("include_played_free_games", "true");
    const response = await fetchImplementation(url.toString());
    const data = (await response.json()) as {
      response?: { games?: Array<{ appid: number; name: string; playtime_forever: number }> };
    };
    const games = data.response?.games ?? [];
    const titles = new Map(games.map((game) => [game.appid, game.name]));

    for (const appId of appIds) {
      if (titles.has(appId)) continue;
      try {
        const detailsUrl = new URL("https://store.steampowered.com/api/appdetails");
        detailsUrl.searchParams.set("appids", String(appId));
        detailsUrl.searchParams.set("filters", "basic");
        const detailsResponse = await fetchImplementation(detailsUrl.toString());
        const details = (await detailsResponse.json()) as Record<
          string,
          { data?: { name?: string } }
        >;
        const title = details[String(appId)]?.data?.name;
        if (title) titles.set(appId, title);
      } catch {
        // Ownership is still useful when the optional title lookup fails.
      }
    }

    return appIds.map((appId) => {
      const game = games.find((entry) => entry.appid === appId);
      return {
        appId: String(appId),
        name: titles.get(appId) ?? "",
        owned: Boolean(game),
        playtimeHours: game ? Math.round(game.playtime_forever / 60) : null,
        note: game ? "Confirmed" : "Not found or profile/private",
      };
    });
  } catch {
    return appIds.map((appId) => ({
      appId: String(appId),
      name: "",
      owned: false,
      playtimeHours: null,
      note: "Steam API check failed",
    }));
  }
}

function formatOwnershipLine(entry: SteamGameOwnership): string {
  return `${entry.name ? `${entry.name} (App ${entry.appId})` : `App ${entry.appId}`}: ${entry.owned ? "Owned" : "Not owned"}${entry.playtimeHours !== null ? ` (${entry.playtimeHours}h)` : ""}`;
}
