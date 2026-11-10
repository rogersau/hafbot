import type {
  PostgresDatabaseCapability,
  PostgresExecutor,
} from "../runtime/postgres/postgres-capability";
import {
  CommunityToolsError,
  contentFeedSchema,
  parseCommunityConfig,
  type CommunityConfig,
  type CommunityFeature,
  type ConfigSnapshot,
  type ContentFeed,
  type ModerationCase,
} from "./config";

export interface CommunityDelivery {
  id: string;
  guildId: string;
  feature: CommunityFeature;
  itemId: string;
  channelId: string;
  content: string;
  roleIds: string[];
  createdAtMs: number;
  configRevision: number;
}
export class CommunityToolsStore {
  constructor(
    readonly database: PostgresDatabaseCapability,
    private readonly now: () => number = Date.now,
  ) {}
  async read(guildId: string, feature: CommunityFeature): Promise<ConfigSnapshot> {
    const [row] = await this.database.query<{ config_json: string; revision: number }>(
      "SELECT config_json,revision FROM community_tool_configs WHERE guild_id=$1 AND feature=$2",
      [guildId, feature],
    );
    return {
      config: parseCommunityConfig(feature, row ? JSON.parse(row.config_json) : {}),
      revision: row?.revision ?? 0,
    };
  }
  async save(
    guildId: string,
    feature: CommunityFeature,
    config: CommunityConfig,
    revision: number,
  ): Promise<ConfigSnapshot> {
    const rows = await this.database.query<{ revision: number }>(
      `INSERT INTO community_tool_configs(guild_id,feature,config_json,revision,updated_at_ms)
      SELECT $1,$2,$3,1,$4 WHERE $5=0 OR EXISTS (SELECT 1 FROM community_tool_configs WHERE guild_id=$1 AND feature=$2)
      ON CONFLICT(guild_id,feature) DO UPDATE SET config_json=EXCLUDED.config_json,revision=community_tool_configs.revision+1,updated_at_ms=EXCLUDED.updated_at_ms
      WHERE community_tool_configs.revision=$5 RETURNING revision`,
      [guildId, feature, JSON.stringify(config), this.now(), revision],
    );
    if (!rows[0])
      throw new CommunityToolsError(
        "These settings changed. Refresh the page before saving again.",
        409,
      );
    return { config, revision: rows[0].revision };
  }
  async enabled(
    feature: CommunityFeature,
  ): Promise<
    Array<{ guildId: string; config: CommunityConfig; revision: number; updatedAtMs: number }>
  > {
    const rows = await this.database.query<{
      guild_id: string;
      config_json: string;
      revision: number;
      updated_at_ms: string;
    }>(
      "SELECT guild_id,config_json,revision,updated_at_ms FROM community_tool_configs WHERE feature=$1",
      [feature],
    );
    return rows.flatMap((row) => {
      const config = parseCommunityConfig(feature, JSON.parse(row.config_json));
      return config.enabled
        ? [
            {
              guildId: row.guild_id,
              config,
              revision: row.revision,
              updatedAtMs: Number(row.updated_at_ms),
            },
          ]
        : [];
    });
  }
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    return claim(this.database, key, expiresAtMs, nowMs);
  }
  async dueFeeds(
    nowMs: number,
    limit = 10,
  ): Promise<Array<{ guildId: string; revision: number; feed: ContentFeed }>> {
    const rows = await this.database.query<{
      guild_id: string;
      revision: number;
      feed_json: string;
    }>(
      `SELECT c.guild_id,c.revision,item.value::text AS feed_json
       FROM community_tool_configs c
       CROSS JOIN LATERAL jsonb_array_elements(c.config_json::jsonb->'feeds') item
       LEFT JOIN community_feed_state s ON s.guild_id=c.guild_id AND s.feed_id=item.value->>'id'
       WHERE c.feature='feeds' AND c.config_json::jsonb->>'enabled'='true'
         AND item.value->>'enabled'='true' AND COALESCE(s.checked_at_ms,0)<=$1
       ORDER BY COALESCE(s.checked_at_ms,0),c.guild_id,item.value->>'id' LIMIT $2`,
      [nowMs - 5 * 60000, limit],
    );
    return rows.map((row) => ({
      guildId: row.guild_id,
      revision: row.revision,
      feed: contentFeedSchema.parse(JSON.parse(row.feed_json)),
    }));
  }
  async recordCase(
    input: ModerationCase & { ruleId?: string; windowSeconds?: number },
  ): Promise<{ fresh: boolean; count: number }> {
    return this.database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${input.guildId}:${input.userId}`,
      ]);
      const inserted = await tx.execute(
        `INSERT INTO community_moderation_cases(id,guild_id,user_id,actor_user_id,action,reason,rule_id,created_at_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.guildId,
          input.userId,
          input.actorUserId,
          input.action,
          input.reason,
          input.ruleId ?? null,
          input.createdAtMs,
        ],
      );
      const [row] = await tx.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM community_moderation_cases WHERE guild_id=$1 AND user_id=$2 AND rule_id=$3 AND created_at_ms>=$4 AND created_at_ms<=$5",
        [
          input.guildId,
          input.userId,
          input.ruleId ?? null,
          input.createdAtMs - (input.windowSeconds ?? 60) * 1000,
          input.createdAtMs,
        ],
      );
      return { fresh: inserted === 1, count: Number(row?.count ?? 0) };
    });
  }
  async history(guildId: string, userId?: string): Promise<ModerationCase[]> {
    const rows = await this.database.query<{
      id: string;
      guild_id: string;
      user_id: string;
      actor_user_id: string | null;
      action: string;
      reason: string;
      created_at_ms: string;
    }>(
      "SELECT * FROM community_moderation_cases WHERE guild_id=$1 AND ($2::text IS NULL OR user_id=$2) ORDER BY created_at_ms DESC LIMIT 50",
      [guildId, userId ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      guildId: row.guild_id,
      userId: row.user_id,
      actorUserId: row.actor_user_id,
      action: row.action,
      reason: row.reason,
      createdAtMs: Number(row.created_at_ms),
    }));
  }
  async enqueue(delivery: CommunityDelivery): Promise<void> {
    await this.database.execute(
      `INSERT INTO community_tool_deliveries(id,guild_id,feature,item_id,channel_id,content,role_ids_json,created_at_ms,config_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
      [
        delivery.id,
        delivery.guildId,
        delivery.feature,
        delivery.itemId,
        delivery.channelId,
        delivery.content,
        JSON.stringify(delivery.roleIds),
        delivery.createdAtMs,
        delivery.configRevision,
      ],
    );
  }
  async deliveries(nowMs: number): Promise<Array<CommunityDelivery & { token: string }>> {
    return this.database.transaction(async (tx) => {
      await tx.execute(
        "UPDATE community_tool_deliveries SET status='failed',last_error='Delivery expired; not replayed.' WHERE status IN ('pending','sending') AND created_at_ms<$1",
        [nowMs - 4 * 60000],
      );
      const rows = await tx.query<{
        id: string;
        guild_id: string;
        feature: CommunityFeature;
        item_id: string;
        channel_id: string;
        content: string;
        role_ids_json: string;
        created_at_ms: string;
        config_revision: number;
      }>(
        "SELECT * FROM community_tool_deliveries WHERE (status='pending' OR (status='sending' AND lease_until_ms<$1)) AND attempts<3 ORDER BY created_at_ms LIMIT 20 FOR UPDATE SKIP LOCKED",
        [nowMs],
      );
      const result = [];
      for (const row of rows) {
        const token = crypto.randomUUID();
        await tx.execute(
          "UPDATE community_tool_deliveries SET status='sending',lease_token=$2,lease_until_ms=$3,attempts=attempts+1 WHERE id=$1",
          [row.id, token, nowMs + 60000],
        );
        result.push({
          id: row.id,
          guildId: row.guild_id,
          feature: row.feature,
          itemId: row.item_id,
          channelId: row.channel_id,
          content: row.content,
          roleIds: JSON.parse(row.role_ids_json) as string[],
          createdAtMs: Number(row.created_at_ms),
          configRevision: row.config_revision,
          token,
        });
      }
      return result;
    });
  }
  async finishDelivery(
    id: string,
    token: string,
    status: "delivered" | "pending" | "cancelled",
    error: string | null = null,
  ): Promise<void> {
    await this.database.execute(
      "UPDATE community_tool_deliveries SET status=$3,lease_until_ms=0,last_error=$4 WHERE id=$1 AND lease_token=$2 AND status='sending'",
      [id, token, status, error],
    );
  }
  async bindDeliveryBot(id: string, token: string, botUserId: string): Promise<boolean> {
    return (
      (await this.database.execute(
        `UPDATE community_tool_deliveries SET bot_user_id=COALESCE(bot_user_id,$3)
       WHERE id=$1 AND lease_token=$2 AND status='sending' AND lease_until_ms>$4
         AND (bot_user_id IS NULL OR bot_user_id=$3)
         AND EXISTS (SELECT 1 FROM community_tool_configs c WHERE c.guild_id=community_tool_deliveries.guild_id
           AND c.feature=community_tool_deliveries.feature AND c.revision=community_tool_deliveries.config_revision)`,
        [id, token, botUserId, this.now()],
      )) === 1
    );
  }
  async feedState(
    guildId: string,
    feedId: string,
  ): Promise<{
    fingerprint: string;
    seen: string[];
    initialized: boolean;
    checkedAtMs: number;
  } | null> {
    const [row] = await this.database.query<{
      source_fingerprint: string;
      seen_ids_json: string;
      initialized: number;
      checked_at_ms: string;
    }>("SELECT * FROM community_feed_state WHERE guild_id=$1 AND feed_id=$2", [guildId, feedId]);
    return row
      ? {
          fingerprint: row.source_fingerprint,
          seen: JSON.parse(row.seen_ids_json) as string[],
          initialized: row.initialized === 1,
          checkedAtMs: Number(row.checked_at_ms),
        }
      : null;
  }
  async saveFeedState(
    guildId: string,
    feedId: string,
    fingerprint: string,
    seen: string[],
    nowMs: number,
    error: string | null = null,
  ): Promise<void> {
    await this.database.execute(
      `INSERT INTO community_feed_state(guild_id,feed_id,source_fingerprint,seen_ids_json,initialized,checked_at_ms,last_error)
      VALUES($1,$2,$3,$4,1,$5,$6) ON CONFLICT(guild_id,feed_id) DO UPDATE SET source_fingerprint=$3,seen_ids_json=$4,initialized=1,checked_at_ms=$5,last_error=$6`,
      [guildId, feedId, fingerprint, JSON.stringify(seen.slice(0, 200)), nowMs, error],
    );
  }
  async recordFeedFailure(
    guildId: string,
    feedId: string,
    fingerprint: string,
    nowMs: number,
    reason = "The provider could not be checked. Check the source and try again later.",
  ): Promise<void> {
    await this.database.execute(
      `INSERT INTO community_feed_state(guild_id,feed_id,source_fingerprint,seen_ids_json,initialized,checked_at_ms,last_error)
       VALUES($1,$2,$3,'[]',0,$4,$5)
       ON CONFLICT(guild_id,feed_id) DO UPDATE SET checked_at_ms=$4,last_error=$5`,
      [guildId, feedId, fingerprint, nowMs, reason],
    );
  }
  async status(guildId: string) {
    const [deliveries, feeds] = await Promise.all([
      this.database.query(
        "SELECT id,feature,item_id,status,created_at_ms,last_error FROM community_tool_deliveries WHERE guild_id=$1 ORDER BY created_at_ms DESC LIMIT 30",
        [guildId],
      ),
      this.database.query(
        "SELECT feed_id,checked_at_ms,last_error FROM community_feed_state WHERE guild_id=$1",
        [guildId],
      ),
    ]);
    return { deliveries, feeds };
  }
  async prune(nowMs: number): Promise<void> {
    await this.database.execute("DELETE FROM community_tool_claims WHERE expires_at_ms<$1", [
      nowMs,
    ]);
    await this.database.execute(
      "DELETE FROM community_tool_deliveries WHERE created_at_ms<$1 AND status IN ('delivered','failed','cancelled')",
      [nowMs - 30 * 86400000],
    );
    await this.database.execute(
      "DELETE FROM community_moderation_cases WHERE created_at_ms<$1 AND action='rate-observation'",
      [nowMs - 2 * 86400000],
    );
  }
}
async function claim(
  db: PostgresExecutor,
  key: string,
  expiresAtMs: number,
  nowMs: number,
): Promise<boolean> {
  return (
    (await db.execute(
      `INSERT INTO community_tool_claims(claim_key,expires_at_ms) VALUES($1,$2)
    ON CONFLICT(claim_key) DO UPDATE SET expires_at_ms=$2 WHERE community_tool_claims.expires_at_ms<=$3`,
      [key, expiresAtMs, nowMs],
    )) === 1
  );
}
