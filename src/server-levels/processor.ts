import type { PlatformLink, PlatformLinkStore } from "../runtime/contracts/platform-link-store";
import type { ServerLevelStore } from "../runtime/contracts/server-level-store";
import type { GuildEntitlementTier } from "../types";
import type {
  ConfiguredGameServer,
  ServerLevelAward,
  ServerLevelEarningSession,
  ServerLevelProcessingCursor,
  ServerLevelPresence,
  ServerLevelProviderEvent,
} from "./model";
import {
  SERVER_LEVEL_MAX_CONTINUOUS_SECONDS,
  SERVER_LEVEL_ORDERING_WINDOW_MS,
  SERVER_LEVEL_ROLLING_CAP_SECONDS,
  SERVER_LEVEL_ROLLING_WINDOW_SECONDS,
  SERVER_LEVEL_SCORING_POLICY_VERSION,
  calculateServerXpUnits,
  calculateServerLevel,
  resolveOccupancyMultiplier,
  type ServerLevelMultiplier,
} from "./policy";
import { emitServerLevelTelemetry, type ServerLevelTelemetryEmitter } from "./telemetry";

export interface ServerLevelProcessorOptions {
  store: ServerLevelStore;
  platformLinks: PlatformLinkStore;
  readEntitlementTier: (guildId: string) => Promise<GuildEntitlementTier>;
  isCurrentGuildMember: (guildId: string, userId: string) => Promise<boolean>;
  isKillSwitchEnabled?: () => boolean;
  now?: () => number;
  createId?: () => string;
  emitTelemetry?: ServerLevelTelemetryEmitter;
}

export interface ServerLevelProcessingSummary {
  processed: number;
  late: number;
  rejected: number;
}

export interface ServerLevelRosterReconciliationInput {
  configuredGameServerId: string;
  steamIds: string[];
  population: number;
  queueSize: number;
  maxSlots: number;
  observedAtMs: number;
  checkCapacity: boolean;
}

