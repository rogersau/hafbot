import type { PlayerCountProvider, PlayerCountServer } from "../types/player-count";

export interface PlayerCountStatusSnapshot {
  count: number;
  maxSlots: number;
  queue: number | null;
  serverName?: string;
  map?: string;
}

export type PlayerCountStatusResult =
  | { ok: true; snapshot: PlayerCountStatusSnapshot }
  | { ok: false; error: string; dormant?: boolean };

export interface PlayerCountStatusProvider {
  readiness?(server: PlayerCountServer): Promise<{
    ready: boolean;
    error?: string;
    sourceUpdatedAtMs?: number;
    targetExists?: boolean;
  }>;
  query(server: PlayerCountServer): Promise<PlayerCountStatusResult>;
}

export type PlayerCountStatusProviderResolver = (
  provider: string,
) => PlayerCountStatusProvider | undefined;

export function createPlayerCountStatusProviderResolver(
  providers: Readonly<Partial<Record<PlayerCountProvider, PlayerCountStatusProvider>>>,
): PlayerCountStatusProviderResolver {
  return (provider) =>
    Object.prototype.hasOwnProperty.call(providers, provider)
      ? providers[provider as PlayerCountProvider]
      : undefined;
}
