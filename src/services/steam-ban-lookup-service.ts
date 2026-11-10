import { isRecord } from "../unknown-parse";

const STEAM_ID64_PATTERN = /(?:https?:\/\/steamcommunity\.com\/profiles\/)?(7656119\d{10})\b/g;
const DEFAULT_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SteamBanLookupMessage {
  guildId: string;
  steamIds: string[];
  notificationUrl: string;
  banLookupAppIds: number[];
}

export interface SteamBanLookupCacheEntry {
  lastCheckedAtMs: number;
  communityBanned: boolean;
  vacBanned: boolean;
  numberOfVacBans: number;
  daysSinceLastBan: number;
  numberOfGameBans: number;
  economyBan: string;
  gameBans: SteamGameBan[];
}

export interface SteamGameBan {
  appId: number;
  banStartTimeUnix: number;
  banType: number;
}

export type SteamBanLookupProcessResult =
  | { status: "complete" }
  | { status: "retry"; reasonCode: string; delaySeconds?: number }
  | { status: "terminal"; reasonCode: string };

export interface SteamBanLookupStore {
  read(steamId64: string): Promise<SteamBanLookupCacheEntry | null>;
  write(steamId64: string, entry: SteamBanLookupCacheEntry): Promise<void>;
}

export interface SteamBanLookupServiceOptions {
  steamWebApiKey?: string;
  store: SteamBanLookupStore;
  fetch?: typeof fetch;
  nowMs?: () => number;
  recheckIntervalMs?: number;
  logger?: Pick<Console, "error">;
}

export interface SteamPlayerBanResult extends Omit<SteamBanLookupCacheEntry, "lastCheckedAtMs"> {
  steamId64: string;
}

export class SteamBanLookupService {
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly recheckIntervalMs: number;
  private readonly logger: Pick<Console, "error">;

  constructor(private readonly options: SteamBanLookupServiceOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.fetchImpl = ((input, init) => fetchImpl.call(globalThis, input, init)) as typeof fetch;
    this.nowMs = options.nowMs ?? Date.now;
    this.recheckIntervalMs = options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
    this.logger = options.logger ?? console;
  }

  async processBatch(messages: SteamBanLookupMessage[]): Promise<SteamBanLookupProcessResult> {
    const steamWebApiKey = this.options.steamWebApiKey;
    if (!steamWebApiKey) {
      return { status: "terminal", reasonCode: "missing_steam_api_key" };
    }

    for (const message of groupMessages(messages)) {
      const outcome = await this.processMessage(message, steamWebApiKey);
      if (outcome.status !== "complete") return outcome;
    }
    return { status: "complete" };
  }

  private async processMessage(
    message: SteamBanLookupMessage,
    steamWebApiKey: string,
  ): Promise<SteamBanLookupProcessResult> {
    const nowMs = this.nowMs();
    const cachedById = new Map<string, SteamBanLookupCacheEntry>();
    const idsToCheck: string[] = [];

    for (const steamId of new Set(message.steamIds)) {
      try {
        const cached = await this.options.store.read(steamId);
        if (cached && nowMs - cached.lastCheckedAtMs < this.recheckIntervalMs) {
          continue;
        }
        if (cached) {
          cachedById.set(steamId, cached);
        }
        idsToCheck.push(steamId);
      } catch {
        this.logger.error("Steam ban lookup cache read failed", { reasonCode: "kv_unavailable" });
        return { status: "retry", reasonCode: "kv_unavailable" };
      }
    }

    if (idsToCheck.length === 0) {
      return { status: "complete" };
    }

    for (const chunk of chunkArray(idsToCheck, 100)) {
      let results: SteamPlayerBanResult[];
      try {
        results = await fetchSteamPlayerBans(chunk, steamWebApiKey, this.fetchImpl);
      } catch (error) {
        const outcome = classifySteamProviderError(error, "steam_api");
        this.logger.error("Steam ban lookup API failed", {
          reasonCode: outcome.reasonCode,
          ...(error instanceof SteamProviderHttpError ? { status: error.status } : {}),
        });
        return outcome;
      }

      for (const result of results) {
        const entry = toCacheEntry(result, nowMs);
        const shouldSend = shouldNotify(
          result,
          cachedById.get(result.steamId64),
          message.banLookupAppIds,
        );
        if (shouldSend) {
          const notificationOutcome = await this.sendNotification(
            message.notificationUrl,
            result,
            nowMs,
          );
          if (notificationOutcome.status !== "complete") return notificationOutcome;
        }

        try {
          await this.options.store.write(result.steamId64, entry);
        } catch {
          this.logger.error("Steam ban lookup cache write failed", {
            reasonCode: "kv_unavailable",
          });
          return { status: "retry", reasonCode: "kv_unavailable" };
        }
      }
    }
    return { status: "complete" };
  }

  private async sendNotification(
    notificationUrl: string,
    result: SteamPlayerBanResult,
    nowMs: number,
  ): Promise<SteamBanLookupProcessResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(notificationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "steam_ban_report",
          steamId64: result.steamId64,
          communityBanned: result.communityBanned,
          vacBanned: result.vacBanned,
          numberOfVacBans: result.numberOfVacBans,
          daysSinceLastBan: result.daysSinceLastBan,
          numberOfGameBans: result.numberOfGameBans,
          economyBan: result.economyBan,
          gameBans: result.gameBans,
          detectedAtIso: new Date(nowMs).toISOString(),
        }),
      });
    } catch {
      this.logger.error("Steam ban lookup notification delivery failed", {
        steamId64: result.steamId64,
        reasonCode: "notification_network_error",
      });
      return { status: "retry", reasonCode: "notification_network_error" };
    }

    if (!response.ok) {
      const outcome = classifyHttpStatus(response.status, "notification", response);
      this.logger.error("Steam ban lookup notification returned non-OK status", {
        steamId64: result.steamId64,
        status: response.status,
        reasonCode: outcome.reasonCode,
      });
      return outcome;
    }
    return { status: "complete" };
  }
}

class SteamProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Steam provider returned HTTP ${status}`);
    this.name = "SteamProviderHttpError";
  }
}

export async function fetchSteamPlayerBans(
  steamIds: string[],
  steamWebApiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SteamPlayerBanResult[]> {
  const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/");
  url.searchParams.set("key", steamWebApiKey);
  url.searchParams.set("steamids", steamIds.slice(0, 100).join(","));

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new SteamProviderHttpError(response.status, readRetryAfterSeconds(response));
  }

  const body = (await response.json()) as { players?: unknown[] };
  return (body.players ?? []).flatMap(parseSteamPlayerBan);
}

function classifySteamProviderError(
  error: unknown,
  provider: "steam_api" | "notification",
): Exclude<SteamBanLookupProcessResult, { status: "complete" }> {
  if (error instanceof SteamProviderHttpError) {
    return classifyHttpStatus(error.status, provider, undefined, error.retryAfterSeconds);
  }
  return { status: "retry", reasonCode: `${provider}_network_error` };
}

function classifyHttpStatus(
  status: number,
  provider: "steam_api" | "notification",
  response?: Response,
  retryAfterSeconds = response ? readRetryAfterSeconds(response) : undefined,
): Exclude<SteamBanLookupProcessResult, { status: "complete" }> {
  if (status === 408 || status === 429 || status >= 500) {
    return {
      status: "retry",
      reasonCode: status === 429 ? `${provider}_rate_limited` : `${provider}_unavailable`,
      ...(retryAfterSeconds === undefined ? {} : { delaySeconds: retryAfterSeconds }),
    };
  }
  return { status: "terminal", reasonCode: `${provider}_rejected` };
}

function readRetryAfterSeconds(response: Response): number | undefined {
  const value = Number.parseFloat(response.headers.get("retry-after") ?? "");
  return Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : undefined;
}

export function extractSteamIdsFromBody(body: string): string[] {
  const steamIds = new Set<string>();
  for (const match of body.matchAll(STEAM_ID64_PATTERN)) {
    const steamId = match[1];
    if (steamId) {
      steamIds.add(steamId);
    }
  }
  return [...steamIds];
}

function parseSteamPlayerBan(player: unknown): SteamPlayerBanResult[] {
  if (!isRecord(player) || typeof player.SteamId !== "string") {
    return [];
  }

  return [
    {
      steamId64: player.SteamId,
      communityBanned: player.CommunityBanned === true,
      vacBanned: player.VACBanned === true,
      numberOfVacBans: asNumber(player.NumberOfVACBans),
      daysSinceLastBan: asNumber(player.DaysSinceLastBan),
      numberOfGameBans: asNumber(player.NumberOfGameBans),
      economyBan: typeof player.EconomyBan === "string" ? player.EconomyBan : "none",
      gameBans: Array.isArray(player.bans) ? player.bans.flatMap(parseGameBan) : [],
    },
  ];
}

function parseGameBan(value: unknown): SteamGameBan[] {
  if (!isRecord(value)) {
    return [];
  }
  const appId = asNumber(value.AppIdMin);
  if (appId <= 0) {
    return [];
  }
  return [
    {
      appId,
      banStartTimeUnix: asNumber(value.BanStartTime),
      banType: asNumber(value.BanType),
    },
  ];
}

function toCacheEntry(result: SteamPlayerBanResult, nowMs: number): SteamBanLookupCacheEntry {
  return { ...result, lastCheckedAtMs: nowMs };
}

function shouldNotify(
  result: SteamPlayerBanResult,
  cached: SteamBanLookupCacheEntry | undefined,
  appIds: number[],
): boolean {
  if (cached && hasSameBanStatus(result, cached)) {
    return false;
  }

  if (result.vacBanned && result.daysSinceLastBan <= 365) {
    return true;
  }

  if (result.numberOfGameBans <= 0) {
    return false;
  }

  return appIds.length === 0 || result.gameBans.some((ban) => appIds.includes(ban.appId));
}

function hasSameBanStatus(result: SteamPlayerBanResult, cached: SteamBanLookupCacheEntry): boolean {
  return JSON.stringify(toComparable(result)) === JSON.stringify(toComparable(cached));
}

function toComparable(result: Omit<SteamBanLookupCacheEntry, "lastCheckedAtMs">) {
  return {
    communityBanned: result.communityBanned,
    vacBanned: result.vacBanned,
    numberOfVacBans: result.numberOfVacBans,
    daysSinceLastBan: result.daysSinceLastBan,
    numberOfGameBans: result.numberOfGameBans,
    economyBan: result.economyBan,
    gameBans: result.gameBans,
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function groupMessages(messages: SteamBanLookupMessage[]): SteamBanLookupMessage[] {
  const groups = new Map<string, SteamBanLookupMessage>();
  for (const message of messages) {
    const appIds = [...new Set(message.banLookupAppIds)].sort((a, b) => a - b);
    const key = `${message.notificationUrl}\n${appIds.join(",")}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...message, banLookupAppIds: appIds });
      continue;
    }
    existing.steamIds = [...new Set([...existing.steamIds, ...message.steamIds])];
  }
  return [...groups.values()];
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