const SERVER_LEVEL_PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export class ServerLevelProcessor {
  constructor(private readonly options: ServerLevelProcessorOptions) {}

  async replaceLinkedIdentities(
    link: PlatformLink,
    replaceLinks: () => Promise<void>,
  ): Promise<void> {
    const servers = (await this.options.store.listConfiguredGameServers(link.guildId)).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    const replaceWithLeases = async (index: number): Promise<void> => {
      const server = servers[index];
      if (server) {
        await this.withRequiredProcessingLease(server.id, () => replaceWithLeases(index + 1));
        return;
      }
      // Read the removal snapshot under every affected server lease. A provider worker
      // must not observe the replacement until the old sessions have been checkpointed.
      const removedLinks = (
        await this.options.platformLinks.listPlatformLinksByUser(link.guildId, link.userId)
      ).filter((old) => old.platform === "steam" && old.platformId !== link.platformId);
      const removedAtMs = this.options.now?.() ?? Date.now();
      // Persist every final award before removing its identity. Keep sessions and
      // presence open so a failed checkpoint or replacement can continue earning.
      for (const server of servers) {
        for (const removed of removedLinks) {
          const session = await this.options.store.readOpenEarningSession(
            server.id,
            removed.platformId,
          );
          if (session?.userId !== removed.userId) continue;
          await this.checkpointSessions({
            server,
            sessions: [session],
            stoppedAtMs: removedAtMs,
            sourceId: `unlink:${removed.guildId}:${removed.userId}:${removed.platformId}:${removedAtMs}`,
            verifyCurrentMembership: true,
            linkSnapshot: removed,
          });
        }
      }
      await replaceLinks();
      // Cleanup must not perform fallible eligibility checks or award writes:
      // subsequent provider processing can safely close any session left behind.
      for (const server of servers) {
        for (const removed of removedLinks) {
          const session = await this.options.store.readOpenEarningSession(
            server.id,
            removed.platformId,
          );
          if (session?.userId === removed.userId) {
            await this.options.store.closeEarningSession(
              session.sessionId,
              session.checkpointAtMs,
              "steam_link_removed",
            );
          }
          await this.options.store.deleteCurrentPresence(
            removed.guildId,
            server.id,
            removed.platformId,
          );
        }
      }
    };
    await replaceWithLeases(0);
  }

  async stopEarningForLinkedIdentity(input: {
    guildId: string;
    userId: string;
    steamId64: string;
    removedAtMs: number;
    /** Trusted removal snapshot, allowing finalization after replacement commits. */
    linkSnapshot?: PlatformLink;
  }): Promise<void> {
    const servers = await this.options.store.listConfiguredGameServers(input.guildId);
    for (const server of servers) {
      await this.withRequiredProcessingLease(server.id, () =>
        this.stopEarningForLinkedIdentityWithLease(server, input),
      );
    }
  }

  private async stopEarningForLinkedIdentityWithLease(
    server: ConfiguredGameServer,
    input: {
      guildId: string;
      userId: string;
      steamId64: string;
      removedAtMs: number;
      linkSnapshot?: PlatformLink;
    },
  ): Promise<void> {
    const session = await this.options.store.readOpenEarningSession(server.id, input.steamId64);
    if (session?.userId === input.userId) {
      await this.checkpointSessions({
        server,
        sessions: [session],
        stoppedAtMs: input.removedAtMs,
        closeReason: "steam_link_removed",
        sourceId: `unlink:${input.guildId}:${input.userId}:${input.steamId64}:${input.removedAtMs}`,
        verifyCurrentMembership: true,
        linkSnapshot: input.linkSnapshot,
      });
    }
    await this.options.store.deleteCurrentPresence(input.guildId, server.id, input.steamId64);
  }

  async stopEarningForGuild(input: {
    guildId: string;
    stoppedAtMs: number;
    reason: string;
    sourceId: string;
  }): Promise<void> {
    const servers = await this.options.store.listConfiguredGameServers(input.guildId);
    for (const server of servers) {
      await this.withRequiredProcessingLease(server.id, async () => {
        await this.checkpointSessions({
          server,
          sessions: await this.options.store.listOpenEarningSessions(server.id),
          stoppedAtMs: input.stoppedAtMs,
          closeReason: input.reason,
          sourceId: input.sourceId,
          verifyCurrentMembership: true,
        });
        await this.options.store.clearCurrentPresence(input.guildId, server.id);
      });
    }
  }

  async stopEarningForMember(input: {
    guildId: string;
    userId: string;
    stoppedAtMs: number;
    sourceId: string;
  }): Promise<void> {
    const steamIds = new Set(
      (await this.options.platformLinks.listPlatformLinksByUser(input.guildId, input.userId))
        .filter((link) => link.platform === "steam")
        .map((link) => link.platformId),
    );
    const servers = await this.options.store.listConfiguredGameServers(input.guildId);
    for (const server of servers) {
      await this.withRequiredProcessingLease(server.id, async () => {
        const sessions = (await this.options.store.listOpenEarningSessions(server.id)).filter(
          (session) => session.userId === input.userId,
        );
        for (const session of sessions) steamIds.add(session.steamId64);
        await this.checkpointSessions({
          server,
          sessions,
          stoppedAtMs: input.stoppedAtMs,
          closeReason: "member_left_guild",
          sourceId: input.sourceId,
          verifyCurrentMembership: false,
        });
        for (const steamId64 of steamIds) {
          await this.options.store.deleteCurrentPresence(input.guildId, server.id, steamId64);
        }
      });
    }
  }

  async replaceConfiguredGameServerProvider(input: {
    current: ConfiguredGameServer;
    replacement: ConfiguredGameServer;
    changedAtMs: number;
    sourceId: string;
  }): Promise<void> {
    if (
      input.current.id !== input.replacement.id ||
      input.current.guildId !== input.replacement.guildId
    ) {
      throw new Error("Configured Game Server identity cannot change.");
    }
    await this.withRequiredProcessingLease(input.current.id, async () => {
      const current = await this.options.store.readConfiguredGameServer(
        input.current.guildId,
        input.current.id,
      );
      if (!current) throw new Error("Configured Game Server not found.");
      await this.checkpointSessions({
        server: current,
        sessions: await this.options.store.listOpenEarningSessions(current.id),
        stoppedAtMs: input.changedAtMs,
        closeReason: "provider_server_changed",
        sourceId: input.sourceId,
        verifyCurrentMembership: true,
      });
      await this.options.store.replaceConfiguredGameServerProvider(
        input.replacement,
        input.changedAtMs,
      );
    });
  }

  async processAvailableForServer(
    configuredGameServerId: string,
  ): Promise<ServerLevelProcessingSummary> {
    return this.withProcessingLease(
      configuredGameServerId,
      { processed: 0, late: 0, rejected: 0 },
      async () => {
        const now = this.options.now?.() ?? Date.now();
        try {
          const events = await this.options.store.listAcceptedProviderEvents(
            configuredGameServerId,
            now - SERVER_LEVEL_ORDERING_WINDOW_MS,
          );
          const summary: ServerLevelProcessingSummary = { processed: 0, late: 0, rejected: 0 };
          for (const event of events) {
            const outcome = await this.processEvent(event, now);
            summary[outcome] += 1;
          }
          for (const outcome of ["processed", "late", "rejected"] as const) {
            if (summary[outcome] > 0) {
              emitServerLevelTelemetry(this.options.emitTelemetry, {
                category: "processing",
                outcome,
                durationMs: (this.options.now?.() ?? Date.now()) - now,
                count: summary[outcome],
              });
            }
          }
          return summary;
        } catch (error) {
          emitServerLevelTelemetry(this.options.emitTelemetry, {
            category: "processing",
            outcome: "failed",
            durationMs: (this.options.now?.() ?? Date.now()) - now,
            count: 1,
            reasonCode: "unhandled_error",
          });
          throw error;
        }
      },
    );
  }

  async checkpointAvailableForServer(
    configuredGameServerId: string,
    now = this.options.now?.() ?? Date.now(),
  ): Promise<void> {
    await this.withProcessingLease(configuredGameServerId, undefined, () =>
      this.checkpointAvailableForServerWithLease(configuredGameServerId, now),
    );
  }

  async reconcileCurrentRoster(
    input: ServerLevelRosterReconciliationInput,
  ): Promise<"completed" | "skipped"> {
    const startedAtMs = this.options.now?.() ?? Date.now();
    try {
      validateRosterObservation(input);
      const outcome = await this.withProcessingLease(
        input.configuredGameServerId,
        "skipped",
        async () => {
          const server = await this.options.store.readConfiguredGameServerById(
            input.configuredGameServerId,
          );
          if (!server) return "skipped" as const;
          const [config, entitlementTier] = await Promise.all([
            this.options.store.readConfig(server.guildId),
            this.options.readEntitlementTier(server.guildId),
          ]);
          if (
            config?.enabled !== true ||
            config.removedAtMs !== null ||
            entitlementTier === "free" ||
            (this.options.isKillSwitchEnabled?.() ?? false)
          ) {
            return "skipped" as const;
          }

          const [cursor, presences, sessions] = await Promise.all([
            this.options.store.readProcessingCursor(server.id),
            this.options.store.listCurrentPresence(server.id),
            this.options.store.listOpenEarningSessions(server.id),
          ]);
          const roster = new Set(input.steamIds);
          const lifecycleGeneration = cursor?.lifecycleGeneration ?? 0;
          const presenceBySteamId = new Map(
            presences.map((presence) => [presence.steamId64, presence]),
          );
          const sessionBySteamId = new Map(sessions.map((session) => [session.steamId64, session]));

          for (const session of sessions) {
            if (roster.has(session.steamId64)) {
              await this.options.store.upsertEarningSession({
                ...session,
                lastConfirmedAtMs: input.observedAtMs,
                checkpointAtMs: input.observedAtMs,
                updatedAtMs: startedAtMs,
              });
            } else {
              await this.options.store.closeEarningSession(
                session.sessionId,
                session.checkpointAtMs,
                "data_api_roster_absent",
              );
            }
          }

          for (const steamId64 of input.steamIds) {
            const existing = presenceBySteamId.get(steamId64);
            const presence: ServerLevelPresence = {
              configuredGameServerId: server.id,
              steamId64,
              lifecycleGeneration,
              joinedAtMs: existing?.joinedAtMs ?? input.observedAtMs,
              lastConfirmedAtMs: input.observedAtMs,
              updatedAtMs: startedAtMs,
            };
            await this.options.store.upsertCurrentPresence(presence);
            if (!sessionBySteamId.has(steamId64)) {
              await this.openSessionFromPresence(server, presence, input.observedAtMs, startedAtMs);
            }
          }
          for (const presence of presences) {
            if (!roster.has(presence.steamId64)) {
              await this.options.store.deleteCurrentPresence(
                server.guildId,
                server.id,
                presence.steamId64,
              );
            }
          }

          await this.options.store.upsertProcessingCursor(
            cursor
              ? {
                  ...cursor,
                  population: input.population,
                  queueSize: input.queueSize,
                  updatedAtMs: startedAtMs,
                }
              : {
                  configuredGameServerId: server.id,
                  latestSeenAtMs: 0,
                  watermarkAtMs: 0,
                  lastDeliveryId: "",
                  population: input.population,
                  queueSize: input.queueSize,
                  lifecycleGeneration,
                  updatedAtMs: startedAtMs,
                },
          );
          await this.options.store.recordReconciliationState(server.guildId, server.id, {
            rosterAtMs: input.observedAtMs,
            ...(input.checkCapacity
              ? {
                  capacityCheckedAtMs: input.observedAtMs,
                  capacityProposal:
                    input.maxSlots === server.maxSlots
                      ? null
                      : { maxSlots: input.maxSlots, observedAtMs: input.observedAtMs },
                }
              : {}),
          });
          return "completed" as const;
        },
      );
      emitServerLevelTelemetry(this.options.emitTelemetry, {
        category: "reconciliation",
        outcome,
        durationMs: (this.options.now?.() ?? Date.now()) - startedAtMs,
        count: outcome === "completed" ? input.steamIds.length : 0,
        ...(outcome === "skipped" ? { reasonCode: "not_eligible_or_busy" } : {}),
      });
      return outcome;
    } catch (error) {
      emitServerLevelTelemetry(this.options.emitTelemetry, {
        category: "reconciliation",
        outcome: "failed",
        durationMs: (this.options.now?.() ?? Date.now()) - startedAtMs,
        count: 0,
        reasonCode: "invalid_or_unavailable_snapshot",
      });
      throw error;
    }
  }

  private async checkpointAvailableForServerWithLease(
    configuredGameServerId: string,
    now: number,
  ): Promise<void> {
    const safeAtMs = now - SERVER_LEVEL_ORDERING_WINDOW_MS;
    const cursor = await this.options.store.readProcessingCursor(configuredGameServerId);
    if (!cursor || safeAtMs <= cursor.watermarkAtMs) return;
    const earliestPending =
      await this.options.store.readEarliestAcceptedProviderEvent(configuredGameServerId);
    const checkpointAtMs =
      earliestPending && earliestPending.occurredAtMs <= safeAtMs
        ? earliestPending.occurredAtMs
        : safeAtMs;
    if (checkpointAtMs <= cursor.watermarkAtMs) return;
    const checkpointDeliveryId =
      earliestPending?.occurredAtMs === checkpointAtMs ? "" : "\uffffcheckpoint";
    const server = await this.options.store.readConfiguredGameServerById(configuredGameServerId);
    if (!server) return;
    const [config, entitlementTier] = await Promise.all([
      this.options.store.readConfig(server.guildId),
      this.options.readEntitlementTier(server.guildId),
    ]);
    const killSwitchEnabled = this.options.isKillSwitchEnabled?.() ?? false;
    const awardingEnabled =
      config?.enabled === true &&
      config.removedAtMs === null &&
      entitlementTier !== "free" &&
      !killSwitchEnabled;
    if (awardingEnabled) {
      await this.reconcileLinkedPresence(server, cursor.lifecycleGeneration, checkpointAtMs, now);
      await this.checkpointOpenSessions(server, cursor, {
        inboxId: `checkpoint:${configuredGameServerId}:${checkpointAtMs}`,
        deliveryId: checkpointDeliveryId,
        configuredGameServerId,
        guildId: server.guildId,
        eventType: "player.join",
        occurredAtMs: checkpointAtMs,
        steamId64: null,
        population: cursor.population,
        queueSize: cursor.queueSize,
        receivedAtMs: now,
      });
    } else {
      await this.options.store.closeAllEarningSessions(
        configuredGameServerId,
        checkpointAtMs,
        entitlementTier === "free"
          ? "entitlement_dormant"
          : killSwitchEnabled
            ? "kill_switch"
            : "feature_disabled",
      );
      await this.options.store.clearCurrentPresence(server.guildId, configuredGameServerId);
    }
    await this.options.store.upsertProcessingCursor({
      ...cursor,
      latestSeenAtMs: Math.max(cursor.latestSeenAtMs, checkpointAtMs),
      watermarkAtMs: checkpointAtMs,
      lastDeliveryId: checkpointDeliveryId,
      updatedAtMs: now,
    });
  }

  private async withProcessingLease<T>(
    configuredGameServerId: string,
    skipped: T,
    task: () => Promise<T>,
  ): Promise<T> {
    const leaseId = this.options.createId?.() ?? crypto.randomUUID();
    const now = this.options.now?.() ?? Date.now();
    if (
      !(await this.options.store.acquireProcessingLease(
        configuredGameServerId,
        leaseId,
        now,
        now + SERVER_LEVEL_PROCESSING_LEASE_MS,
      ))
    ) {
      return skipped;
    }
    try {
      return await task();
    } finally {
      await this.options.store.releaseProcessingLease(configuredGameServerId, leaseId);
    }
  }

  private async withRequiredProcessingLease<T>(key: string, task: () => Promise<T>): Promise<T> {
    const busy = Symbol("busy");
    const result = await this.withProcessingLease<T | typeof busy>(key, busy, task);
    if (result === busy) throw new Error("Server Levels processing lease is busy.");
    return result;
  }

  private async checkpointSessions(input: {
    server: ConfiguredGameServer;
    sessions: ServerLevelEarningSession[];
    stoppedAtMs: number;
    /** Omit to checkpoint without ending earning before a replacement commits. */
    closeReason?: string;
    sourceId: string;
    verifyCurrentMembership: boolean;
    linkSnapshot?: PlatformLink;
  }): Promise<void> {
    const [cursor, config, entitlementTier] = await Promise.all([
      this.options.store.readProcessingCursor(input.server.id),
      this.options.store.readConfig(input.server.guildId),
      this.options.readEntitlementTier(input.server.guildId),
    ]);
    const multiplier =
      cursor?.population === null || cursor?.population === undefined || cursor.queueSize === null
        ? null
        : resolveOccupancyMultiplier({
            population: cursor.population,
            maxSlots: input.server.maxSlots,
            queueSize: cursor.queueSize,
          });
    const globallyEligible =
      config?.enabled === true &&
      config.removedAtMs === null &&
      entitlementTier !== "free" &&
      !(this.options.isKillSwitchEnabled?.() ?? false);

    for (const session of input.sessions) {
      const checkpointAtMs = Math.max(
        session.checkpointAtMs,
        Math.min(
          input.stoppedAtMs,
          session.lastConfirmedAtMs + SERVER_LEVEL_MAX_CONTINUOUS_SECONDS * 1_000,
        ),
      );
      if (globallyEligible && multiplier && checkpointAtMs > session.checkpointAtMs) {
        const snapshot = input.linkSnapshot;
        const removedLink =
          snapshot?.guildId === session.guildId &&
          snapshot.userId === session.userId &&
          snapshot.platform === "steam" &&
          snapshot.platformId === session.steamId64
            ? snapshot
            : null;
        const [link, currentMember] = await Promise.all([
          removedLink ??
            this.options.platformLinks.readPlatformLinkByPlatformId(
              session.guildId,
              "steam",
              session.steamId64,
            ),
          input.verifyCurrentMembership
            ? this.options.isCurrentGuildMember(session.guildId, session.userId)
            : Promise.resolve(true),
        ]);
        if (link?.active && link.userId === session.userId && currentMember) {
          await this.awardInterval(session, input.sourceId, checkpointAtMs, multiplier);
        }
      }
      if (input.closeReason !== undefined) {
        await this.options.store.closeEarningSession(
          session.sessionId,
          checkpointAtMs,
          input.closeReason,
        );
      } else {
        await this.options.store.upsertEarningSession({
          ...session,
          checkpointAtMs,
          updatedAtMs: input.stoppedAtMs,
        });
      }
    }
  }

  private async processEvent(
    event: ServerLevelProviderEvent,
    now: number,
  ): Promise<keyof ServerLevelProcessingSummary> {
    const server = await this.options.store.readConfiguredGameServer(
      event.guildId,
      event.configuredGameServerId,
    );
    if (!server) {
      await this.options.store.markProviderEventProcessed(
        event.inboxId,
        "rejected",
        "configured_game_server_missing",
        now,
      );
      return "rejected";
    }
    let cursor = await this.options.store.readProcessingCursor(server.id);
    if (event.occurredAtMs < event.receivedAtMs - SERVER_LEVEL_ORDERING_WINDOW_MS) {
      await this.options.store.markProviderEventProcessed(
        event.inboxId,
        "late",
        "outside_ordering_window",
        now,
      );
      return "late";
    }
    if (cursor && compareEvent(event, cursor) <= 0) {
      await this.options.store.markProviderEventProcessed(
        event.inboxId,
        "late",
        "ordering_watermark_passed",
        now,
      );
      return "late";
    }
    if (!validPopulationFact(event, server)) {
      await this.options.store.closeAllEarningSessions(
        server.id,
        event.occurredAtMs,
        "uncertain_provider_fact",
      );
      await this.options.store.markProviderEventProcessed(
        event.inboxId,
        "rejected",
        "invalid_population_fact",
        now,
      );
      await this.options.store.upsertProcessingCursor(
        nextCursor(cursor, event, null, null, cursor?.lifecycleGeneration ?? 0, now),
      );
      return "rejected";
    }

    const [config, entitlementTier] = await Promise.all([
      this.options.store.readConfig(event.guildId),
      this.options.readEntitlementTier(event.guildId),
    ]);
    const awardingEnabled =
      config?.enabled === true &&
      config.removedAtMs === null &&
      entitlementTier !== "free" &&
      !(this.options.isKillSwitchEnabled?.() ?? false);

    if (awardingEnabled && cursor) {
      await this.reconcileLinkedPresence(
        server,
        cursor.lifecycleGeneration,
        event.occurredAtMs,
        now,
      );
      await this.checkpointOpenSessions(server, cursor, event);
    } else if (!awardingEnabled) {
      await this.options.store.closeAllEarningSessions(
        server.id,
        event.occurredAtMs,
        entitlementTier === "free"
          ? "entitlement_dormant"
          : this.options.isKillSwitchEnabled?.()
            ? "kill_switch"
            : "feature_disabled",
      );
      await this.options.store.clearCurrentPresence(server.guildId, server.id);
    }

    let lifecycleGeneration = cursor?.lifecycleGeneration ?? 0;
    if (awardingEnabled) {
      if (event.eventType === "player.join") {
        if (event.steamId64) {
          const existingPresence = await this.options.store.readCurrentPresence(
            server.id,
            event.steamId64,
          );
          const presence: ServerLevelPresence = {
            configuredGameServerId: server.id,
            steamId64: event.steamId64,
            lifecycleGeneration,
            joinedAtMs: existingPresence?.joinedAtMs ?? event.occurredAtMs,
            lastConfirmedAtMs: event.occurredAtMs,
            updatedAtMs: now,
          };
          await this.options.store.upsertCurrentPresence(presence);
          await this.openSessionFromPresence(server, presence, event.occurredAtMs, now);
        }
      } else if (event.eventType === "player.leave" && event.steamId64) {
        const open = await this.options.store.readOpenEarningSession(server.id, event.steamId64);
        if (open) {
          await this.options.store.closeEarningSession(
            open.sessionId,
            event.occurredAtMs,
            "trusted_leave",
          );
        }
        await this.options.store.deleteCurrentPresence(server.guildId, server.id, event.steamId64);
      } else if (event.eventType === "server.restart" || event.eventType === "server.shutdown") {
        lifecycleGeneration += 1;
        await this.options.store.closeAllEarningSessions(
          server.id,
          event.occurredAtMs,
          event.eventType,
        );
        await this.options.store.clearCurrentPresence(server.guildId, server.id);
      }
    } else if (event.eventType === "server.restart" || event.eventType === "server.shutdown") {
      lifecycleGeneration += 1;
    }

    cursor = nextCursor(
      cursor,
      event,
      event.eventType.startsWith("server.") ? 0 : event.population,
      event.eventType.startsWith("server.") ? 0 : event.queueSize,
      lifecycleGeneration,
      now,
    );
    await this.options.store.upsertProcessingCursor(cursor);
    await this.options.store.markProviderEventProcessed(event.inboxId, "processed", null, now);
    return "processed";
  }

  private async checkpointOpenSessions(
    server: ConfiguredGameServer,
    cursor: ServerLevelProcessingCursor,
    event: ServerLevelProviderEvent,
  ): Promise<void> {
    const multiplier =
      cursor.population === null || cursor.queueSize === null
        ? null
        : resolveOccupancyMultiplier({
            population: cursor.population,
            maxSlots: server.maxSlots,
            queueSize: cursor.queueSize,
          });
    const sessions = await this.options.store.listOpenEarningSessions(server.id);
    for (const session of sessions) {
      const staleAtMs = session.lastConfirmedAtMs + SERVER_LEVEL_MAX_CONTINUOUS_SECONDS * 1_000;
      const checkpointAtMs = Math.min(event.occurredAtMs, staleAtMs);
      const link = await this.options.platformLinks.readPlatformLinkByPlatformId(
        session.guildId,
        "steam",
        session.steamId64,
      );
      const eligible =
        Boolean(link?.active && link.userId === session.userId) &&
        (await this.options.isCurrentGuildMember(session.guildId, session.userId));
      if (eligible && multiplier && checkpointAtMs > session.checkpointAtMs) {
        await this.awardInterval(session, event.inboxId, checkpointAtMs, multiplier);
      }
      await this.options.store.upsertEarningSession({
        ...session,
        checkpointAtMs,
        updatedAtMs: event.occurredAtMs,
      });
      if (!eligible || staleAtMs <= event.occurredAtMs) {
        await this.options.store.closeEarningSession(
          session.sessionId,
          checkpointAtMs,
          eligible ? "stale_session_limit" : "identity_or_membership_ineligible",
        );
        if (staleAtMs <= event.occurredAtMs) {
          await this.options.store.deleteCurrentPresence(
            server.guildId,
            server.id,
            session.steamId64,
          );
        }
      }
    }
  }

  private async reconcileLinkedPresence(
    server: ConfiguredGameServer,
    lifecycleGeneration: number,
    atMs: number,
    now: number,
  ): Promise<void> {
    const presences = await this.options.store.listCurrentPresence(server.id);
    for (const presence of presences) {
      if (presence.lifecycleGeneration !== lifecycleGeneration) continue;
      await this.openSessionFromPresence(server, presence, atMs, now);
    }
  }

  private async openSessionFromPresence(
    server: ConfiguredGameServer,
    presence: ServerLevelPresence,
    atMs: number,
    now: number,
  ): Promise<void> {
    const existing = await this.options.store.readOpenEarningSession(server.id, presence.steamId64);
    if (existing) {
      if (presence.lastConfirmedAtMs > existing.lastConfirmedAtMs) {
        await this.options.store.upsertEarningSession({
          ...existing,
          lastConfirmedAtMs: presence.lastConfirmedAtMs,
          updatedAtMs: now,
        });
      }
      return;
    }
    const link = await this.options.platformLinks.readPlatformLinkByPlatformId(
      server.guildId,
      "steam",
      presence.steamId64,
    );
    const startedAtMs = Math.max(presence.joinedAtMs, link?.linkedAtMs ?? Number.MAX_SAFE_INTEGER);
    if (
      !link?.active ||
      startedAtMs > atMs ||
      !(await this.options.isCurrentGuildMember(server.guildId, link.userId))
    ) {
      return;
    }
    await this.options.store.setCurrentMembership(server.guildId, link.userId, true, now);
    await this.options.store.upsertEarningSession({
      sessionId: this.options.createId?.() ?? crypto.randomUUID(),
      guildId: server.guildId,
      configuredGameServerId: server.id,
      steamId64: presence.steamId64,
      userId: link.userId,
      lifecycleGeneration: presence.lifecycleGeneration,
      startedAtMs,
      lastConfirmedAtMs: presence.lastConfirmedAtMs,
      checkpointAtMs: startedAtMs,
      closedAtMs: null,
      closeReason: null,
      createdAtMs: now,
      updatedAtMs: now,
    });
  }

  private async awardInterval(
    session: ServerLevelEarningSession,
    sourceInboxId: string,
    endedAtMs: number,
    multiplier: ServerLevelMultiplier,
  ): Promise<void> {
    const memberKey = await memberAwardLeaseKey(session.guildId, session.userId);
    await this.withRequiredProcessingLease(memberKey, () =>
      this.awardIntervalWithLease(session, sourceInboxId, endedAtMs, multiplier),
    );
  }

  private async awardIntervalWithLease(
    session: ServerLevelEarningSession,
    sourceInboxId: string,
    endedAtMs: number,
    multiplier: ServerLevelMultiplier,
  ): Promise<void> {
    const startedAtMs = session.checkpointAtMs;
    const durationSeconds = Math.floor((endedAtMs - startedAtMs) / 1_000);
    if (durationSeconds <= 0) return;
    const awards = await this.options.store.listMemberAwards(
      session.guildId,
      session.userId,
      endedAtMs,
      startedAtMs - SERVER_LEVEL_ROLLING_WINDOW_SECONDS * 1_000,
    );
    const segments = buildAwardSegments(startedAtMs, endedAtMs, multiplier, awards);
    let previousTotalXpUnits: number | null = null;
    let totalXpUnits: number | null = null;
    for (const segment of segments) {
      if (segment.xpUnits <= 0) continue;
      const applied = await this.options.store.appendAward({
        awardId: awardId(sourceInboxId, session.sessionId, segment),
        guildId: session.guildId,
        userId: session.userId,
        configuredGameServerId: session.configuredGameServerId,
        sourceInboxId,
        kind: segment.kind,
        intervalStartedAtMs: segment.startedAtMs,
        intervalEndedAtMs: segment.endedAtMs,
        qualifyingSeconds: segment.qualifyingSeconds,
        multiplier: segment.multiplier,
        xpUnits: segment.xpUnits,
        scoringPolicyVersion: SERVER_LEVEL_SCORING_POLICY_VERSION,
        actorUserId: null,
        reason: null,
        createdAtMs: endedAtMs,
      });
      if (applied.applied) {
        const expectedTotal = Math.max(0, applied.previousTotalXpUnits + segment.xpUnits);
        emitServerLevelTelemetry(this.options.emitTelemetry, {
          category: "xp_transaction",
          outcome: applied.totalXpUnits === expectedTotal ? "committed" : "projection_drift",
          durationMs: 0,
          xpUnits: segment.xpUnits,
          scoringPolicyVersion: SERVER_LEVEL_SCORING_POLICY_VERSION,
        });
        previousTotalXpUnits ??= applied.previousTotalXpUnits;
        totalXpUnits = applied.totalXpUnits;
      }
    }
    if (previousTotalXpUnits !== null && totalXpUnits !== null) {
      const previousLevel = calculateServerLevel(previousTotalXpUnits);
      const level = calculateServerLevel(totalXpUnits);
      if (level > previousLevel) {
        const config = await this.options.store.readConfig(session.guildId);
        if (config?.announcementChannelId) {
          await this.options.store.enqueueLevelAnnouncement({
            announcementId: `server-level:${session.guildId}:${session.userId}:${level}`,
            guildId: session.guildId,
            userId: session.userId,
            channelId: config.announcementChannelId,
            level,
            createdAtMs: endedAtMs,
          });
        }
      }
    }
  }
}

