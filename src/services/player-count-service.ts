import type { PlayerCountStore } from "../runtime/contracts/player-count-store";
import type { GuildEntitlementStore } from "../runtime/contracts";
import type { PlayerCountServer, PlayerCountProvider } from "../types/player-count";
import { getGuildEntitlementLimits } from "../types";
import { createChannelMessage, suppressMentions, type DiscordEmbed } from "../discord/messages";
import type { OperationalIncidentReporter } from "../operations/incidents";
import { reportOperationalEvent } from "../observability/operational-reporter";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import type {
  PlayerCountStatusProviderResolver,
  PlayerCountStatusResult,
} from "./player-count-status-provider";

export interface PlayerCountAuditEventInput {
  guildId: string;
  serverId: string;
  serverName: string;
  identifier: string;
  errorMessage: string;
  streakCount: number;
}

export type PostPlayerCountAuditEventFn = (input: PlayerCountAuditEventInput) => Promise<void>;

export interface PlayerCountDeletionAuditEventInput {
  guildId: string;
  serverId: string;
  serverName: string;
  identifier: string;
  actorUserId: string;
}

export type PostPlayerCountDeletionAuditEventFn = (
  input: PlayerCountDeletionAuditEventInput,
) => Promise<void>;

export interface PlayerCountStreakReportedStore {
  isStreakReported(key: string): Promise<boolean>;
  markStreakReported(key: string): Promise<void>;
  clearStreakReported(key: string): Promise<void>;
}

export interface PlayerCountServiceOptions {
  discordBotToken: string;
  modifyChannel: (channelId: string, body: { name: string }) => Promise<void>;
  resolveStatusProvider: PlayerCountStatusProviderResolver;
  streakReportedStore: PlayerCountStreakReportedStore;
  postPlayerCountAuditEvent: PostPlayerCountAuditEventFn;
  postPlayerCountDeletionAuditEvent: PostPlayerCountDeletionAuditEventFn;
  guildEntitlements?: GuildEntitlementStore;
  operationalIncidents?: OperationalIncidentReporter;
  reportOperationalEvent?: typeof reportOperationalEvent;
  guildResources?: GuildResourceValidator;
  isGuildSuspended?: (guildId: string) => Promise<boolean>;
  enabled?: boolean;
  now?: () => number;
}

const CRON_TICK_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 10;
const MIN_REFRESH_INTERVAL_MINUTES = 5;
const MAX_REFRESH_INTERVAL_MINUTES = 60;
const DEFAULT_FAILURE_THRESHOLD = 3;
const MIN_FAILURE_THRESHOLD = 1;
const MAX_FAILURE_THRESHOLD = 20;

export const PLAYER_COUNT_FAILURE_STREAK_THRESHOLD = DEFAULT_FAILURE_THRESHOLD;

function normalizeFailureThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_FAILURE_THRESHOLD;
  }
  return Math.max(MIN_FAILURE_THRESHOLD, Math.min(MAX_FAILURE_THRESHOLD, value));
}

function safePlayerCountFailureCategory(
  error: string,
):
  | "provider_not_configured"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_network_error"
  | "unknown" {
  if (/not configured/i.test(error)) return "provider_not_configured";
  if (/network|timeout|fetch/i.test(error)) return "provider_network_error";
  if (/reject|invalid|unauthori[sz]|forbidden/i.test(error)) return "provider_rejected";
  if (/unavailable|offline|connect/i.test(error)) return "provider_unavailable";
  return "unknown";
}

export function playerCountStreakReportedKey(guildId: string, serverId: string): string {
  return `player_count:streak_reported:${guildId}:${serverId}`;
}

export function formatPlayerCountLastUpdated(server: PlayerCountServer): string {
  if (!server.lastFetchedAtMs) return "Never";
  const minutes = Math.round((Date.now() - server.lastFetchedAtMs) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes === 1) return "1 minute ago";
  return `${minutes} minutes ago`;
}

