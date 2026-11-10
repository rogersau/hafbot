export interface SteamWebServerEntry {
  addr: string;
  gameport: number;
  steamid: string;
  name: string;
  appid: number;
  gamedir: string;
  version?: string;
  product: string;
  region: number;
  players: number;
  max_players: number;
  bots: number;
  map: string;
  secure: boolean;
  dedicated: boolean;
  os: string;
  gametype: string;
}

export interface SteamWebServerListResponse {
  response?: {
    servers?: SteamWebServerEntry[];
  };
}

export interface SteamWebResult {
  ok: true;
  players: number;
  maxPlayers: number;
  queue: number;
  name: string;
  map: string;
}

export interface SteamWebError {
  ok: false;
  error: string;
}

function parseQueueFromGametype(gametype: string | null | undefined): number {
  if (!gametype) return 0;
  const parts = gametype.split(",");
  for (const part of parts) {
    if (part.startsWith("lqs")) {
      const count = Number.parseInt(part.replace("lqs", ""), 10);
      return Number.isFinite(count) ? count : 0;
    }
  }
  return 0;
}

export async function fetchSteamWebPlayerCount(
  apiKey: string,
  host: string,
  port: number,
): Promise<SteamWebResult | SteamWebError> {
  try {
    const filter = `\\addr\\${host}:${port}`;
    let result = await querySteamServerList(apiKey, filter);
    if (!result.ok) return result;
    let match = result.servers.find((s) => s.gameport === port) ?? result.servers[0];

    if (!match) {
      // Steam may return an empty address-only lookup unless the game's App ID is included.
      const resolvedHost = await resolveSteamHost(host);
      if (!resolvedHost) {
        return { ok: false, error: `Could not resolve Steam server hostname ${host}` };
      }
      const address = `${resolvedHost}:${port}`;
      const lookupUrl = new URL("https://api.steampowered.com/ISteamApps/GetServersAtAddress/v1/");
      lookupUrl.searchParams.set("addr", address);
      const lookup = await fetch(lookupUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!lookup.ok) {
        return { ok: false, error: `Steam address lookup error ${lookup.status}` };
      }
      const addresses = (await lookup.json()) as {
        response?: { servers?: Array<Pick<SteamWebServerEntry, "addr" | "appid">> };
      };
      const server = addresses.response?.servers?.find(
        (entry) => entry.addr === address && Number.isInteger(entry.appid) && entry.appid > 0,
      );
      if (server) {
        result = await querySteamServerList(apiKey, `\\addr\\${address}\\appid\\${server.appid}`);
        if (!result.ok) return result;
        match = result.servers.find((s) => s.gameport === port) ?? result.servers[0];
      }
    }

    if (!match) {
      return {
        ok: false,
        error: `Server ${host}:${port} not found in Steam directory`,
      };
    }

    return {
      ok: true,
      players: match.players,
      maxPlayers: match.max_players,
      queue: parseQueueFromGametype(match.gametype),
      name: match.name,
      map: match.map,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message.replaceAll(apiKey, "[redacted]")
          : "Steam Web API request failed",
    };
  }
}

function isIpv4Address(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

async function resolveSteamHost(host: string): Promise<string | undefined> {
  if (isIpv4Address(host)) return host;
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", host);
  url.searchParams.set("type", "A");
  const response = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Steam hostname lookup error ${response.status}`);
  const data = (await response.json()) as {
    Status?: number;
    Answer?: Array<{ type: number; data: string }>;
  };
  if (data.Status !== 0) return undefined;
  return data.Answer?.find((answer) => answer.type === 1 && isIpv4Address(answer.data))?.data;
}

async function querySteamServerList(
  apiKey: string,
  filter: string,
): Promise<{ ok: true; servers: SteamWebServerEntry[] } | SteamWebError> {
  const url = new URL("https://api.steampowered.com/IGameServersService/GetServerList/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("filter", filter);
  url.searchParams.set("limit", "1");
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, error: `Steam Web API error ${response.status}` };
  const data = (await response.json()) as SteamWebServerListResponse;
  return { ok: true, servers: data.response?.servers ?? [] };
}