function validateRosterObservation(input: ServerLevelRosterReconciliationInput): void {
  if (
    !Number.isSafeInteger(input.population) ||
    input.population < 0 ||
    !Number.isSafeInteger(input.queueSize) ||
    input.queueSize < 0 ||
    !Number.isSafeInteger(input.maxSlots) ||
    input.maxSlots < 1 ||
    input.maxSlots > 10_000 ||
    !Number.isSafeInteger(input.observedAtMs) ||
    input.observedAtMs < 0
  ) {
    throw new Error("CFTools roster observation is invalid.");
  }
  if (
    input.steamIds.length !== input.population ||
    new Set(input.steamIds).size !== input.steamIds.length ||
    !input.steamIds.every((steamId64) => /^\d{17}$/.test(steamId64))
  ) {
    throw new Error("CFTools roster observation is inconsistent.");
  }
}

interface AwardSegment {
  kind: "interval" | "overlap_delta";
  startedAtMs: number;
  endedAtMs: number;
  qualifyingSeconds: number;
  multiplier: ServerLevelMultiplier;
  xpUnits: number;
}

export function buildAwardSegments(
  startedAtMs: number,
  endedAtMs: number,
  multiplier: ServerLevelMultiplier,
  existingAwards: ServerLevelAward[],
): AwardSegment[] {
  const intervals = existingAwards.filter(
    (award) =>
      award.intervalStartedAtMs !== null &&
      award.intervalEndedAtMs !== null &&
      award.multiplier !== null &&
      (award.kind === "interval" || award.kind === "overlap_delta"),
  );
  const qualifyingIntervals = intervals.filter((award) => award.kind === "interval");
  const rollingWindowMs = SERVER_LEVEL_ROLLING_WINDOW_SECONDS * 1_000;
  const boundaries = new Set([startedAtMs, endedAtMs]);
  for (const award of intervals) {
    boundaries.add(Math.max(startedAtMs, award.intervalStartedAtMs!));
    boundaries.add(Math.min(endedAtMs, award.intervalEndedAtMs!));
  }
  for (const award of qualifyingIntervals) {
    boundaries.add(award.intervalStartedAtMs! + rollingWindowMs);
    boundaries.add(award.intervalEndedAtMs! + rollingWindowMs);
  }
  const ordered = [...boundaries]
    .filter((value) => value >= startedAtMs && value <= endedAtMs)
    .sort((a, b) => a - b);
  const result: AwardSegment[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const segmentStart = ordered[index]!;
    const segmentEnd = ordered[index + 1]!;
    const seconds = Math.floor((segmentEnd - segmentStart) / 1_000);
    if (seconds <= 0) continue;
    const existingMultiplier = intervals.reduce((highest, award) => {
      if (award.intervalStartedAtMs! < segmentEnd && award.intervalEndedAtMs! > segmentStart) {
        return Math.max(highest, award.multiplier!);
      }
      return highest;
    }, 0);
    if (existingMultiplier >= multiplier) continue;
    if (existingMultiplier > 0) {
      result.push({
        kind: "overlap_delta",
        startedAtMs: segmentStart,
        endedAtMs: segmentStart + seconds * 1_000,
        qualifyingSeconds: 0,
        multiplier,
        xpUnits: seconds * (multiplier - existingMultiplier),
      });
      continue;
    }
    const windowStartedAtMs = segmentStart - rollingWindowMs;
    const coverage = [
      ...qualifyingIntervals.map(
        (award) => [award.intervalStartedAtMs!, award.intervalEndedAtMs!] as const,
      ),
      ...result
        .filter((segment) => segment.kind === "interval")
        .map((segment) => [segment.startedAtMs, segment.endedAtMs] as const),
    ];
    const usedQualifyingSeconds = mergedCoverageSeconds(
      coverage.map(
        ([start, end]) =>
          [Math.max(start, windowStartedAtMs), Math.min(end, segmentStart)] as const,
      ),
    );
    const expirationReleasesCapacity = coverage.some(
      ([start, end]) => start <= windowStartedAtMs && end > windowStartedAtMs,
    );
    const overCapSeconds = Math.max(0, usedQualifyingSeconds - SERVER_LEVEL_ROLLING_CAP_SECONDS);
    const skippedSeconds = expirationReleasesCapacity ? Math.min(seconds, overCapSeconds) : 0;
    const availableSeconds = Math.max(0, SERVER_LEVEL_ROLLING_CAP_SECONDS - usedQualifyingSeconds);
    const qualifyingSeconds = expirationReleasesCapacity
      ? seconds - skippedSeconds
      : Math.min(seconds, availableSeconds);
    if (qualifyingSeconds <= 0) continue;
    const qualifyingStartedAtMs = segmentStart + skippedSeconds * 1_000;
    result.push({
      kind: "interval",
      startedAtMs: qualifyingStartedAtMs,
      endedAtMs: qualifyingStartedAtMs + qualifyingSeconds * 1_000,
      qualifyingSeconds,
      multiplier,
      xpUnits: calculateServerXpUnits(qualifyingSeconds, multiplier),
    });
  }
  return result;
}

