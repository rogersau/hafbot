import {
  type ConfigurationFeatureKey,
  type ConfigurationRevision,
  type ConfigurationRevisionOperation,
  type ConfigurationRevisionSource,
  type ConfigurationRevisionStore,
  type VersionedConfigurationMutation,
} from "../configuration-revisions";
import { serializeTicketPanelStorage } from "../tickets";
import type {
  BotDefenseConfig,
  GuildAuditLogConfig,
  MemberVerificationConfig,
  MentionProtectionConfig,
  TicketPanelConfig,
  WebhookProxyConfig,
} from "../types";

interface RevisionRow {
  id: string;
  guild_id: string;
  feature: string;
  resource_key: string;
  schema_version: number;
  operation: string;
  source: string;
  actor_user_id: string | null;
  operation_id: string;
  correlation_id: string | null;
  previous_revision_id: string | null;
  restored_from_revision_id: string | null;
  snapshot_json: string;
  snapshot_hash: string;
  created_at_ms: number;
}

const cache = new WeakMap<D1Database, ConfigurationRevisionStore>();

export function createCloudflareConfigurationRevisionStore(
  database: D1Database,
): ConfigurationRevisionStore {
  const cached = cache.get(database);
  if (cached) return cached;
  const store: ConfigurationRevisionStore = {
    async readHead(input) {
      const row = await database
        .prepare(
          `SELECT r.*
           FROM configuration_revision_heads h
           JOIN configuration_revisions r ON r.id = h.current_revision_id
           WHERE h.guild_id = ? AND h.feature = ? AND h.resource_key = ?`,
        )
        .bind(input.guildId, input.feature, input.resourceKey)
        .first<RevisionRow>();
      return row ? rowToRevision(row) : null;
    },

    async commitTicketPanelMutation(input) {
      const statements: D1PreparedStatement[] = [];
      if (input.baselineRevision) statements.push(insertRevision(database, input.baselineRevision));
      statements.push(
        input.nextPanel
          ? upsertTicketPanel(database, input.nextPanel)
          : deleteTicketPanel(database, input.currentPanel!),
      );
      statements.push(insertRevision(database, input.revision));
      await database.batch(statements);
    },

    async commitVersionedMutation(input) {
      const statements: D1PreparedStatement[] = [];
      if (input.baselineRevision) statements.push(insertRevision(database, input.baselineRevision));
      statements.push(buildCurrentStateStatement(database, input));
      statements.push(insertRevision(database, input.revision));
      await database.batch(statements);
    },

    async list(input) {
      const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
      const beforeClause = input.beforeCreatedAtMs === null ? "" : "AND created_at_ms < ?";
      const bindings: unknown[] = [input.guildId, input.feature, input.resourceKey];
      if (input.beforeCreatedAtMs !== null) bindings.push(input.beforeCreatedAtMs);
      bindings.push(limit + 1);
      const result = await database
        .prepare(
          `SELECT * FROM configuration_revisions
           WHERE guild_id = ? AND feature = ? AND resource_key = ? ${beforeClause}
           ORDER BY created_at_ms DESC, id DESC
           LIMIT ?`,
        )
        .bind(...bindings)
        .all<RevisionRow>();
      const rows = result.results;
      const pageRows = rows.slice(0, limit);
      return {
        revisions: pageRows.map(rowToRevision),
        nextCursor:
          rows.length > limit ? (pageRows[pageRows.length - 1]?.created_at_ms ?? null) : null,
      };
    },

    async readById(input) {
      const row = await database
        .prepare("SELECT * FROM configuration_revisions WHERE guild_id = ? AND id = ?")
        .bind(input.guildId, input.revisionId)
        .first<RevisionRow>();
      return row ? rowToRevision(row) : null;
    },

    async listGuild(input) {
      const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
      const beforeClause = input.beforeCreatedAtMs === null ? "" : "AND created_at_ms < ?";
      const bindings: unknown[] = [input.guildId];
      if (input.beforeCreatedAtMs !== null) bindings.push(input.beforeCreatedAtMs);
      bindings.push(limit + 1);
      const result = await database
        .prepare(
          `SELECT * FROM configuration_revisions
           WHERE guild_id = ? ${beforeClause}
           ORDER BY created_at_ms DESC, id DESC
           LIMIT ?`,
        )
        .bind(...bindings)
        .all<RevisionRow>();
      const pageRows = result.results.slice(0, limit);
      return {
        revisions: pageRows.map(rowToRevision),
        nextCursor:
          result.results.length > limit
            ? (pageRows[pageRows.length - 1]?.created_at_ms ?? null)
            : null,
      };
    },

    async purgeExpired(input) {
      const cutoff = input.nowMs - input.retentionMs;
      const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
      const result = await database
        .prepare(
          `DELETE FROM configuration_revisions
           WHERE id IN (
             SELECT candidate.id
             FROM (
               SELECT id, created_at_ms,
                 ROW_NUMBER() OVER (
                   PARTITION BY guild_id, feature, resource_key
                   ORDER BY created_at_ms DESC, id DESC
                 ) AS resource_rank
               FROM configuration_revisions
             ) candidate
             WHERE candidate.created_at_ms < ?
               AND candidate.resource_rank > 20
               AND NOT EXISTS (
                 SELECT 1 FROM configuration_revision_heads h
                 WHERE h.current_revision_id = candidate.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM configuration_revisions lineage
                 WHERE lineage.restored_from_revision_id = candidate.id
               )
             ORDER BY candidate.created_at_ms ASC
             LIMIT ?
           )`,
        )
        .bind(cutoff, limit)
        .run();
      return result.meta.changes;
    },
  };
  cache.set(database, store);
  return store;
}

