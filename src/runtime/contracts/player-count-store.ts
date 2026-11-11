import type { PlayerCountServer } from "../../types/player-count";

export interface PlayerCountStore {
  setPlayerCountServerEnabled(guildId: string, id: string, enabled: boolean): Promise<boolean>;
  listPlayerCountServers(guildId: string): Promise<PlayerCountServer[]>;
  listAllPlayerCountServers(): Promise<PlayerCountServer[]>;
  readPlayerCountServer(id: string): Promise<PlayerCountServer | null>;
  upsertPlayerCountServer(server: PlayerCountServer): Promise<void>;
  deletePlayerCountServer(guildId: string, id: string): Promise<boolean>;
  updatePlayerCountSnapshot(body: {
    guildId: string;
    id: string;
    lastPlayerCount: number | null;
    lastMaxSlots: number | null;
    lastQueueSize: number | null;
    lastFetchedAtMs: number | null;
    expectedUpdatedAtMs?: number;
  }): Promise<boolean>;
  updateLastRenamedAt(body: { id: string; lastRenamedAtMs: number }): Promise<void>;
  incrementPlayerCountFailure(body: {
    guildId: string;
    id: string;
    errorMessage: string;
    errorAtMs: number;
    expectedUpdatedAtMs?: number;
  }): Promise<{ consecutiveFailureCount: number } | null>;
  resetPlayerCountFailure(guildId: string, id: string): Promise<boolean>;
}