function mergedCoverageSeconds(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .map(([start, end]) => [start, end] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  let totalMs = 0;
  let current: [number, number] | null = null;
  for (const interval of sorted) {
    if (!current) current = interval;
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else {
      totalMs += current[1] - current[0];
      current = interval;
    }
  }
  if (current) totalMs += current[1] - current[0];
  return Math.floor(totalMs / 1_000);
}

function validPopulationFact(
  event: ServerLevelProviderEvent,
  server: ConfiguredGameServer,
): boolean {
  if (event.eventType === "server.restart" || event.eventType === "server.shutdown") return true;
  return (
    event.population !== null &&
    event.queueSize !== null &&
    event.population >= 0 &&
    event.queueSize >= 0 &&
    server.maxSlots > 0
  );
}

function compareEvent(
  event: ServerLevelProviderEvent,
  cursor: ServerLevelProcessingCursor,
): number {
  if (event.occurredAtMs !== cursor.watermarkAtMs) {
    return event.occurredAtMs - cursor.watermarkAtMs;
  }
  return event.deliveryId.localeCompare(cursor.lastDeliveryId);
}

function nextCursor(
  current: ServerLevelProcessingCursor | null,
  event: ServerLevelProviderEvent,
  population: number | null,
  queueSize: number | null,
  lifecycleGeneration: number,
  updatedAtMs: number,
): ServerLevelProcessingCursor {
  return {
    configuredGameServerId: event.configuredGameServerId,
    latestSeenAtMs: Math.max(current?.latestSeenAtMs ?? event.occurredAtMs, event.occurredAtMs),
    watermarkAtMs: event.occurredAtMs,
    lastDeliveryId: event.deliveryId,
    population,
    queueSize,
    lifecycleGeneration,
    updatedAtMs,
  };
}

function awardId(sourceInboxId: string, sessionId: string, segment: AwardSegment): string {
  return [
    "server-xp",
    sourceInboxId,
    sessionId,
    segment.kind,
    segment.startedAtMs,
    segment.endedAtMs,
    segment.multiplier,
  ].join(":");
}

async function memberAwardLeaseKey(guildId: string, userId: string): Promise<string> {
  const input = new TextEncoder().encode(`${guildId}:${userId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `member:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