function insertRevision(
  database: D1Database,
  revision: ConfigurationRevision,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO configuration_revisions (
         id, guild_id, feature, resource_key, schema_version, operation, source,
         actor_user_id, operation_id, correlation_id, previous_revision_id,
         restored_from_revision_id, snapshot_json, snapshot_hash, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      revision.id,
      revision.guildId,
      revision.feature,
      revision.resourceKey,
      revision.schemaVersion,
      revision.operation,
      revision.source,
      revision.actorUserId,
      revision.operationId,
      revision.correlationId,
      revision.previousRevisionId,
      revision.restoredFromRevisionId,
      revision.snapshotJson,
      revision.snapshotHash,
      revision.createdAtMs,
    );
}

function upsertTicketPanel(database: D1Database, panel: TicketPanelConfig): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO ticket_panels (
         guild_id, panel_id, panel_name, panel_channel_id, category_channel_id,
         transcript_channel_id, panel_message_id, ticket_types_json, ticket_creation_limit,
         ticket_limit_rejection_message, enable_ticket_claiming, ai_transcript_summaries_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, panel_id) DO UPDATE SET
         panel_name = excluded.panel_name,
         panel_channel_id = excluded.panel_channel_id,
         category_channel_id = excluded.category_channel_id,
         transcript_channel_id = excluded.transcript_channel_id,
         panel_message_id = excluded.panel_message_id,
         ticket_types_json = excluded.ticket_types_json,
         ticket_creation_limit = excluded.ticket_creation_limit,
         ticket_limit_rejection_message = excluded.ticket_limit_rejection_message,
         enable_ticket_claiming = excluded.enable_ticket_claiming,
         ai_transcript_summaries_enabled = excluded.ai_transcript_summaries_enabled`,
    )
    .bind(
      panel.guildId,
      panel.panelId ?? "main",
      panel.panelName ?? "Main panel",
      panel.panelChannelId,
      panel.categoryChannelId,
      panel.transcriptChannelId,
      panel.panelMessageId,
      serializeTicketPanelStorage(panel),
      panel.ticketCreationLimit,
      panel.ticketLimitRejectionMessage,
      panel.enableTicketClaiming ? 1 : 0,
      panel.aiTranscriptSummariesEnabled ? 1 : 0,
    );
}

function deleteTicketPanel(database: D1Database, panel: TicketPanelConfig): D1PreparedStatement {
  return database
    .prepare("DELETE FROM ticket_panels WHERE guild_id = ? AND panel_id = ?")
    .bind(panel.guildId, panel.panelId ?? "main");
}

function buildCurrentStateStatement(
  database: D1Database,
  mutation: VersionedConfigurationMutation,
): D1PreparedStatement {
  switch (mutation.feature) {
    case "tickets":
      return mutation.next
        ? upsertTicketPanel(database, mutation.next)
        : deleteTicketPanel(database, mutation.current!);
    case "webhook-proxy":
      return webhookProxyStatement(database, mutation.current, mutation.next);
    case "mention-protection":
      return mentionProtectionStatement(database, mutation.current, mutation.next);
    case "bot-defense":
      return botDefenseStatement(database, mutation.current, mutation.next);
    case "member-verification":
      return memberVerificationStatement(database, mutation.current, mutation.next);
    case "guild-audit-log":
      return guildAuditLogStatement(database, mutation.current, mutation.next);
  }
}

function webhookProxyStatement(
  database: D1Database,
  current: WebhookProxyConfig | null,
  next: WebhookProxyConfig | null,
): D1PreparedStatement {
  if (!next) {
    return database
      .prepare("DELETE FROM webhook_proxy_configs WHERE guild_id = ? AND public_id = ?")
      .bind(current!.guildId, current!.publicId);
  }
  return database
    .prepare(
      `INSERT INTO webhook_proxy_configs (
        guild_id, public_id, name, enabled, destinations_json, default_destination_ids_json,
        routing_rules_json, content_replacements_json, ban_lookup_enabled,
        ban_lookup_notification_url, ban_lookup_app_ids_json, destinations_v2_json,
        ban_lookup_credential_id, credential_migrated_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, public_id) DO UPDATE SET
        name=excluded.name, enabled=excluded.enabled,
        destinations_json=excluded.destinations_json,
        default_destination_ids_json=excluded.default_destination_ids_json,
        routing_rules_json=excluded.routing_rules_json,
        content_replacements_json=excluded.content_replacements_json,
        ban_lookup_enabled=excluded.ban_lookup_enabled,
        ban_lookup_notification_url=excluded.ban_lookup_notification_url,
        ban_lookup_app_ids_json=excluded.ban_lookup_app_ids_json,
        destinations_v2_json=excluded.destinations_v2_json,
        ban_lookup_credential_id=excluded.ban_lookup_credential_id,
        credential_migrated_at_ms=excluded.credential_migrated_at_ms,
        updated_at_ms=excluded.updated_at_ms`,
    )
    .bind(
      next.guildId,
      next.publicId,
      next.name,
      next.enabled ? 1 : 0,
      JSON.stringify(next.destinations),
      JSON.stringify(next.defaultDestinationIds),
      JSON.stringify(next.routingRules),
      JSON.stringify(next.contentReplacements ?? []),
      next.banLookupEnabled ? 1 : 0,
      next.banLookupNotificationUrl,
      JSON.stringify(next.banLookupAppIds),
      next.destinationsV2 ? JSON.stringify(next.destinationsV2) : null,
      next.banLookupCredentialId ?? null,
      next.credentialMigratedAtMs ?? null,
      next.createdAtMs,
      next.updatedAtMs,
    );
}

function mentionProtectionStatement(
  database: D1Database,
  current: MentionProtectionConfig | null,
  next: MentionProtectionConfig | null,
): D1PreparedStatement {
  if (!next) {
    return database
      .prepare("DELETE FROM mention_protection_configs WHERE guild_id = ?")
      .bind(current!.guildId);
  }
  return database
    .prepare(
      `INSERT INTO mention_protection_configs (
        guild_id, admin_enabled, spam_enabled, protected_admin_role_ids_json, channel_mode,
        channel_ids_json, excluded_role_ids_json, mass_mention_threshold,
        burst_message_threshold, burst_window_seconds, admin_repeat_period_ms,
        spam_repeat_period_ms, admin_initial_response_json, admin_repeat_response_json,
        spam_initial_response_json, spam_repeat_response_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        admin_enabled=excluded.admin_enabled, spam_enabled=excluded.spam_enabled,
        protected_admin_role_ids_json=excluded.protected_admin_role_ids_json,
        channel_mode=excluded.channel_mode, channel_ids_json=excluded.channel_ids_json,
        excluded_role_ids_json=excluded.excluded_role_ids_json,
        mass_mention_threshold=excluded.mass_mention_threshold,
        burst_message_threshold=excluded.burst_message_threshold,
        burst_window_seconds=excluded.burst_window_seconds,
        admin_repeat_period_ms=excluded.admin_repeat_period_ms,
        spam_repeat_period_ms=excluded.spam_repeat_period_ms,
        admin_initial_response_json=excluded.admin_initial_response_json,
        admin_repeat_response_json=excluded.admin_repeat_response_json,
        spam_initial_response_json=excluded.spam_initial_response_json,
        spam_repeat_response_json=excluded.spam_repeat_response_json,
        updated_at_ms=excluded.updated_at_ms`,
    )
    .bind(
      next.guildId,
      next.adminEnabled ? 1 : 0,
      next.spamEnabled ? 1 : 0,
      JSON.stringify(next.protectedAdminRoleIds),
      next.channelMode,
      JSON.stringify(next.channelIds),
      JSON.stringify(next.excludedRoleIds),
      next.massMentionThreshold,
      next.burstMessageThreshold,
      next.burstWindowSeconds,
      next.adminRepeatPeriodMs,
      next.spamRepeatPeriodMs,
      JSON.stringify(next.adminInitialResponse),
      JSON.stringify(next.adminRepeatResponse),
      JSON.stringify(next.spamInitialResponse),
      JSON.stringify(next.spamRepeatResponse),
      next.createdAtMs,
      next.updatedAtMs,
    );
}

function botDefenseStatement(
  database: D1Database,
  current: BotDefenseConfig | null,
  next: BotDefenseConfig | null,
): D1PreparedStatement {
  if (!next) {
    return database
      .prepare("DELETE FROM bot_defense_configs WHERE guild_id = ?")
      .bind(current!.guildId);
  }
  return database
    .prepare(
      `INSERT INTO bot_defense_configs (
        guild_id, honeypot_enabled, honeypot_warn_user, honeypot_delete_message,
        rate_enabled, rate_warn_user, rate_delete_message, honeypot_channel_ids_json,
        rate_channel_threshold, rate_window_seconds, excluded_role_ids_json,
        mod_role_ids_json, mod_queue_channel_id, ping_on_queue_post, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        honeypot_enabled=excluded.honeypot_enabled,
        honeypot_warn_user=excluded.honeypot_warn_user,
        honeypot_delete_message=excluded.honeypot_delete_message,
        rate_enabled=excluded.rate_enabled, rate_warn_user=excluded.rate_warn_user,
        rate_delete_message=excluded.rate_delete_message,
        honeypot_channel_ids_json=excluded.honeypot_channel_ids_json,
        rate_channel_threshold=excluded.rate_channel_threshold,
        rate_window_seconds=excluded.rate_window_seconds,
        excluded_role_ids_json=excluded.excluded_role_ids_json,
        mod_role_ids_json=excluded.mod_role_ids_json,
        mod_queue_channel_id=excluded.mod_queue_channel_id,
        ping_on_queue_post=excluded.ping_on_queue_post,
        updated_at_ms=excluded.updated_at_ms`,
    )
    .bind(
      next.guildId,
      next.honeypotEnabled ? 1 : 0,
      next.honeypotWarnUser ? 1 : 0,
      next.honeypotDeleteMessage ? 1 : 0,
      next.rateEnabled ? 1 : 0,
      next.rateWarnUser ? 1 : 0,
      next.rateDeleteMessage ? 1 : 0,
      JSON.stringify(next.honeypotChannelIds),
      next.rateChannelThreshold,
      next.rateWindowSeconds,
      JSON.stringify(next.excludedRoleIds),
      JSON.stringify(next.modRoleIds),
      next.modQueueChannelId,
      next.pingOnQueuePost ? 1 : 0,
      next.createdAtMs,
      next.updatedAtMs,
    );
}

function memberVerificationStatement(
  database: D1Database,
  current: MemberVerificationConfig | null,
  next: MemberVerificationConfig | null,
): D1PreparedStatement {
  if (!next) {
    return database
      .prepare("DELETE FROM member_verification_configs WHERE guild_id = ?")
      .bind(current!.guildId);
  }
  return database
    .prepare(
      `INSERT INTO member_verification_configs (
        guild_id, enabled, verified_role_id, title, description, color, image_url,
        thumbnail_url, rules_url, verify_button_emoji, delivery_mode,
        verification_method, welcome_channel_id, panel_message_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled=excluded.enabled, verified_role_id=excluded.verified_role_id,
        title=excluded.title, description=excluded.description, color=excluded.color,
        image_url=excluded.image_url, thumbnail_url=excluded.thumbnail_url,
        rules_url=excluded.rules_url, verify_button_emoji=excluded.verify_button_emoji,
        delivery_mode=excluded.delivery_mode, verification_method=excluded.verification_method,
        welcome_channel_id=excluded.welcome_channel_id,
        panel_message_id=excluded.panel_message_id, updated_at_ms=excluded.updated_at_ms`,
    )
    .bind(
      next.guildId,
      next.enabled ? 1 : 0,
      next.verifiedRoleId,
      next.title,
      next.description,
      next.color,
      next.imageUrl,
      next.thumbnailUrl,
      next.rulesUrl,
      next.verifyButtonEmoji,
      next.deliveryMode,
      next.verificationMethod,
      next.welcomeChannelId,
      next.panelMessageId,
      next.updatedAtMs,
    );
}

function guildAuditLogStatement(
  database: D1Database,
  current: GuildAuditLogConfig | null,
  next: GuildAuditLogConfig | null,
): D1PreparedStatement {
  if (!next) {
    return database
      .prepare("DELETE FROM guild_audit_log_configs WHERE guild_id = ?")
      .bind(current!.guildId);
  }
  return database
    .prepare(
      `INSERT INTO guild_audit_log_configs (
        guild_id, audit_channel_id, group_channel_ids_json, event_states_json,
        excluded_channel_ids_json, excluded_role_ids_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        audit_channel_id=excluded.audit_channel_id,
        group_channel_ids_json=excluded.group_channel_ids_json,
        event_states_json=excluded.event_states_json,
        excluded_channel_ids_json=excluded.excluded_channel_ids_json,
        excluded_role_ids_json=excluded.excluded_role_ids_json,
        updated_at_ms=excluded.updated_at_ms`,
    )
    .bind(
      next.guildId,
      next.auditChannelId,
      JSON.stringify(next.groupChannelIds),
      JSON.stringify(next.eventStates),
      JSON.stringify(next.excludedChannelIds ?? []),
      JSON.stringify(next.excludedRoleIds ?? []),
      next.updatedAtMs,
    );
}

function rowToRevision(row: RevisionRow): ConfigurationRevision {
  return {
    id: row.id,
    guildId: row.guild_id,
    feature: row.feature as ConfigurationFeatureKey,
    resourceKey: row.resource_key,
    schemaVersion: row.schema_version,
    operation: row.operation as ConfigurationRevisionOperation,
    source: row.source as ConfigurationRevisionSource,
    actorUserId: row.actor_user_id,
    operationId: row.operation_id,
    correlationId: row.correlation_id,
    previousRevisionId: row.previous_revision_id,
    restoredFromRevisionId: row.restored_from_revision_id,
    snapshotJson: row.snapshot_json,
    snapshotHash: row.snapshot_hash,
    createdAtMs: row.created_at_ms,
  };
}
