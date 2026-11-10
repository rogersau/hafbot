import type { PlayerCountStatusProvider } from "./player-count-status-provider";
import { fetchSteamWebPlayerCount } from "./steam-web-client";

export interface SteamWebPlayerCountStatusProviderOptions {
  apiKey?: string;
}

export function createSteamWebPlayerCountStatusProvider(
  options: SteamWebPlayerCountStatusProviderOptions,
): PlayerCountStatusProvider {
  return {
    async query(server) {
      if (!options.apiKey || !server.steamHost) {
        return { ok: false, error: "Player count provider not configured" };
      }
      const result = await fetchSteamWebPlayerCount(
        options.apiKey,
        server.steamHost,
        server.steamPort ?? 27015,
      );
      if (!result.ok) return result;
      return {
        ok: true,
        snapshot: {
          count: result.players,
          maxSlots: result.maxPlayers,
          queue: result.queue,
          serverName: result.name,
          map: result.map,
        },
      };
    },
  };
}