export function buildPlayerCountStatusEmbed(servers: PlayerCountServer[]): DiscordEmbed {
  const onlineCount = servers.filter((s) => s.lastPlayerCount !== null).length;
  const offlineCount = servers.length - onlineCount;

  const fields = servers.map((server): { name: string; value: string; inline: boolean } => {
    const isOnline = server.lastPlayerCount !== null;
    const statusEmoji = isOnline ? "🟢" : "🔴";
    const name = `${statusEmoji} ${server.name}`;

    if (isOnline) {
      const parts = [`${server.lastPlayerCount ?? "?"}/${server.lastMaxSlots ?? "?"} players`];
      if (server.lastQueueSize === null) parts.push("Queue: Unavailable");
      if ((server.lastQueueSize ?? 0) > 0) {
        parts.push(`Queue: ${server.lastQueueSize}`);
      }
      parts.push(`Updated ${formatPlayerCountLastUpdated(server)}`);
      return { name, value: parts.join(" · "), inline: true };
    }

    const parts = ["Offline"];
    if (server.consecutiveFailureCount > 0) {
      parts.push(`${server.consecutiveFailureCount} failed checks`);
    }
    parts.push(`Updated ${formatPlayerCountLastUpdated(server)}`);
    return { name, value: parts.join(" · "), inline: true };
  });

  return {
    title: "🎮 Server Status",
    color: offlineCount > 0 ? 0xfee75c : 0x57f287,
    description: `${servers.length} tracked · ${onlineCount} online · ${offlineCount} offline`,
    fields,
    timestamp: new Date().toISOString(),
  };
}

function playerCountServerIdentifier(server: PlayerCountServer): string {
  return server.provider === "wardogs-rcon"
    ? `WARDOGS target ${server.providerServerId}`
    : `${server.steamHost ?? "?"}:${server.steamPort ?? 27015}`;
}

export function buildPlayerCountAlertEmbed(
  server: PlayerCountServer,
  streakCount: number,
  errorMessage: string,
): DiscordEmbed {
  const identifier = playerCountServerIdentifier(server);
  return {
    title: "🚨 Player Count Alert",
    color: 0xed4245,
    description: `**${server.name}** has been unreachable for ${streakCount} consecutive checks.`,
    fields: [
      { name: "Identifier", value: identifier, inline: true },
      { name: "Error", value: errorMessage, inline: false },
    ],
    timestamp: new Date().toISOString(),
  };
}

export function applyPlayerCountTemplate(template: string, server: PlayerCountServer): string {
  const queue = server.lastQueueSize;

  let result = template.replace(/\{queue\?([^}]*)\}/g, (_, prefix: string) => {
    return queue !== null && queue > 0 ? prefix + String(queue) : "";
  });

  result = result
    .replace(/{name}/g, server.name)
    .replace(/{count}/g, String(server.lastPlayerCount ?? "?"))
    .replace(/{max}/g, String(server.lastMaxSlots ?? "?"))
    .replace(/{queue}/g, String(queue ?? "?"));

  return result;
}

export class PlayerCountService {
  constructor(
    private readonly store: PlayerCountStore,
    private readonly options: PlayerCountServiceOptions,
  ) {}

  async listServers(guildId: string): Promise<PlayerCountServer[]> {
    const servers = await this.store.listPlayerCountServers(guildId);
    return Promise.all(servers.map((server) => this.clearChangedSource(server, true)));
  }

  async addServer(params: {
    guildId: string;
    name: string;
    provider: PlayerCountProvider;
    providerServerId: string;
    channelId?: string;
    alertChannelId?: string;
    steamHost?: string;
    steamPort?: number;
    refreshIntervalMinutes?: number;
    failureThreshold?: number;
  }): Promise<{ ok: true; server: PlayerCountServer } | { ok: false; error: string }> {
    const resources = this.options.guildResources
      ? await this.options.guildResources.forGuild(params.guildId)
      : null;
    if (params.channelId) resources?.requireVoiceChannel(params.channelId);
    if (params.alertChannelId) resources?.requireTextChannel(params.alertChannelId);
    const existing = await this.store.listPlayerCountServers(params.guildId);
    if (existing.some((s) => s.name === params.name)) {
      return { ok: false, error: `A server named "${params.name}" already exists.` };
    }

    const now = this.options.now?.() ?? Date.now();
    const server: PlayerCountServer = {
      id: crypto.randomUUID(),
      guildId: params.guildId,
      name: params.name,
      provider: params.provider,
      providerServerId: params.providerServerId,
      channelId: params.channelId ?? null,
      alertChannelId: params.alertChannelId ?? null,
      refreshIntervalMinutes: this.normalizeRefreshIntervalMinutes(params.refreshIntervalMinutes),
      displayFormat: "🎮 Players: {count}/{max}",
      offlineFormat: "🎮 Players: Offline",
      failureThreshold: normalizeFailureThreshold(params.failureThreshold),
      renameOffsetMinutes: Math.floor(Math.random() * 10),
      lastRenamedAtMs: null,
      lastPlayerCount: null,
      lastMaxSlots: null,
      lastQueueSize: null,
      lastFetchedAtMs: null,
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      lastErrorAtMs: null,
      steamHost: params.steamHost ?? null,
      steamPort: params.steamPort ?? null,
      createdAtMs: now,
      updatedAtMs: now,
    };

    if (server.provider === "wardogs-rcon") {
      if (
        !(await this.options.resolveStatusProvider(server.provider)?.readiness?.(server))
          ?.targetExists
      )
        return { ok: false, error: "WARDOGS target is unavailable for this Guild." };
      server.steamHost = null;
      server.steamPort = null;
    }
    await this.store.upsertPlayerCountServer(server);
    return { ok: true, server };
  }

