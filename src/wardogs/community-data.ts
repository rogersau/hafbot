import { z } from "zod";
import { GOLD_DAY_MS, WARDOGS_SERVER_LIST_URL } from "./gold-status";

export const WARDOGS_TRACKER_URL = "https://wardogstracker.gg";
export const STEAM_ID64 = /^\d{17}$/;

const GOLD_CACHE_MS = 5 * 60 * 1000;
const count = z.int().nonnegative();
const publicStatsSchema = z.object({
  wardogLevel: count,
  careerXp: count,
  unlocks: count.nullish(),
  cash: count.nullish(),
  gold: count.nullish(),
  syncedAt: z.iso.datetime({ offset: true }),
  roles: z.record(z.string(), z.object({ level: count })).nullish(),
});
const publicPlayerSchema = z.object({
  player: z.object({
    steamId: z.string().regex(STEAM_ID64),
    stats: publicStatsSchema.nullable(),
  }),
});
const goldDay = count.max(8_640_000_000_000_000).refine((value) => value % GOLD_DAY_MS === 0);
const goldPrice = z.int().positive();
const goldStatusSchema = z.object({
  latest: z.object({ ts: goldDay, price: goldPrice }),
  points: z
    .array(z.tuple([goldDay, goldPrice]))
    .optional()
    .catch(undefined),
});

export type WardogsPublicStats = z.infer<typeof publicStatsSchema>;
type WardogsGoldPrice = z.infer<typeof goldStatusSchema>["latest"];
export interface WardogsGoldStatus {
  latest: WardogsGoldPrice;
  history: WardogsGoldPrice[];
}

export async function fetchWardogsCommunity(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "HAF Bot (https://github.com/rogersau/hafbot)");
  return fetcher(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
}

export function createWardogsCommunityData(
  options: {
    goldApiKey?: string;
    fetcher?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const goldApiKey = options.goldApiKey?.trim();
  let goldCache: { status: WardogsGoldStatus; expiresAtMs: number } | undefined;
  let pendingGold: Promise<WardogsGoldStatus> | undefined;

  async function fetchGoldStatus(key: string): Promise<WardogsGoldStatus> {
    const response = await fetchWardogsCommunity(
      fetcher,
      `${WARDOGS_SERVER_LIST_URL}/api/gold-bars`,
      {
        headers: { Accept: "application/json", "X-API-Key": key },
      },
    );
    if (!response.ok) throw new Error("WARDOGS Server List request failed");
    const { latest, points } = goldStatusSchema.parse(await response.json());
    const checkedAtMs = now();
    const nextUtcDay = (Math.floor(checkedAtMs / GOLD_DAY_MS) + 1) * GOLD_DAY_MS;
    if (latest.ts >= nextUtcDay) throw new Error("WARDOGS Server List returned a future price");
    const history = new Map(
      (points ?? []).filter(([ts]) => ts >= latest.ts - 6 * GOLD_DAY_MS && ts < latest.ts),
    );
    history.set(latest.ts, latest.price);
    const status = {
      latest,
      history: [...history]
        .sort(([left], [right]) => left - right)
        .map(([ts, price]) => ({ ts, price })),
    };
    goldCache = { status, expiresAtMs: Math.min(checkedAtMs + GOLD_CACHE_MS, nextUtcDay) };
    return status;
  }

  return {
    goldAvailable: Boolean(goldApiKey),
    async readPublicStats(steamId: string): Promise<WardogsPublicStats | null> {
      if (!STEAM_ID64.test(steamId)) throw new Error("Invalid SteamID64");
      const response = await fetchWardogsCommunity(
        fetcher,
        `${WARDOGS_TRACKER_URL}/api/v1/players/${steamId}`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("WARDOGS Tracker request failed");
      const { player } = publicPlayerSchema.parse(await response.json());
      if (player.steamId !== steamId)
        throw new Error("WARDOGS Tracker returned a different player");
      return player.stats;
    },
    async readGoldStatus(): Promise<WardogsGoldStatus | null> {
      if (!goldApiKey) return null;
      if (goldCache && now() < goldCache.expiresAtMs) return goldCache.status;
      pendingGold ??= fetchGoldStatus(goldApiKey).finally(() => {
        pendingGold = undefined;
      });
      return pendingGold;
    },
  };
}

export type WardogsCommunityData = ReturnType<typeof createWardogsCommunityData>;
