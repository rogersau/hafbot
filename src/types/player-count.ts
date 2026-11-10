export type PlayerCountProvider = "steam-web" | "wardogs-rcon";

export interface PlayerCountServer {
  /** Omitted legacy values are enabled. */
  enabled?: boolean;
  readiness?: "ready" | "dormant";
  readinessMessage?: string;
  id: string;
  guildId: string;
  name: string;
  provider: PlayerCountProvider;
  providerServerId: string;
  channelId: string | null;
  alertChannelId: string | null;
  refreshIntervalMinutes: number;
  displayFormat: string;
  offlineFormat: string;
  failureThreshold: number;
  renameOffsetMinutes: number;
  lastRenamedAtMs: number | null;
  lastPlayerCount: number | null;
  lastMaxSlots: number | null;
  lastQueueSize: number | null;
  lastFetchedAtMs: number | null;
  steamHost: string | null;
  steamPort: number | null;
  consecutiveFailureCount: number;
  lastErrorMessage: string | null;
  lastErrorAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PlayerCountServerRow {
  id: string;
  guild_id: string;
  name: string;
  provider: string;
  provider_server_id: string;
  channel_id: string | null;
  alert_channel_id: string | null;
  refresh_interval_minutes: number;
  display_format: string;
  offline_format: string;
  failure_threshold: number;
  rename_offset_minutes: number;
  last_renamed_at_ms: number | null;
  last_player_count: number | null;
  last_max_slots: number | null;
  last_queue_size: number | null;
  last_fetched_at_ms: number | null;
  steam_host: string | null;
  steam_port: number | null;
  consecutive_failure_count: number;
  last_error_message: string | null;
  last_error_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}