  async removeServer(guildId: string, name: string, actorUserId: string): Promise<boolean> {
    const servers = await this.store.listPlayerCountServers(guildId);
    const match = servers.find((s) => s.name === name);
    if (!match) return false;
    return (await this.deleteServer(guildId, match.id, actorUserId)) !== null;
  }

  async deleteServer(
    guildId: string,
    serverId: string,
    actorUserId: string,
  ): Promise<PlayerCountServer | null> {
    const server = await this.store.readPlayerCountServer(serverId);
    if (!server || server.guildId !== guildId) return null;
    await this.clearStreakReportedFlag(server);
    await this.options.operationalIncidents?.observeHealthy({
      guildId,
      key: {
        feature: "player-count",
        resourceKind: "server",
        resourceId: server.id,
        condition: "offline",
      },
    });
    if (!(await this.store.deletePlayerCountServer(guildId, serverId))) return null;
    try {
      await this.options.postPlayerCountDeletionAuditEvent({
        guildId,
        serverId: server.id,
        serverName: server.name,
        identifier: playerCountServerIdentifier(server),
        actorUserId,
      });
    } catch (error) {
      console.error("Failed to post Player Count deletion audit event", error);
    }
    return server;
  }

  async testServerReachability(
    guildId: string,
    serverId: string,
  ): Promise<
    | { ok: true; snapshot: { count: number; maxSlots: number; queue: number | null } }
    | { ok: false; error: string }
  > {
    const server = await this.store.readPlayerCountServer(serverId);
    if (!server || server.guildId !== guildId) {
      return { ok: false, error: "Server not found" };
    }
    return await this.queryServer(await this.clearChangedSource(server, true));
  }

