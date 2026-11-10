import { createObservationStore, type ObservationStore } from "../server-levels/observations/store";
import { AttendanceObservationService } from "../server-levels/observations/service";
import { createWardogsObservationProvider } from "../server-levels/observations/provider";
import { createPlatformLinkIdentityReader } from "../services/platform-link-identity-reader";
import type { WardogsService } from "../wardogs/service";
import type { RuntimeStores } from "./app-types";
import { GuildServicePolicy } from "./guild-service-policy";
import { getGuildEntitlementLimits } from "../types";
import { fetchGuildMember } from "../discord";
import type { PostgresDatabaseCapability } from "./postgres/postgres-capability";
export function createCloudflareObservationStore(db: D1Database) {
  return createObservationStore({
    async rows(sql, values) {
      return (
        await db
          .prepare(sql)
          .bind(...values)
          .all<{ data: string; duplicates?: number; late?: number }>()
      ).results;
    },
    async batch(statements) {
      const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.values)));
      return results.map((result) => result.meta.changes);
    },
  });
}
export function createPostgresObservationStore(db: PostgresDatabaseCapability) {
  const bind = (sql: string) => {
    let index = 0;
    return sql.replaceAll("?", () => `$${++index}`);
  };
  return createObservationStore({
    rows: (sql, values) =>
      db.query<{ data: string; duplicates?: number; late?: number }>(bind(sql), values),
    batch: (statements, fence) =>
      db.transaction(async (tx) => {
        // A transaction alone does not fence target changes between its two statements.
        // Hold the run and source generation through the sample + aggregate commit.
        if (fence) {
          const locked = await tx.query<{ id: string }>(
            `SELECT r.id FROM attendance_observation_runs r JOIN wardogs_targets t
             ON t.id=r.target_id AND t.guild_id=r.guild_id AND t.generation=r.generation
             WHERE r.id=$1 AND r.guild_id=$2 AND r.target_id=$3 AND r.generation=$4
             FOR UPDATE OF r FOR SHARE OF t`,
            [fence.runId, fence.guildId, fence.targetId, fence.generation],
          );
          if (!locked.length) return [];
        }
        const changes: number[] = [];
        for (const s of statements) changes.push(await tx.execute(bind(s.sql), s.values));
        return changes;
      }),
  });
}
export function createAttendanceObservationRuntime(input: {
  store: ObservationStore;
  wardogs: WardogsService;
  stores: RuntimeStores;
  enabled: boolean;
  steamEnabled: boolean;
  processingAvailable: boolean;
  botToken: string;
  botUserId: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}) {
  return {
    store: input.store,
    service: new AttendanceObservationService({
      store: input.store,
      now: input.now,
      wait: input.wait,
      provider: createWardogsObservationProvider(input.wardogs),
      identities: createPlatformLinkIdentityReader(input.stores.platformLink),
      async eligible(guildId) {
        if (
          !input.enabled ||
          !input.steamEnabled ||
          !input.processingAvailable ||
          !input.stores.serverLevels
        )
          return false;
        if (
          await new GuildServicePolicy(input.stores.guildServiceSuspensions).isGuildSuspended(
            guildId,
          )
        )
          return false;
        const config = await input.stores.serverLevels.readConfig(guildId);
        if (config?.removedAtMs || (config && !config.enabled)) return false;
        const entitlement = await input.stores.guildEntitlements.readGuildEntitlement(guildId);
        if (!getGuildEntitlementLimits(entitlement?.tier ?? "free").paidFeatures) return false;
        if (!(await input.stores.platformLink.readPlatformLinkConfig(guildId, "steam")))
          return false;
        return Boolean(await fetchGuildMember(guildId, input.botUserId, input.botToken));
      },
      async owner(guildId, steamId) {
        return (
          (await input.stores.platformLink.readPlatformLinkByPlatformId(guildId, "steam", steamId))
            ?.userId ?? null
        );
      },
      async member(guildId, userId) {
        return Boolean(await fetchGuildMember(guildId, userId, input.botToken));
      },
    }),
  };
}