  async refreshAllServers(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const allServers = await this.clearChangedSources(
      await this.store.listAllPlayerCountServers(),
      true,
    );
    const paidGuildIds = await this.paidGuildIds(allServers);
    const dueServers = allServers.filter(
      (server) =>
        server.enabled !== false &&
        paidGuildIds.has(server.guildId) &&
        this.isRefreshDue(server, now),
    );

    const results = await Promise.allSettled(
      dueServers.map(async (server) => {
        await this.refreshServerState(await this.clearChangedSource(server, true), now);
      }),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const server = dueServers[index]!;
        try {
          (this.options.reportOperationalEvent ?? reportOperationalEvent)({
            severity: "error",
            code: "player_count.server_refresh_failed",
            message: "Player count server refresh failed",
            cause: new Error("Player count server refresh failed", { cause: result.reason }),
            guildId: server.guildId,
            operation: "refresh_player_count",
            context: { serverId: server.id },
          });
        } catch {
          // Telemetry must not interrupt the batch or subsequent channel renaming.
        }
      }
    }
  }

  async refreshServer(
    guildId: string,
    serverId: string,
  ): Promise<{ ok: true; server: PlayerCountServer } | { ok: false; error: string }> {
    const server = await this.store.readPlayerCountServer(serverId);
    if (!server || server.guildId !== guildId) return { ok: false, error: "Server not found" };
    return this.refreshServerState(
      await this.clearChangedSource(server, true),
      this.options.now?.() ?? Date.now(),
    );
  }

  private async refreshServerState(
    server: PlayerCountServer,
    now: number,
  ): Promise<{ ok: true; server: PlayerCountServer } | { ok: false; error: string }> {
    const result = await this.queryServer(server);
    if (result.ok) {
      const updated = await this.store.updatePlayerCountSnapshot({
        guildId: server.guildId,
        id: server.id,
        lastPlayerCount: result.snapshot.count,
        lastMaxSlots: result.snapshot.maxSlots,
        lastQueueSize: result.snapshot.queue,
        lastFetchedAtMs: now,
        expectedUpdatedAtMs: server.updatedAtMs,
      });
      if (!updated) return { ok: false, error: "Server not found" };
      await this.clearStreakReportedFlag(server);
      await this.options.operationalIncidents?.observeHealthy({
        guildId: server.guildId,
        key: {
          feature: "player-count",
          resourceKind: "server",
          resourceId: server.id,
          condition: "offline",
        },
        observedAtMs: now,
      });
      return {
        ok: true,
        server: {
          ...server,
          lastPlayerCount: result.snapshot.count,
          lastMaxSlots: result.snapshot.maxSlots,
          lastQueueSize: result.snapshot.queue,
          lastFetchedAtMs: now,
          consecutiveFailureCount: 0,
          lastErrorAtMs: null,
          lastErrorMessage: null,
        },
      };
    }

    if (result.dormant) return result;
    const failure = await this.store.incrementPlayerCountFailure({
      guildId: server.guildId,
      id: server.id,
      errorMessage: result.error,
      errorAtMs: now,
      expectedUpdatedAtMs: server.updatedAtMs,
    });
    if (!failure) return { ok: false, error: result.error };
    const latest = await this.store.readPlayerCountServer(server.id);
    if (!latest || latest.enabled === false)
      return { ok: false, error: "Player Count is disabled for this server." };
    const { consecutiveFailureCount: newStreakCount } = failure;
    if (newStreakCount === server.failureThreshold) {
      await this.maybeEmitStreakAlert(server, newStreakCount, result.error);
    }
    if (newStreakCount >= server.failureThreshold) {
      const longFailure =
        server.lastErrorAtMs !== null && now - server.lastErrorAtMs >= 30 * 60_000;
      await this.options.operationalIncidents?.observeFailure({
        guildId: server.guildId,
        key: {
          feature: "player-count",
          resourceKind: "server",
          resourceId: server.id,
          condition: "offline",
        },
        observationId: `player-count:${server.id}:${now}`,
        severity: longFailure ? "error" : "warning",
        summaryCode: "player_count_server_offline",
        safeArgs: {
          serverId: server.id,
          consecutiveFailureCount: newStreakCount,
          lastSuccessfulFetchAtMs: server.lastFetchedAtMs,
          providerErrorCategory: safePlayerCountFailureCategory(result.error),
        },
        remediationCode: "refresh_player_count_server",
        observedAtMs: now,
      });
    }
    return { ok: false, error: result.error };
  }

  private async maybeEmitStreakAlert(
    server: PlayerCountServer,
    streakCount: number,
    errorMessage: string,
  ): Promise<void> {
    const store = this.options.streakReportedStore;
    const poster = this.options.postPlayerCountAuditEvent;
    const key = playerCountStreakReportedKey(server.guildId, server.id);
    if (await store.isStreakReported(key)) return;
    const latest = await this.store.readPlayerCountServer(server.id);
    if (!latest || latest.enabled === false) return;

    await poster({
      guildId: server.guildId,
      serverId: server.id,
      serverName: server.name,
      identifier: playerCountServerIdentifier(server),
      errorMessage,
      streakCount,
    });

    if (server.alertChannelId) {
      try {
        (await this.options.guildResources?.forGuild(server.guildId))?.requireTextChannel(
          server.alertChannelId,
        );
        await createChannelMessage(
          server.alertChannelId,
          {
            embeds: [buildPlayerCountAlertEmbed(server, streakCount, errorMessage)],
            allowed_mentions: suppressMentions(),
          },
          this.options.discordBotToken,
        );
      } catch (error) {
        console.error("Failed to post player count alert", error);
      }
    }

    await store.markStreakReported(key);
  }

  async clearFailureAlerts(guildId: string, serverId: string): Promise<void> {
    const server = await this.store.readPlayerCountServer(serverId);
    if (!server || server.guildId !== guildId) return;
    await this.clearStreakReportedFlag(server);
    await this.options.operationalIncidents?.observeHealthy({
      guildId,
      key: {
        feature: "player-count",
        resourceKind: "server",
        resourceId: server.id,
        condition: "offline",
      },
    });
  }

  private async clearStreakReportedFlag(server: PlayerCountServer): Promise<void> {
    await this.options.streakReportedStore.clearStreakReported(
      playerCountStreakReportedKey(server.guildId, server.id),
    );
  }

  private async clearChangedSource(
    server: PlayerCountServer,
    persist = false,
  ): Promise<PlayerCountServer> {
    if (server.provider !== "wardogs-rcon") return server;
    const readiness = await this.options
      .resolveStatusProvider(server.provider)
      ?.readiness?.(server);
    const observationAtMs = server.lastFetchedAtMs ?? server.lastErrorAtMs;
    if (
      observationAtMs !== null &&
      readiness?.sourceUpdatedAtMs !== undefined &&
      observationAtMs <= readiness.sourceUpdatedAtMs
    ) {
      if (persist) {
        const cleared = await this.store.updatePlayerCountSnapshot({
          guildId: server.guildId,
          id: server.id,
          lastPlayerCount: null,
          lastMaxSlots: null,
          lastQueueSize: null,
          lastFetchedAtMs: null,
          expectedUpdatedAtMs: server.updatedAtMs,
        });
        if (cleared) await this.clearFailureAlerts(server.guildId, server.id);
        server = (await this.store.readPlayerCountServer(server.id)) ?? server;
      } else {
        server = {
          ...server,
          lastPlayerCount: null,
          lastMaxSlots: null,
          lastQueueSize: null,
          lastFetchedAtMs: null,
          consecutiveFailureCount: 0,
          lastErrorMessage: null,
          lastErrorAtMs: null,
        };
      }
    }
    return {
      ...server,
      readiness: readiness?.ready ? "ready" : "dormant",
      readinessMessage:
        readiness?.error ?? (readiness ? undefined : "WARDOGS provider is unavailable."),
    };
  }

  private async clearChangedSources(
    servers: PlayerCountServer[],
    persist: boolean,
  ): Promise<PlayerCountServer[]> {
    const results = await Promise.allSettled(
      servers.map((server) => this.clearChangedSource(server, persist)),
    );
    return results.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      console.error(
        `Failed to reconcile Player Count source ${servers[index]!.id}:`,
        result.reason,
      );
      return servers[index]!;
    });
  }

  private async queryServer(server: PlayerCountServer): Promise<PlayerCountStatusResult> {
    const latest = await this.store.readPlayerCountServer(server.id);
    if (!latest || latest.enabled === false)
      return { ok: false, dormant: true, error: "Player Count is disabled for this server." };
    if (
      server.enabled === false ||
      this.options.enabled === false ||
      !(await this.paidGuildIds([server])).has(server.guildId) ||
      (await this.options.isGuildSuspended?.(server.guildId))
    )
      return {
        ok: false,
        dormant: true,
        error: "Player Count polling is unavailable for this Guild.",
      };
    const statusProvider = this.options.resolveStatusProvider(server.provider);
    if (!statusProvider) {
      return { ok: false, error: `Player count provider not configured: ${server.provider}` };
    }
    let result: PlayerCountStatusResult;
    try {
      result = await statusProvider.query(server);
    } catch {
      return { ok: false, error: "Player count provider unavailable" };
    }
    if (!result.ok) return result;
    return {
      ok: true,
      snapshot: {
        count: result.snapshot.count,
        maxSlots: result.snapshot.maxSlots,
        queue: result.snapshot.queue,
        ...(server.provider === "wardogs-rcon"
          ? { serverName: result.snapshot.serverName, map: result.snapshot.map }
          : {}),
      },
    };
  }

  async renameDueChannels(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const allServers = await this.clearChangedSources(
      await this.store.listAllPlayerCountServers(),
      true,
    );
    const paidGuildIds = await this.paidGuildIds(allServers);

    const dueServers = allServers.filter((server) => {
      if (server.enabled === false || !paidGuildIds.has(server.guildId)) return false;
      if (!server.channelId) return false;
      if (server.lastRenamedAtMs && now - server.lastRenamedAtMs < 5 * 60 * 1000) return false;
      return true;
    });

    const results = await Promise.allSettled(
      dueServers.map(async (server) => {
        if (
          !server.channelId ||
          this.options.enabled === false ||
          (await this.options.isGuildSuspended?.(server.guildId))
        )
          return;
        const readiness = await this.options
          .resolveStatusProvider(server.provider)
          ?.readiness?.(server);
        const currentSnapshot =
          server.lastFetchedAtMs !== null &&
          (readiness?.sourceUpdatedAtMs === undefined ||
            server.lastFetchedAtMs > readiness.sourceUpdatedAtMs);
        const currentOfflineFailure =
          server.consecutiveFailureCount >= server.failureThreshold &&
          server.lastErrorAtMs !== null &&
          (readiness?.sourceUpdatedAtMs === undefined ||
            server.lastErrorAtMs > readiness.sourceUpdatedAtMs);
        if (readiness && (!readiness.ready || (!currentSnapshot && !currentOfflineFailure))) return;
        const latest = await this.store.readPlayerCountServer(server.id);
        if (!latest || latest.enabled === false || latest.updatedAtMs !== server.updatedAtMs)
          return;
        const channelName = this.buildChannelName(server);
        try {
          (await this.options.guildResources?.forGuild(server.guildId))?.requireVoiceChannel(
            server.channelId,
          );
          await this.options.modifyChannel(server.channelId, { name: channelName });
          await this.store.updateLastRenamedAt({
            id: server.id,
            lastRenamedAtMs: now,
          });
        } catch (error) {
          console.error(
            `Failed to rename channel ${server.channelId} for server ${server.id}:`,
            error,
          );
        }
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Channel rename failed:", result.reason);
      }
    }
  }

  private async paidGuildIds(servers: PlayerCountServer[]): Promise<Set<string>> {
    const guildIds = [...new Set(servers.map((server) => server.guildId))];
    if (!this.options.guildEntitlements) return new Set(guildIds);
    const paid = await Promise.all(
      guildIds.map(async (guildId) => {
        const entitlement = await this.options.guildEntitlements?.readGuildEntitlement(guildId);
        return entitlement && getGuildEntitlementLimits(entitlement.tier).paidFeatures
          ? guildId
          : null;
      }),
    );
    return new Set(paid.filter((guildId): guildId is string => guildId !== null));
  }

  buildChannelName(server: PlayerCountServer): string {
    const format =
      server.lastPlayerCount === null || server.consecutiveFailureCount >= server.failureThreshold
        ? server.offlineFormat
        : server.displayFormat;
    const raw = applyPlayerCountTemplate(format, server);

    if (raw.length <= 100) return raw;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(raw);
    if (bytes.length <= 100) return raw;

    let truncatedBytes = bytes.slice(0, 97);
    let decoded = decoder.decode(truncatedBytes);
    while (decoded.length > 97 && truncatedBytes.length > 0) {
      truncatedBytes = truncatedBytes.slice(0, -1);
      decoded = decoder.decode(truncatedBytes);
    }
    return decoded + "...";
  }

  formatServerStatus(server: PlayerCountServer): string {
    if (server.lastPlayerCount === null) {
      return `${server.name}: ${server.offlineFormat}`;
    }
    const display = applyPlayerCountTemplate(server.displayFormat, server);
    return `${server.name}: ${display}`;
  }

  private normalizeRefreshIntervalMinutes(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return DEFAULT_REFRESH_INTERVAL_MINUTES;
    }
    return Math.max(MIN_REFRESH_INTERVAL_MINUTES, Math.min(MAX_REFRESH_INTERVAL_MINUTES, value));
  }

  private getRefreshStaggerMs(server: PlayerCountServer): number {
    const intervalMinutes = this.normalizeRefreshIntervalMinutes(server.refreshIntervalMinutes);
    const intervalTicks = Math.max(1, Math.ceil(intervalMinutes / 5));
    const offsetTick =
      ((server.renameOffsetMinutes % intervalTicks) + intervalTicks) % intervalTicks;
    return offsetTick * CRON_TICK_MS;
  }

  private isRefreshDue(server: PlayerCountServer, now: number): boolean {
    const intervalMinutes = this.normalizeRefreshIntervalMinutes(server.refreshIntervalMinutes);
    const intervalMs = intervalMinutes * 60 * 1000;
    const lastFetchedAtMs =
      server.lastFetchedAtMs ?? server.createdAtMs - this.getRefreshStaggerMs(server);

    return now - lastFetchedAtMs >= intervalMs;
  }
}
