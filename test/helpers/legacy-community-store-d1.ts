import { DEFAULT_MARKETPLACE_NOTICE_EMBED } from "../../src/marketplace-config";

type LegacyCommunityStoreFetch = (
  input: Request | string | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

type GuildTier = "free" | "premium" | "premium_plus";

interface LegacyCommunityStoreDatabaseOptions {
  moderationFetch?: LegacyCommunityStoreFetch;
  guildEntitlementTier?: GuildTier;
  guildEntitlementTiers?: Record<string, GuildTier>;
  guildEntitlementWrites?: unknown[];
}

export function createLegacyCommunityStoreDatabase(
  options: LegacyCommunityStoreDatabaseOptions = {},
): D1Database {
  let cachedBlocklistConfig: any = null;
  let blocklistConfigPromise: Promise<any> | null = null;
  const blocklistOverrides = new Map<string, { enabled: boolean; emojis: string[] }>();
  const gatewayOperations = new Map<string, Record<string, unknown>>();

  return {
    async exec() {
      return { count: 0, duration: 0 } as never;
    },
    prepare(sql: string) {
      const createBoundStatement = (args: unknown[]) => ({
        first<T>(): Promise<T | null> {
          return execute<T>(sql, args);
        },
        all<T>(): Promise<{ results: T[] }> {
          return executeAll<T>(sql, args);
        },
        run(): Promise<{ success: true }> {
          return executeRun(sql, args);
        },
        async raw(): Promise<unknown[][]> {
          return (await executeRaw(sql, args)).map((row) => rowToSelectedValues(sql, row));
        },
      });

      return {
        first<T>() {
          return createBoundStatement([]).first<T>();
        },
        all<T>() {
          return createBoundStatement([]).all<T>();
        },
        run() {
          return createBoundStatement([]).run();
        },
        raw() {
          return createBoundStatement([]).raw();
        },
        bind(...args: unknown[]) {
          return createBoundStatement(args);
        },
      } as never;
    },
    async batch(statements: D1PreparedStatement[]) {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results as never;
    },
  } as unknown as D1Database;

  async function execute<T>(sql: string, args: unknown[]): Promise<T | null> {
    const normalizedSql = normalizeSql(sql);

    if (normalizedSql.includes("from gateway_event_operations")) {
      return (gatewayOperations.get(`${String(args[0])}:${String(args[1])}`) ?? null) as T | null;
    }

    if (
      sql.includes("SELECT notification_channel_id FROM guild_notification_channels") ||
      (normalizedSql.includes("from guild_notification_channels") &&
        normalizedSql.includes("guild_notification_channels.guild_id = ?") &&
        normalizedSql.includes("guild_notification_channels.feature = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/guild-notification-channel?guildId=${encodeURIComponent(String(args[0]))}&feature=${encodeURIComponent(String(args[1]))}`,
      );
      const body: any = await response.json();
      return {
        guild_id: args[0],
        feature: args[1],
        notification_channel_id: body?.notificationChannelId ?? null,
      } as T;
    }

    if (
      sql.includes("SELECT guild_admin_role_id FROM guild_rbac_settings") ||
      (normalizedSql.includes("from guild_rbac_settings") &&
        normalizedSql.includes("guild_rbac_settings.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/guild-rbac/admin-role?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const body: any = await response.json();
      return {
        guild_id: args[0],
        guild_admin_role_id: body?.guildAdminRoleId ?? body?.roleId ?? null,
      } as T;
    }

    if (
      sql.includes("UPDATE ticket_counters") &&
      sql.includes("RETURNING next_ticket_number - 1 AS ticket_number")
    ) {
      const response = await fetchStore("https://community-store/ticket-number/next", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]) }),
      });
      const body: any = await response.json();
      return { ticket_number: body?.ticketNumber ?? 1 } as T;
    }

    if (
      (sql.includes(
        "SELECT guild_id, panel_channel_id, category_channel_id, transcript_channel_id, panel_message_id, ticket_types_json",
      ) &&
        sql.includes("FROM ticket_panels")) ||
      (normalizedSql.includes("from ticket_panels") &&
        normalizedSql.includes("ticket_panels.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/ticket-panel?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const panel: any = await response.json();
      if (!panel) return null;
      return {
        guild_id: panel.guildId,
        panel_id: panel.panelId ?? "main",
        panel_name: panel.panelName ?? "Main panel",
        panel_channel_id: panel.panelChannelId,
        category_channel_id: panel.categoryChannelId,
        transcript_channel_id: panel.transcriptChannelId,
        panel_message_id: panel.panelMessageId ?? null,
        ticket_types_json: JSON.stringify({
          panelEmoji: panel.panelEmoji ?? null,
          panelTitle: panel.panelTitle ?? null,
          panelDescription: panel.panelDescription ?? null,
          panelFooter: panel.panelFooter ?? null,
          ticketTypes: panel.ticketTypes ?? [],
        }),
        ticket_creation_limit: panel.ticketCreationLimit ?? null,
        ticket_limit_rejection_message: panel.ticketLimitRejectionMessage ?? null,
        enable_ticket_claiming: panel.enableTicketClaiming ? 1 : 0,
      } as T;
    }

    if (
      sql.includes(
        "SELECT * FROM ticket_instances WHERE guild_id = ? AND channel_id = ? AND status = 'open'",
      )
    ) {
      const response = await fetchStore(
        `https://community-store/ticket-instance/open?guildId=${encodeURIComponent(String(args[0]))}&channelId=${encodeURIComponent(String(args[1]))}`,
      );
      const instance: any = await response.json();
      if (!instance) return null;
      return {
        guild_id: instance.guildId,
        channel_id: instance.channelId,
        ticket_type_id: instance.ticketTypeId,
        ticket_type_label: instance.ticketTypeLabel,
        opener_user_id: instance.openerUserId,
        support_role_id: instance.supportRoleId ?? null,
        status: instance.status,
        answers_json: JSON.stringify(instance.answers ?? []),
        opened_at_ms: instance.openedAtMs,
        closed_at_ms: instance.closedAtMs ?? null,
        closed_by_user_id: instance.closedByUserId ?? null,
        transcript_message_id: instance.transcriptMessageId ?? null,
        staff_thread_id: instance.staffThreadId ?? null,
      } as T;
    }

    if (
      sql.includes(
        "SELECT * FROM ticket_instances WHERE guild_id = ? AND staff_thread_id = ? AND status = 'open'",
      )
    ) {
      return null;
    }

    if (sql.includes("FROM ticket_staff_messages")) {
      return null;
    }

    if (
      sql.includes("SELECT * FROM marketplace_configs WHERE guild_id = ? LIMIT 1") ||
      (normalizedSql.includes("from marketplace_configs") &&
        normalizedSql.includes("marketplace_configs.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/marketplace/config?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const config: any = await response.json();
      if (!config) return null;
      return {
        guild_id: config.guildId,
        enabled: config.enabled === false ? 0 : 1,
        notice_channel_id: config.noticeChannelId ?? null,
        notice_message_id: config.noticeMessageId ?? null,
        log_channel_id: config.logChannelId ?? null,
        server_options_json: JSON.stringify(config.serverOptions ?? []),
        notice_embed_json: JSON.stringify(config.noticeEmbed ?? DEFAULT_MARKETPLACE_NOTICE_EMBED),
        server_choice_enabled: config.serverChoiceEnabled === false ? 0 : 1,
        additional_choices_enabled: config.additionalChoicesEnabled === true ? 1 : 0,
        additional_choices_json: JSON.stringify(config.additionalChoices ?? []),
        flow_updated_at_ms: config.flowUpdatedAtMs ?? config.updatedAtMs ?? 0,
        updated_at_ms: config.updatedAtMs ?? 0,
      } as T;
    }

    if (
      sql.includes("SELECT * FROM marketplace_posts WHERE guild_id = ? AND post_id = ? LIMIT 1") ||
      (normalizedSql.includes("from marketplace_posts") &&
        normalizedSql.includes("marketplace_posts.guild_id = ?") &&
        normalizedSql.includes("marketplace_posts.post_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/marketplace/post?guildId=${encodeURIComponent(String(args[0]))}&postId=${encodeURIComponent(String(args[1]))}`,
      );
      const post: any = await response.json();
      return post ? (mapMarketplacePost(post) as T) : null;
    }

    if (
      sql.includes(
        "SELECT * FROM marketplace_posts WHERE guild_id = ? AND owner_id = ? AND active = 1",
      ) ||
      (normalizedSql.includes("from marketplace_posts") &&
        normalizedSql.includes("marketplace_posts.guild_id = ?") &&
        normalizedSql.includes("marketplace_posts.owner_id = ?") &&
        normalizedSql.includes("marketplace_posts.active = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/marketplace/post/active-by-owner?guildId=${encodeURIComponent(String(args[0]))}&ownerId=${encodeURIComponent(String(args[1]))}`,
      );
      const post: any = await response.json();
      return post ? (mapMarketplacePost(post) as T) : null;
    }

    if (
      sql.includes("SELECT * FROM lfg_configs WHERE guild_id = ? LIMIT 1") ||
      (normalizedSql.includes("from lfg_configs") &&
        normalizedSql.includes("where lfg_configs.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/config?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const config: any = await response.json();
      if (!config) return null;
      return {
        guild_id: config.guildId,
        enabled: config.enabled === false ? 0 : 1,
        notice_channel_id: config.noticeChannelId ?? null,
        notice_message_id: config.noticeMessageId ?? null,
        notification_role_id: config.notificationRoleId ?? null,
        notice_color: config.noticeColor ?? 0x2b2d31,
        counter_voice_channel_id: config.counterVoiceChannelId ?? null,
        counter_display_format: config.counterDisplayFormat ?? "LFG ({count})",
        approval_flow_enabled: config.approvalFlowEnabled === true ? 1 : 0,
        approval_audit_channel_id: config.approvalAuditChannelId ?? null,
        approval_voice_category_id: config.approvalVoiceCategoryId ?? null,
        expiry_action: config.expiryAction ?? "close",
        expiry_duration_hours: config.expiryDurationHours ?? 24,
        server_options_json: JSON.stringify(config.serverOptions ?? []),
        updated_at_ms: config.updatedAtMs ?? 0,
      } as T;
    }

    if (
      sql.includes("SELECT COUNT(*) AS count FROM lfg_posts WHERE guild_id = ? AND active = 1") ||
      (normalizedSql.includes("from lfg_posts") &&
        normalizedSql.includes("count") &&
        normalizedSql.includes("lfg_posts.guild_id = ?") &&
        normalizedSql.includes("lfg_posts.active = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/posts?guildId=${encodeURIComponent(String(args[0]))}&activeOnly=true&limit=1000`,
      );
      const posts: any[] = (await response.json()) as any[];
      return { count: posts.length } as T;
    }

    if (
      sql.includes("SELECT * FROM lfg_posts WHERE guild_id = ? AND post_id = ? LIMIT 1") ||
      (normalizedSql.includes("from lfg_posts") &&
        normalizedSql.includes("lfg_posts.guild_id = ?") &&
        normalizedSql.includes("lfg_posts.post_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/post?guildId=${encodeURIComponent(String(args[0]))}&postId=${encodeURIComponent(String(args[1]))}`,
      );
      const post: any = await response.json();
      return post ? (mapLfgPost(post) as T) : null;
    }

    if (
      sql.includes(
        "SELECT * FROM lfg_applications WHERE guild_id = ? AND post_id = ? AND applicant_id = ? LIMIT 1",
      ) ||
      (normalizedSql.includes("from lfg_applications") &&
        normalizedSql.includes("lfg_applications.guild_id = ?") &&
        normalizedSql.includes("lfg_applications.post_id = ?") &&
        normalizedSql.includes("lfg_applications.applicant_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/application?guildId=${encodeURIComponent(String(args[0]))}&postId=${encodeURIComponent(String(args[1]))}&applicantId=${encodeURIComponent(String(args[2]))}`,
      );
      const application: any = await response.json();
      return application ? (mapLfgApplication(application) as T) : null;
    }

    if (
      sql.includes("SELECT * FROM lfg_voice_channels WHERE channel_id = ? LIMIT 1") ||
      (normalizedSql.includes("from lfg_voice_channels") &&
        normalizedSql.includes("lfg_voice_channels.channel_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/voice-channel/by-channel-id?channelId=${encodeURIComponent(String(args[0]))}`,
      );
      const voiceChannel: any = await response.json();
      return voiceChannel ? (mapLfgVoiceChannel(voiceChannel) as T) : null;
    }

    if (
      sql.includes("SELECT * FROM lfg_posts WHERE guild_id = ? AND owner_id = ? AND active = 1") ||
      (normalizedSql.includes("from lfg_posts") &&
        normalizedSql.includes("lfg_posts.guild_id = ?") &&
        normalizedSql.includes("lfg_posts.owner_id = ?") &&
        normalizedSql.includes("lfg_posts.active = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/post/active-by-owner?guildId=${encodeURIComponent(String(args[0]))}&ownerId=${encodeURIComponent(String(args[1]))}`,
      );
      const post: any = await response.json();
      return post ? (mapLfgPost(post) as T) : null;
    }

    if (
      sql.includes(
        "SELECT role_id, duration_input FROM new_member_timed_role_configs WHERE guild_id = ? LIMIT 1",
      ) ||
      (normalizedSql.includes("from new_member_timed_role_configs") &&
        normalizedSql.includes("new_member_timed_role_configs.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/timed-role/new-member-config?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const config: any = await response.json();
      const rules = Array.isArray(config?.roles) ? config.roles : [];
      return {
        guild_id: String(args[0]),
        guildId: String(args[0]),
        roleId: rules[0]?.roleId ?? config?.roleId ?? null,
        durationInput: rules[0]?.durationInput ?? config?.durationInput ?? null,
        rolesJson: JSON.stringify(rules),
        role_id: rules[0]?.roleId ?? config?.roleId ?? null,
        duration_input: rules[0]?.durationInput ?? config?.durationInput ?? null,
        roles_json: JSON.stringify(rules),
      } as T;
    }

    if (
      sql.includes(
        "SELECT role_id, duration_input FROM manual_assignment_timed_role_configs WHERE guild_id = ? LIMIT 1",
      ) ||
      (normalizedSql.includes("from manual_assignment_timed_role_configs") &&
        normalizedSql.includes("manual_assignment_timed_role_configs.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/timed-role/manual-assignment-config?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const config: any = await response.json();
      const rules = Array.isArray(config?.roles) ? config.roles : [];
      return {
        guild_id: String(args[0]),
        guildId: String(args[0]),
        roleId: rules[0]?.roleId ?? config?.roleId ?? null,
        durationInput: rules[0]?.durationInput ?? config?.durationInput ?? null,
        rolesJson: JSON.stringify(rules),
        role_id: rules[0]?.roleId ?? config?.roleId ?? null,
        duration_input: rules[0]?.durationInput ?? config?.durationInput ?? null,
        roles_json: JSON.stringify(rules),
      } as T;
    }

    if (
      sql.includes("SELECT * FROM steam_link_configs WHERE guild_id = ? LIMIT 1") ||
      (normalizedSql.includes("from steam_link_configs") &&
        normalizedSql.includes("steam_link_configs.guild_id = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/steam-link/config?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const config: any = await response.json();
      if (!config) return null;
      return {
        guild_id: config.guildId,
        steam_linked_role_id: config.steamLinkedRoleId ?? null,
        log_channel_id: config.logChannelId ?? null,
        game_app_ids_json: JSON.stringify(config.gameAppIds ?? []),
        panel_title: config.panelTitle,
        panel_description: config.panelDescription,
        panel_button_label: config.panelButtonLabel,
        panel_button_style: config.panelButtonStyle,
        allow_relink: config.allowRelink ? 1 : 0,
        allowMultipleLinks: config.allowMultipleLinks ? 1 : 0,
        allow_multiple_links: config.allowMultipleLinks ? 1 : 0,
        updated_at_ms: config.updatedAtMs ?? null,
        whois_fields_json: JSON.stringify(config.whoisFields ?? ["profile", "gameOwnership"]),
        custom_links_json: JSON.stringify(config.customLinks ?? []),
        panel_channel_id: config.panelChannelId ?? null,
        panel_message_id: config.panelMessageId ?? null,
      } as T;
    }

    if (sql.includes("SELECT * FROM pending_steam_links WHERE state = ? LIMIT 1")) {
      const response = await fetchStore(
        `https://community-store/steam-link/pending?state=${encodeURIComponent(String(args[0]))}`,
      );
      const pending: any = await response.json();
      if (!pending) return null;
      return {
        state: pending.state,
        guild_id: pending.guildId,
        user_id: pending.userId,
        created_at_ms: pending.createdAtMs,
      } as T;
    }

    if (sql.includes("SELECT * FROM steam_links WHERE guild_id = ? AND user_id = ? LIMIT 1")) {
      const response = await fetchStore(
        `https://community-store/steam-link/link?guildId=${encodeURIComponent(String(args[0]))}&userId=${encodeURIComponent(String(args[1]))}`,
      );
      const link: any = await response.json();
      return link ? (mapSteamLink(link) as T) : null;
    }

    if (sql.includes("SELECT * FROM steam_links WHERE guild_id = ? AND steam_id64 = ? LIMIT 1")) {
      const response = await fetchStore(
        `https://community-store/steam-link/link/by-steamid?guildId=${encodeURIComponent(String(args[0]))}&steamId64=${encodeURIComponent(String(args[1]))}`,
      );
      const link: any = await response.json();
      return link ? (mapSteamLink(link) as T) : null;
    }

    if (
      normalizedSql.includes("from steam_links") &&
      normalizedSql.includes("steam_links.guild_id = ?") &&
      normalizedSql.includes("steam_links.user_id = ?") &&
      normalizedSql.includes("steam_links.steam_id64 = ?")
    ) {
      const response = await fetchStore(
        `https://community-store/steam-link/link/by-steamid?guildId=${encodeURIComponent(String(args[0]))}&steamId64=${encodeURIComponent(String(args[2]))}`,
      );
      const link: any = await response.json();
      if (!link || link.userId !== String(args[1])) return null;
      return mapSteamLink(link) as T;
    }

    if (
      sql.includes("SELECT * FROM guild_entitlements WHERE guild_id = ? LIMIT 1") ||
      (normalizedSql.includes("from guild_entitlements") &&
        normalizedSql.includes("guild_entitlements.guild_id = ?"))
    ) {
      const guildId = String(args[0]);
      const plan =
        options.guildEntitlementTiers?.[guildId] ?? options.guildEntitlementTier ?? "free";
      return {
        guild_id: guildId,
        tier: plan,
        plan,
        updated_at_ms: 1,
      } as T;
    }

    return null;
  }

  async function executeAll<T>(sql: string, args: unknown[]): Promise<{ results: T[] }> {
    const normalizedSql = normalizeSql(sql);

    if (normalizedSql.includes("from timed_role_config_rules")) {
      const first = String(args[0]);
      const second = String(args[1]);
      const configType = normalizedSql.includes("new-member")
        ? "new-member"
        : normalizedSql.includes("manual-assignment")
          ? "manual-assignment"
          : first === "new-member" || first === "manual-assignment"
            ? first
            : second;
      const guildId = configType === first ? second : first;
      const path = configType === "new-member" ? "new-member-config" : "manual-assignment-config";
      const response = await fetchStore(
        `https://community-store/timed-role/${path}?guildId=${encodeURIComponent(guildId)}`,
      );
      const config: any = await response.json();
      const rules = Array.isArray(config?.roles)
        ? config.roles
        : config?.roleId && config?.durationInput
          ? [
              {
                roleId: config.roleId,
                durationInput: config.durationInput,
                dmMessage: config.dmMessage,
              },
            ]
          : [];
      return {
        results: rules.map(
          (rule: any) =>
            ({
              guildId,
              guild_id: guildId,
              configType,
              config_type: configType,
              roleId: rule.roleId,
              role_id: rule.roleId,
              durationInput: rule.durationInput,
              duration_input: rule.durationInput,
              dmMessage: rule.dmMessage ?? null,
              dm_message: rule.dmMessage ?? null,
              updatedAtMs: Date.now(),
              updated_at_ms: Date.now(),
            }) as T,
        ),
      };
    }

    if (
      sql.includes("SELECT guild_id, moderation_enabled") ||
      normalizedSql.includes("from guild_settings")
    ) {
      const config = await readBlocklistConfig();
      const guilds = (config.guilds ?? {}) as Record<string, any>;
      return {
        results: Object.entries(guilds).map(
          ([guildId, guildConfig]) =>
            ({
              guild_id: guildId,
              moderation_enabled: guildConfig?.enabled === false ? 0 : 1,
              channel_mode: guildConfig?.channelMode ?? "include",
              channel_ids_json: JSON.stringify(guildConfig?.channelIds ?? []),
            }) as T,
        ),
      };
    }

    if (
      sql.includes("SELECT guild_id, normalized_emoji FROM guild_blocked_emojis") ||
      normalizedSql.includes("from guild_blocked_emojis")
    ) {
      const config = await readBlocklistConfig();
      const guilds = (config.guilds ?? {}) as Record<string, any>;
      return {
        results: Object.entries(guilds).flatMap(([guildId, guildConfig]) =>
          ((guildConfig?.emojis ?? []) as any[]).map(
            (emoji: any) =>
              ({
                guild_id: guildId,
                normalized_emoji: emoji,
              }) as T,
          ),
        ),
      };
    }

    if (
      sql.includes("SELECT key, value FROM app_config") ||
      normalizedSql.includes("from app_config")
    ) {
      const config = await readBlocklistConfig();
      return {
        results: config.botUserId ? ([{ key: "bot_user_id", value: config.botUserId }] as T[]) : [],
      };
    }

    if (
      sql.includes(
        "SELECT * FROM marketplace_posts WHERE guild_id = ? AND active = 1 ORDER BY created_at_ms DESC LIMIT ?",
      )
    ) {
      const response = await fetchStore(
        `https://community-store/marketplace/posts?guildId=${encodeURIComponent(String(args[0]))}&activeOnly=true&limit=${encodeURIComponent(String(args[1]))}`,
      );
      const posts: any[] = (await response.json()) as any[];
      return { results: (posts ?? []).map(mapMarketplacePost) as T[] };
    }

    if (
      sql.includes(
        "SELECT * FROM marketplace_posts WHERE guild_id = ? ORDER BY created_at_ms DESC LIMIT ?",
      )
    ) {
      const response = await fetchStore(
        `https://community-store/marketplace/posts?guildId=${encodeURIComponent(String(args[0]))}&limit=${encodeURIComponent(String(args[1]))}`,
      );
      const posts: any[] = (await response.json()) as any[];
      return { results: (posts ?? []).map(mapMarketplacePost) as T[] };
    }

    if (
      sql.includes(
        "SELECT * FROM marketplace_trade_logs WHERE guild_id = ? ORDER BY timestamp_ms DESC LIMIT ?",
      )
    ) {
      const response = await fetchStore(
        `https://community-store/marketplace/logs?guildId=${encodeURIComponent(String(args[0]))}&limit=${encodeURIComponent(String(args[1]))}`,
      );
      const logs: any[] = (await response.json()) as any[];
      return { results: (logs ?? []).map(mapMarketplaceLog) as T[] };
    }

    if (
      sql.includes(
        "SELECT * FROM lfg_posts WHERE guild_id = ? AND active = 1 ORDER BY created_at_ms DESC LIMIT ?",
      )
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/posts?guildId=${encodeURIComponent(String(args[0]))}&activeOnly=true&limit=${encodeURIComponent(String(args[1]))}`,
      );
      const posts: any[] = (await response.json()) as any[];
      return { results: (posts ?? []).map(mapLfgPost) as T[] };
    }

    if (
      sql.includes("SELECT * FROM lfg_posts WHERE guild_id = ? ORDER BY created_at_ms DESC LIMIT ?")
    ) {
      const response = await fetchStore(
        `https://community-store/lfg/posts?guildId=${encodeURIComponent(String(args[0]))}&limit=${encodeURIComponent(String(args[1]))}`,
      );
      const posts: any[] = (await response.json()) as any[];
      return { results: (posts ?? []).map(mapLfgPost) as T[] };
    }

    if (
      normalizedSql.includes("from lfg_applications") &&
      normalizedSql.includes("lfg_applications.guild_id = ?") &&
      normalizedSql.includes("lfg_applications.post_id = ?")
    ) {
      const status = normalizedSql.includes("lfg_applications.status = ?") ? String(args[2]) : null;
      const response = await fetchStore(
        `https://community-store/lfg/applications?guildId=${encodeURIComponent(String(args[0]))}&postId=${encodeURIComponent(String(args[1]))}${status ? `&status=${encodeURIComponent(status)}` : ""}`,
      );
      const applications: any[] = (await response.json()) as any[];
      return { results: (applications ?? []).map(mapLfgApplication) as T[] };
    }

    if (
      sql.includes(
        "SELECT guild_id, user_id, role_id, target_display_name, duration_input, expires_at_ms, created_at_ms, updated_at_ms FROM timed_roles ORDER BY guild_id ASC, expires_at_ms ASC",
      ) ||
      (normalizedSql.includes("from timed_roles") &&
        normalizedSql.includes("order by") &&
        !normalizedSql.includes("where"))
    ) {
      const response = await fetchStore("https://community-store/timed-roles");
      const roles: any[] = (await response.json()) as any[];
      return { results: (roles ?? []).map(mapTimedRole) as T[] };
    }

    if (
      sql.includes(
        "SELECT guild_id, user_id, role_id, target_display_name, duration_input, expires_at_ms, created_at_ms, updated_at_ms FROM timed_roles WHERE guild_id = ? ORDER BY expires_at_ms ASC",
      ) ||
      (normalizedSql.includes("from timed_roles") &&
        normalizedSql.includes("timed_roles.guild_id = ?") &&
        normalizedSql.includes("order by"))
    ) {
      const response = await fetchStore(
        `https://community-store/timed-roles?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const roles: any[] = (await response.json()) as any[];
      return { results: (roles ?? []).map(mapTimedRole) as T[] };
    }

    if (
      sql.includes(
        "SELECT guild_id, user_id, role_id, target_display_name, duration_input, expires_at_ms, created_at_ms, updated_at_ms FROM timed_roles WHERE expires_at_ms <= ? ORDER BY expires_at_ms ASC",
      ) ||
      (normalizedSql.includes("from timed_roles") &&
        normalizedSql.includes("timed_roles.expires_at_ms <= ?"))
    ) {
      const response = await fetchStore("https://community-store/timed-roles");
      const roles: any[] = (await response.json()) as any[];
      return {
        results: (roles ?? [])
          .filter(
            (role: { expiresAtMs?: number }) =>
              (role.expiresAtMs ?? Number.MAX_SAFE_INTEGER) <= Number(args[0]),
          )
          .map(mapTimedRole) as T[],
      };
    }

    if (
      sql.trim() === "SELECT * FROM steam_links WHERE guild_id = ?" ||
      (normalizedSql.includes("from steam_links") &&
        normalizedSql.includes("steam_links.guild_id = ?") &&
        !normalizedSql.includes("steam_links.user_id = ?") &&
        !normalizedSql.includes("steam_links.steam_id64 = ?"))
    ) {
      const response = await fetchStore(
        `https://community-store/steam-link/links?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const links: any[] = (await response.json()) as any[];
      return { results: (links ?? []).map(mapSteamLink) as T[] };
    }

    if (
      normalizedSql.includes("from steam_links") &&
      normalizedSql.includes("steam_links.guild_id = ?") &&
      normalizedSql.includes("steam_links.user_id = ?") &&
      !normalizedSql.includes("steam_links.steam_id64 = ?")
    ) {
      const response = await fetchStore(
        `https://community-store/steam-link/links?guildId=${encodeURIComponent(String(args[0]))}`,
      );
      const links: any[] = (await response.json()) as any[];
      return {
        results: (links ?? [])
          .filter((link) => link.guildId === String(args[0]) && link.userId === String(args[1]))
          .map(mapSteamLink) as T[],
      };
    }

    return { results: [] };
  }

  async function executeRun(sql: string, args: unknown[]): Promise<{ success: true }> {
    const normalizedSql = normalizeSql(sql);

    if (normalizedSql.includes("insert into gateway_event_operations")) {
      const key = `${String(args[0])}:${String(args[1])}`;
      const existing = gatewayOperations.get(key);
      let changes = 0;
      if (!existing) {
        gatewayOperations.set(key, {
          event_key: args[0],
          handler_key: args[1],
          state: "processing",
          lease_token: args[2],
          lease_expires_at_ms: args[3],
          attempts: 1,
          outcome_code: null,
          outcome_json: null,
          completed_at_ms: null,
        });
        changes = 1;
      } else if (
        existing.state === "processing" &&
        Number(existing.lease_expires_at_ms) <= Number(args[4])
      ) {
        existing.lease_token = args[2];
        existing.lease_expires_at_ms = args[3];
        existing.attempts = Number(existing.attempts) + 1;
        changes = 1;
      }
      return { success: true, meta: { changes } } as never;
    }

    if (
      normalizedSql.includes("update gateway_event_operations") &&
      normalizedSql.includes("set lease_expires_at_ms")
    ) {
      const key = `${String(args[2])}:${String(args[3])}`;
      const existing = gatewayOperations.get(key);
      const changes = existing?.state === "processing" && existing.lease_token === args[4] ? 1 : 0;
      if (changes === 1 && existing) {
        existing.lease_expires_at_ms = args[0];
      }
      return { success: true, meta: { changes } } as never;
    }

    if (normalizedSql.includes("update gateway_event_operations")) {
      const key = `${String(args[5])}:${String(args[6])}`;
      const existing = gatewayOperations.get(key);
      const changes = existing?.state === "processing" && existing.lease_token === args[7] ? 1 : 0;
      if (changes === 1 && existing) {
        existing.state = args[0];
        existing.lease_token = null;
        existing.lease_expires_at_ms = null;
        existing.outcome_code = args[1];
        existing.outcome_json = args[2];
        existing.completed_at_ms = args[4];
      }
      return { success: true, meta: { changes } } as never;
    }

    if (normalizedSql.includes("delete from gateway_event_operations")) {
      let changes = 0;
      for (const [key, operation] of gatewayOperations) {
        if (
          (operation.state === "completed" || operation.state === "terminal") &&
          Number(operation.completed_at_ms) < Number(args[0])
        ) {
          gatewayOperations.delete(key);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } } as never;
    }

    if (
      sql.includes("INSERT OR IGNORE INTO guild_settings") ||
      normalizedSql.includes("insert into guild_settings")
    ) {
      return { success: true };
    }

    if (
      sql.includes("INSERT OR IGNORE INTO guild_blocked_emojis") ||
      normalizedSql.includes("insert into guild_blocked_emojis")
    ) {
      await fetchStore("https://community-store/guild-emoji", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), emoji: String(args[1]), action: "add" }),
      });
      applyBlocklistOverride(String(args[0]), String(args[1]), "add");
      invalidateBlocklistConfig();
      return { success: true };
    }

    if (
      sql.includes(
        "DELETE FROM guild_blocked_emojis WHERE guild_id = ? AND normalized_emoji = ?",
      ) ||
      (normalizedSql.includes("delete from guild_blocked_emojis") &&
        normalizedSql.includes("guild_blocked_emojis.guild_id = ?") &&
        normalizedSql.includes("guild_blocked_emojis.normalized_emoji = ?"))
    ) {
      await fetchStore("https://community-store/guild-emoji", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          emoji: String(args[1]),
          action: "remove",
        }),
      });
      applyBlocklistOverride(String(args[0]), String(args[1]), "remove");
      invalidateBlocklistConfig();
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM guild_notification_channels WHERE guild_id = ? AND feature = ?") ||
      (normalizedSql.includes("delete from guild_notification_channels") &&
        normalizedSql.includes("guild_notification_channels.guild_id = ?") &&
        normalizedSql.includes("guild_notification_channels.feature = ?"))
    ) {
      await fetchStore("https://community-store/guild-notification-channel", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          feature: String(args[1]),
          notificationChannelId: null,
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO guild_notification_channels(guild_id, feature, notification_channel_id)",
      ) ||
      normalizedSql.includes("insert into guild_notification_channels")
    ) {
      await fetchStore("https://community-store/guild-notification-channel", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          feature: String(args[1]),
          notificationChannelId: String(args[2]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM guild_rbac_settings WHERE guild_id = ?") ||
      (normalizedSql.includes("delete from guild_rbac_settings") &&
        normalizedSql.includes("guild_rbac_settings.guild_id = ?"))
    ) {
      await fetchStore("https://community-store/guild-rbac/admin-role", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), roleId: null }),
      });
      return { success: true };
    }

    if (
      sql.includes("INSERT INTO guild_rbac_settings(guild_id, guild_admin_role_id) VALUES(?, ?)") ||
      normalizedSql.includes("insert into guild_rbac_settings")
    ) {
      await fetchStore("https://community-store/guild-rbac/admin-role", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), roleId: args[1] }),
      });
      return { success: true };
    }

    if (
      sql.includes("INSERT INTO ticket_panels(guild_id, panel_channel_id") ||
      normalizedSql.includes("insert into ticket_panels")
    ) {
      const hasPanelIdentity = normalizedSql.includes("panel_id");
      const offset = hasPanelIdentity ? 2 : 0;
      const parsed: any = parseJson(args[5 + offset], {} as any);
      await fetchStore("https://community-store/ticket-panel", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          panelId: hasPanelIdentity ? String(args[1]) : "main",
          panelName: hasPanelIdentity ? String(args[2]) : "Main panel",
          panelChannelId: String(args[1 + offset]),
          categoryChannelId: String(args[2 + offset]),
          transcriptChannelId: String(args[3 + offset]),
          panelMessageId: args[4 + offset] ?? null,
          panelEmoji: parsed.panelEmoji ?? null,
          panelTitle: parsed.panelTitle ?? null,
          panelDescription: parsed.panelDescription ?? null,
          panelFooter: parsed.panelFooter ?? null,
          ticketTypes: parsed.ticketTypes ?? [],
          ticketCreationLimit: args[6 + offset] ?? null,
          ticketLimitRejectionMessage: args[7 + offset] ?? null,
          enableTicketClaiming: args[8 + offset] === 1,
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("INSERT INTO ticket_instances(guild_id, channel_id") ||
      normalizedSql.includes("insert into ticket_instances")
    ) {
      await fetchStore("https://community-store/ticket-instance", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          channelId: String(args[1]),
          ticketTypeId: String(args[2]),
          ticketTypeLabel: String(args[3]),
          openerUserId: String(args[4]),
          supportRoleId: args[5] ?? null,
          status: String(args[6]),
          answers: parseJson(args[7], []),
          openedAtMs: Number(args[8]),
          closedAtMs: args[9] ?? null,
          closedByUserId: args[10] ?? null,
          transcriptMessageId: args[11] ?? null,
          staffThreadId: args[12] ?? null,
          claimedByUserId: args[13] ?? null,
          claimedAtMs: args[14] ?? null,
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("INSERT INTO ticket_staff_messages") ||
      sql.includes("UPDATE ticket_staff_messages") ||
      sql.includes("DELETE FROM ticket_staff_messages")
    ) {
      return { success: true };
    }

    if (sql.includes("DELETE FROM ticket_instances WHERE guild_id = ? AND channel_id = ?")) {
      await fetchStore("https://community-store/ticket-instance/delete", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), channelId: String(args[1]) }),
      });
      return { success: true };
    }

    if (sql.includes("UPDATE ticket_instances SET status = 'closed'")) {
      await fetchStore("https://community-store/ticket-instance/close", {
        method: "POST",
        body: JSON.stringify({
          closedByUserId: String(args[0]),
          closedAtMs: Number(args[1]),
          transcriptMessageId: args[2] ?? null,
          guildId: String(args[3]),
          channelId: String(args[4]),
        }),
      });
      return { success: true };
    }

    if (sql.includes("UPDATE ticket_instances SET claimed_by_user_id = ?, claimed_at_ms = ?")) {
      await fetchStore("https://community-store/ticket-instance/claim", {
        method: "POST",
        body: JSON.stringify({
          claimedByUserId: args[0] ?? null,
          claimedAtMs: args[1] ?? null,
          guildId: String(args[2]),
          channelId: String(args[3]),
        }),
      });
      return { success: true };
    }

    if (sql.includes("INSERT OR IGNORE INTO ticket_counters")) {
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO marketplace_configs(guild_id, notice_channel_id, notice_message_id, log_channel_id, server_options_json, updated_at_ms)",
      ) ||
      normalizedSql.includes("insert into marketplace_configs")
    ) {
      await fetchStore("https://community-store/marketplace/config", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          noticeChannelId: args[1] ?? null,
          noticeMessageId: args[2] ?? null,
          logChannelId: args[3] ?? null,
          serverOptions: parseJson(args[4], []),
          noticeEmbed: parseJson(args[5], null),
          serverChoiceEnabled: Number(args[6]) === 1,
          additionalChoicesEnabled: Number(args[7]) === 1,
          additionalChoices: parseJson(args[8], []),
          flowUpdatedAtMs: Number(args[9]),
          updatedAtMs: Number(args[10]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO marketplace_posts(guild_id, post_id, owner_id, owner_display_name, trade_type, server_id, server_label, have, want, extra, channel_id, message_id, active, created_at_ms, closed_at_ms, closed_by_user_id)",
      ) ||
      normalizedSql.includes("insert into marketplace_posts")
    ) {
      await fetchStore("https://community-store/marketplace/post", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          id: String(args[1]),
          ownerId: String(args[2]),
          ownerDisplayName: String(args[3]),
          tradeType: String(args[4]),
          serverId: String(args[5]),
          serverLabel: String(args[6]),
          additionalChoices: parseJson(args[7], []),
          have: String(args[8]),
          want: String(args[9]),
          extra: String(args[10]),
          channelId: String(args[11]),
          messageId: args[12] ?? null,
          active: Number(args[13]) === 1,
          createdAtMs: Number(args[14]),
          closedAtMs: args[15] ?? null,
          closedByUserId: args[16] ?? null,
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "UPDATE marketplace_posts SET message_id = ? WHERE guild_id = ? AND post_id = ?",
      ) ||
      (normalizedSql.includes("update marketplace_posts") &&
        normalizedSql.includes("message_id") &&
        normalizedSql.includes("marketplace_posts.guild_id = ?") &&
        normalizedSql.includes("marketplace_posts.post_id = ?"))
    ) {
      await fetchStore("https://community-store/marketplace/post/message", {
        method: "POST",
        body: JSON.stringify({
          messageId: args[0],
          guildId: String(args[1]),
          postId: String(args[2]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "UPDATE marketplace_posts SET active = 0, closed_at_ms = ?, closed_by_user_id = ? WHERE guild_id = ? AND post_id = ? AND active = 1",
      ) ||
      (normalizedSql.includes("update marketplace_posts") &&
        normalizedSql.includes("active = ?") &&
        normalizedSql.includes("closed_at_ms") &&
        normalizedSql.includes("closed_by_user_id") &&
        normalizedSql.includes("marketplace_posts.guild_id = ?") &&
        normalizedSql.includes("marketplace_posts.post_id = ?"))
    ) {
      const offset = normalizedSql.includes("active = ?") ? 1 : 0;
      await fetchStore("https://community-store/marketplace/post/close", {
        method: "POST",
        body: JSON.stringify({
          closedAtMs: Number(args[0]),
          closedByUserId: String(args[1 + offset]),
          guildId: String(args[2 + offset]),
          postId: String(args[3 + offset]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO marketplace_trade_logs(guild_id, log_id, timestamp_ms, buyer_id, buyer_display_name, seller_id, post_id, channel_id, message_id, trade_type, server_label, dm_sent, dm_error, have, want)",
      )
    ) {
      await fetchStore("https://community-store/marketplace/log", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          id: String(args[1]),
          timestampMs: Number(args[2]),
          buyerId: String(args[3]),
          buyerDisplayName: String(args[4]),
          sellerId: String(args[5]),
          postId: String(args[6]),
          channelId: String(args[7]),
          messageId: args[8] ?? null,
          tradeType: String(args[9]),
          serverLabel: String(args[10]),
          dmSent: Number(args[11]) === 1,
          dmError: args[12] ?? null,
          have: String(args[13]),
          want: String(args[14]),
        }),
      });
      return { success: true };
    }

    if (sql.includes("DELETE FROM marketplace_trade_logs WHERE guild_id = ? AND log_id NOT IN")) {
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO lfg_configs(guild_id, notice_channel_id, notice_message_id, notification_role_id, counter_voice_channel_id, counter_display_format",
      ) ||
      normalizedSql.includes("insert into lfg_configs")
    ) {
      await fetchStore("https://community-store/lfg/config", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          noticeChannelId: args[1] ?? null,
          noticeMessageId: args[2] ?? null,
          notificationRoleId: args[3] ?? null,
          counterVoiceChannelId: args[4] ?? null,
          counterDisplayFormat: args[5] ?? "LFG ({count})",
          approvalFlowEnabled: args.length > 10 ? args[6] === 1 : false,
          approvalAuditChannelId: args.length > 10 ? (args[7] ?? null) : null,
          approvalVoiceCategoryId: args.length > 10 ? (args[8] ?? null) : null,
          expiryAction: args.length > 10 ? (args[9] ?? "close") : (args[6] ?? "close"),
          expiryDurationHours: Number(args.length > 10 ? (args[10] ?? 24) : (args[7] ?? 24)),
          serverOptions: parseJson(args.length > 10 ? args[11] : args[8], []),
          updatedAtMs: Number(args.length > 10 ? args[12] : args[9]),
        }),
      });
      return { success: true };
    }

    if (normalizedSql.includes("insert into lfg_applications")) {
      await fetchStore("https://community-store/lfg/application", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          postId: String(args[1]),
          applicantId: String(args[2]),
          applicantDisplayName: String(args[3]),
          message: String(args[4]),
          status: String(args[5]),
          createdAtMs: Number(args[6]),
          updatedAtMs: Number(args[7]),
          reviewedByUserId: args[8] ?? null,
          reviewedAtMs: args[9] ?? null,
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO lfg_posts(guild_id, post_id, owner_id, owner_display_name, server_id, server_label, when_play, looking_for, extra_info, channel_id, message_id, active, created_at_ms, expires_at_ms, reminder_sent_at_ms, renewed_at_ms, renewals_count, closed_at_ms, closed_by_user_id)",
      ) ||
      normalizedSql.includes("insert into lfg_posts")
    ) {
      await fetchStore("https://community-store/lfg/post", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          id: String(args[1]),
          ownerId: String(args[2]),
          ownerDisplayName: String(args[3]),
          serverId: String(args[4]),
          serverLabel: String(args[5]),
          whenPlay: String(args[6]),
          lookingFor: String(args[7]),
          extraInfo: String(args[8]),
          channelId: String(args[9]),
          messageId: args[10] ?? null,
          active: Number(args[11]) === 1,
          createdAtMs: Number(args[12]),
          expiresAtMs: args[13] ?? null,
          reminderSentAtMs: args[14] ?? null,
          renewedAtMs: args[15] ?? null,
          renewalsCount: Number(args[16] ?? 0),
          closedAtMs: args[17] ?? null,
          closedByUserId: args[18] ?? null,
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("UPDATE lfg_posts SET message_id = ? WHERE guild_id = ? AND post_id = ?") ||
      (normalizedSql.includes("update lfg_posts") &&
        normalizedSql.includes("message_id") &&
        normalizedSql.includes("lfg_posts.guild_id = ?") &&
        normalizedSql.includes("lfg_posts.post_id = ?"))
    ) {
      await fetchStore("https://community-store/lfg/post/message", {
        method: "POST",
        body: JSON.stringify({
          messageId: args[0],
          guildId: String(args[1]),
          postId: String(args[2]),
        }),
      });
      return { success: true };
    }

    if (
      (sql.includes("UPDATE lfg_posts") &&
        sql.includes("server_id = ?") &&
        sql.includes("renewals_count = ?") &&
        sql.includes("WHERE guild_id = ? AND post_id = ?")) ||
      (normalizedSql.includes("update lfg_posts") &&
        normalizedSql.includes("server_id") &&
        normalizedSql.includes("renewals_count") &&
        normalizedSql.includes("lfg_posts.guild_id = ?") &&
        normalizedSql.includes("lfg_posts.post_id = ?"))
    ) {
      await fetchStore("https://community-store/lfg/post/update", {
        method: "POST",
        body: JSON.stringify({
          serverId: String(args[0]),
          serverLabel: String(args[1]),
          whenPlay: String(args[2]),
          lookingFor: String(args[3]),
          extraInfo: String(args[4]),
          expiresAtMs: args[5] ?? null,
          reminderSentAtMs: args[6] ?? null,
          renewedAtMs: args[7] ?? null,
          renewalsCount: Number(args[8] ?? 0),
          active: Number(args[9]) === 1,
          closedAtMs: args[10] ?? null,
          closedByUserId: args[11] ?? null,
          guildId: String(args[12]),
          postId: String(args[13]),
        }),
      });
      return { success: true };
    }

    if (
      (sql.includes("UPDATE lfg_applications") &&
        sql.includes("reviewed_by_user_id = ?") &&
        sql.includes("WHERE guild_id = ? AND post_id = ? AND applicant_id = ?")) ||
      (normalizedSql.includes("update lfg_applications") &&
        normalizedSql.includes("reviewed_by_user_id") &&
        normalizedSql.includes("where") &&
        normalizedSql.includes("lfg_applications.guild_id = ?") &&
        normalizedSql.includes("lfg_applications.post_id = ?") &&
        normalizedSql.includes("lfg_applications.applicant_id = ?"))
    ) {
      await fetchStore("https://community-store/lfg/application/update", {
        method: "POST",
        body: JSON.stringify({
          applicantDisplayName: String(args[0]),
          message: String(args[1]),
          status: String(args[2]),
          updatedAtMs: Number(args[3]),
          reviewedByUserId: args[4] ?? null,
          reviewedAtMs: args[5] ?? null,
          guildId: String(args[6]),
          postId: String(args[7]),
          applicantId: String(args[8]),
        }),
      });
      return { success: true };
    }

    if (normalizedSql.includes("insert into lfg_voice_channels")) {
      await fetchStore("https://community-store/lfg/voice-channel", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          postId: String(args[1]),
          channelId: String(args[2]),
          createdAtMs: Number(args[3]),
          updatedAtMs: Number(args[4]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM lfg_voice_channels WHERE guild_id = ? AND post_id = ?") ||
      (normalizedSql.includes("delete from lfg_voice_channels") &&
        normalizedSql.includes("lfg_voice_channels.guild_id = ?") &&
        normalizedSql.includes("lfg_voice_channels.post_id = ?"))
    ) {
      await fetchStore("https://community-store/lfg/voice-channel/delete", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), postId: String(args[1]) }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "UPDATE lfg_posts SET active = 0, closed_at_ms = ?, closed_by_user_id = ? WHERE guild_id = ? AND post_id = ? AND active = 1",
      ) ||
      (normalizedSql.includes("update lfg_posts") &&
        normalizedSql.includes("active = ?") &&
        normalizedSql.includes("closed_at_ms") &&
        normalizedSql.includes("closed_by_user_id") &&
        normalizedSql.includes("lfg_posts.guild_id = ?") &&
        normalizedSql.includes("lfg_posts.post_id = ?"))
    ) {
      const offset = normalizedSql.includes("active = ?") ? 1 : 0;
      await fetchStore("https://community-store/lfg/post/close", {
        method: "POST",
        body: JSON.stringify({
          closedAtMs: Number(args[0]),
          closedByUserId: String(args[1 + offset]),
          guildId: String(args[2 + offset]),
          postId: String(args[3 + offset]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO timed_roles(guild_id, user_id, role_id, target_display_name, duration_input, expires_at_ms, created_at_ms, updated_at_ms)",
      ) ||
      normalizedSql.includes("insert into timed_roles")
    ) {
      await fetchStore("https://community-store/timed-role", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          userId: String(args[1]),
          roleId: String(args[2]),
          targetDisplayName: args[3] ?? null,
          durationInput: String(args[4]),
          expiresAtMs: Number(args[5]),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM timed_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?") ||
      (normalizedSql.includes("delete from timed_roles") &&
        normalizedSql.includes("timed_roles.guild_id = ?") &&
        normalizedSql.includes("timed_roles.user_id = ?") &&
        normalizedSql.includes("timed_roles.role_id = ?"))
    ) {
      const response = await fetchStore("https://community-store/timed-role/remove", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          userId: String(args[1]),
          roleId: String(args[2]),
        }),
      });
      if (!response.ok) {
        throw new Error(`Timed role rollback failed: ${response.status}`);
      }
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM new_member_timed_role_configs WHERE guild_id = ?") ||
      (normalizedSql.includes("delete from new_member_timed_role_configs") &&
        normalizedSql.includes("new_member_timed_role_configs.guild_id = ?"))
    ) {
      await fetchStore("https://community-store/timed-role/new-member-config", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), roles: [] }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO new_member_timed_role_configs(guild_id, role_id, duration_input, updated_at_ms)",
      ) ||
      normalizedSql.includes("insert into new_member_timed_role_configs")
    ) {
      await fetchStore("https://community-store/timed-role/new-member-config", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          roles: args[4]
            ? parseJson(args[4], [])
            : [{ roleId: String(args[1]), durationInput: String(args[2]) }],
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM manual_assignment_timed_role_configs WHERE guild_id = ?") ||
      (normalizedSql.includes("delete from manual_assignment_timed_role_configs") &&
        normalizedSql.includes("manual_assignment_timed_role_configs.guild_id = ?"))
    ) {
      await fetchStore("https://community-store/timed-role/manual-assignment-config", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), roles: [] }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO manual_assignment_timed_role_configs(guild_id, role_id, duration_input, updated_at_ms)",
      ) ||
      normalizedSql.includes("insert into manual_assignment_timed_role_configs")
    ) {
      await fetchStore("https://community-store/timed-role/manual-assignment-config", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          roles: args[4]
            ? parseJson(args[4], [])
            : [{ roleId: String(args[1]), durationInput: String(args[2]) }],
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("INSERT INTO steam_link_configs(") ||
      normalizedSql.includes("insert into steam_link_configs")
    ) {
      const columnMatch = sql.match(/insert\s+into\s+["`]?steam_link_configs["`]?\s*\(([^)]+)\)/i);
      const columns = (columnMatch?.[1] ?? "")
        .split(",")
        .map((column) => column.replaceAll('"', "").trim())
        .filter((column) => column.length > 0);
      const valuesByColumn = new Map<string, unknown>();
      for (let index = 0; index < columns.length; index += 1) {
        valuesByColumn.set(columns[index], args[index]);
      }

      const updateMatch = sql.match(/do\s+update\s+set\s+([\s\S]+)$/i);
      const updateColumns = (updateMatch?.[1] ?? "")
        .split(",")
        .map((entry) => entry.split("=")[0]?.replaceAll('"', "").trim())
        .filter((column) => typeof column === "string" && column.length > 0) as string[];
      const updateStart = columns.length;
      for (let index = 0; index < updateColumns.length; index += 1) {
        const valueIndex = updateStart + index;
        if (valueIndex >= args.length) break;
        valuesByColumn.set(updateColumns[index], args[valueIndex]);
      }

      const valueFor = (column: string, fallback: unknown = null) =>
        valuesByColumn.has(column) ? valuesByColumn.get(column) : fallback;

      await fetchStore("https://community-store/steam-link/config", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(valueFor("guild_id", args[0])),
          steamLinkedRoleId: valueFor("steam_linked_role_id", null),
          logChannelId: valueFor("log_channel_id", null),
          gameAppIds: parseJson(valueFor("game_app_ids_json", []), []),
          panelTitle: String(valueFor("panel_title", "Link your Steam account")),
          panelDescription: String(
            valueFor(
              "panel_description",
              "Click the button below to securely link your Discord account to your Steam account.",
            ),
          ),
          panelButtonLabel: String(valueFor("panel_button_label", "Link Steam")),
          panelButtonStyle: String(valueFor("panel_button_style", "Primary")),
          allowRelink: Number(valueFor("allow_relink", 1)) === 1,
          allowMultipleLinks: Number(valueFor("allow_multiple_links", 0)) === 1,
          whoisFields: parseJson(valueFor("whois_fields_json", []), []),
          updatedAtMs: Number(valueFor("updated_at_ms", 0)),
          customLinks: parseJson(valueFor("custom_links_json", []), []),
          panelChannelId: valueFor("panel_channel_id", null),
          panelMessageId: valueFor("panel_message_id", null),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO pending_steam_links(state, guild_id, user_id, created_at_ms) VALUES(?, ?, ?, ?)",
      )
    ) {
      await fetchStore("https://community-store/steam-link/pending", {
        method: "POST",
        body: JSON.stringify({
          state: String(args[0]),
          guildId: String(args[1]),
          userId: String(args[2]),
          createdAtMs: Number(args[3]),
        }),
      });
      return { success: true };
    }

    if (sql.includes("DELETE FROM pending_steam_links WHERE state = ?")) {
      await fetchStore("https://community-store/steam-link/pending/delete", {
        method: "POST",
        body: JSON.stringify({ state: String(args[0]) }),
      });
      return { success: true };
    }

    if (sql.includes("DELETE FROM pending_steam_links WHERE created_at_ms < ?")) {
      await fetchStore("https://community-store/steam-link/pending/clear-expired", {
        method: "POST",
        body: JSON.stringify({ nowMs: Number(args[0]) }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO steam_links(guild_id, user_id, steam_id64, linked_at_ms, manual, actioned_by_user_id, game_ownership_json)",
      ) ||
      normalizedSql.includes("insert into steam_links")
    ) {
      await fetchStore("https://community-store/steam-link/link", {
        method: "POST",
        body: JSON.stringify({
          guildId: String(args[0]),
          userId: String(args[1]),
          steamId64: String(args[2]),
          linkedAtMs: Number(args[3]),
          manual: Number(args[4]) === 1,
          actionedByUserId: args[5] ?? null,
          gameOwnership: parseJson(args[6], []),
        }),
      });
      return { success: true };
    }

    if (
      sql.includes("DELETE FROM steam_links WHERE guild_id = ? AND user_id = ?") ||
      (normalizedSql.includes("delete from steam_links") &&
        normalizedSql.includes("steam_links.guild_id = ?") &&
        normalizedSql.includes("steam_links.user_id = ?"))
    ) {
      await fetchStore("https://community-store/steam-link/link/delete", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), userId: String(args[1]) }),
      });
      return { success: true };
    }

    if (
      normalizedSql.includes("delete from steam_links") &&
      normalizedSql.includes("steam_links.guild_id = ?") &&
      normalizedSql.includes("steam_links.steam_id64 = ?")
    ) {
      await fetchStore("https://community-store/steam-link/link/delete-by-steamid", {
        method: "POST",
        body: JSON.stringify({ guildId: String(args[0]), steamId64: String(args[1]) }),
      });
      return { success: true };
    }

    if (
      sql.includes(
        "INSERT INTO guild_entitlements(guild_id, plan, updated_at_ms) VALUES(?, ?, ?)",
      ) ||
      normalizedSql.includes("insert into guild_entitlements")
    ) {
      options.guildEntitlementWrites?.push({
        guildId: String(args[0]),
        tier: args[1],
        updatedAtMs: sql.includes("plan") ? args[3] : args[2],
      });
      return { success: true };
    }

    return { success: true };
  }

  async function executeRaw(sql: string, args: unknown[]): Promise<Array<Record<string, unknown>>> {
    const normalizedSql = normalizeSql(sql);

    if (
      normalizedSql.includes("from steam_links") &&
      normalizedSql.includes("steam_links.guild_id = ?") &&
      !normalizedSql.includes("steam_links.user_id = ?") &&
      !normalizedSql.includes("steam_links.steam_id64 = ?")
    ) {
      return (await executeAll<Record<string, unknown>>(sql, args)).results;
    }

    if (
      normalizedSql.includes("from guild_notification_channels") ||
      normalizedSql.includes("from guild_rbac_settings") ||
      normalizedSql.includes("from ticket_panels") ||
      normalizedSql.includes("from marketplace_configs") ||
      (normalizedSql.includes("from marketplace_posts") && !normalizedSql.includes("order by")) ||
      normalizedSql.includes("from lfg_configs") ||
      (normalizedSql.includes("from lfg_posts") && !normalizedSql.includes("order by")) ||
      (normalizedSql.includes("from lfg_applications") &&
        normalizedSql.includes("lfg_applications.applicant_id = ?")) ||
      normalizedSql.includes("from lfg_voice_channels") ||
      (normalizedSql.includes("from timed_roles") && !normalizedSql.includes("order by")) ||
      normalizedSql.includes("from new_member_timed_role_configs") ||
      normalizedSql.includes("from manual_assignment_timed_role_configs") ||
      normalizedSql.includes("from steam_link_configs") ||
      normalizedSql.includes("from pending_steam_links") ||
      normalizedSql.includes("from steam_links") ||
      normalizedSql.includes("from guild_entitlements")
    ) {
      const row = await execute<Record<string, unknown>>(sql, args);
      return row ? [row] : [];
    }

    return (await executeAll<Record<string, unknown>>(sql, args)).results;
  }

  async function readBlocklistConfig() {
    if (cachedBlocklistConfig) {
      return cachedBlocklistConfig;
    }

    if (blocklistConfigPromise) {
      return blocklistConfigPromise;
    }

    blocklistConfigPromise = (async () => {
      const response = await fetchStore("https://community-store/config");
      cachedBlocklistConfig = mergeBlocklistOverrides((await response.json()) as any);
      return cachedBlocklistConfig ?? { guilds: {}, botUserId: "bot-user-id" };
    })();
    try {
      return await blocklistConfigPromise;
    } finally {
      blocklistConfigPromise = null;
    }
  }

  function invalidateBlocklistConfig(): void {
    cachedBlocklistConfig = null;
  }

  function applyBlocklistOverride(guildId: string, emoji: string, action: "add" | "remove"): void {
    const next = blocklistOverrides.get(guildId) ?? getGuildOverrideSeed(guildId);
    const emojis = new Set(next.emojis);
    if (action === "add") {
      emojis.add(emoji);
    } else {
      emojis.delete(emoji);
    }
    blocklistOverrides.set(guildId, {
      enabled: next.enabled,
      emojis: [...emojis],
    });
  }

  function getGuildOverrideSeed(guildId: string): { enabled: boolean; emojis: string[] } {
    const guilds = (cachedBlocklistConfig?.guilds ?? {}) as Record<string, any>;
    const existing = guilds[guildId];
    return {
      enabled: existing?.enabled !== false,
      emojis: [...(existing?.emojis ?? [])],
    };
  }

  function mergeBlocklistOverrides(config: any): any {
    const guilds = { ...config?.guilds };
    for (const [guildId, override] of blocklistOverrides.entries()) {
      guilds[guildId] = {
        enabled: override.enabled,
        emojis: [...override.emojis],
      };
    }
    return {
      guilds,
      botUserId: config?.botUserId ?? "bot-user-id",
    };
  }

  async function fetchStore(input: string, init?: RequestInit): Promise<Response> {
    if (options.moderationFetch) {
      return await options.moderationFetch(input, init);
    }

    return defaultResponse(input, init);
  }
}

function defaultResponse(input: string, init?: RequestInit): Response {
  const url = new URL(input);
  const method = init?.method ?? "GET";

  if (method === "GET" && url.pathname === "/config") {
    return Response.json({ guilds: {}, botUserId: "bot-user-id" });
  }
  if (method === "GET" && url.pathname === "/guild-rbac/admin-role") {
    return Response.json({ guildAdminRoleId: null });
  }
  if (method === "GET" && url.pathname === "/guild-notification-channel") {
    return Response.json({ notificationChannelId: null });
  }
  if (method === "GET" && url.pathname === "/timed-roles") {
    return Response.json([]);
  }
  if (method === "GET" && url.pathname === "/timed-role/new-member-config") {
    return Response.json({ roles: [] });
  }
  if (method === "GET" && url.pathname === "/timed-role/manual-assignment-config") {
    return Response.json({ roles: [] });
  }
  if (method === "GET" && url.pathname === "/ticket-panel") {
    return Response.json(null);
  }
  if (method === "GET" && url.pathname.startsWith("/marketplace/")) {
    return Response.json(
      url.pathname.endsWith("/posts") || url.pathname.endsWith("/logs") ? [] : null,
    );
  }
  if (method === "GET" && url.pathname.startsWith("/lfg/")) {
    return Response.json(
      url.pathname.endsWith("/posts") || url.pathname.endsWith("/applications") ? [] : null,
    );
  }
  if (method === "GET" && url.pathname.startsWith("/steam-link/")) {
    return Response.json(url.pathname.endsWith("/links") ? [] : null);
  }
  if (method === "POST" && url.pathname === "/ticket-number/next") {
    return Response.json({ ticketNumber: 1 });
  }

  return Response.json({ ok: true });
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapTimedRole(role: any) {
  return {
    guild_id: role.guildId,
    user_id: role.userId,
    role_id: role.roleId,
    target_display_name: role.targetDisplayName ?? null,
    duration_input: role.durationInput,
    expires_at_ms: role.expiresAtMs,
    created_at_ms: role.createdAtMs ?? role.expiresAtMs ?? 0,
    updated_at_ms: role.updatedAtMs ?? role.expiresAtMs ?? 0,
  };
}

function mapMarketplacePost(post: any) {
  return {
    guild_id: post.guildId,
    post_id: post.id,
    owner_id: post.ownerId,
    owner_display_name: post.ownerDisplayName,
    trade_type: post.tradeType,
    server_id: post.serverId,
    server_label: post.serverLabel,
    additional_choices_json: JSON.stringify(post.additionalChoices ?? []),
    have: post.have,
    want: post.want,
    extra: post.extra,
    channel_id: post.channelId,
    message_id: post.messageId ?? null,
    active: post.active ? 1 : 0,
    created_at_ms: post.createdAtMs,
    closed_at_ms: post.closedAtMs ?? null,
    closed_by_user_id: post.closedByUserId ?? null,
  };
}

function mapMarketplaceLog(log: any) {
  return {
    guild_id: log.guildId,
    log_id: log.id,
    timestamp_ms: log.timestampMs,
    buyer_id: log.buyerId,
    buyer_display_name: log.buyerDisplayName,
    seller_id: log.sellerId,
    post_id: log.postId,
    channel_id: log.channelId,
    message_id: log.messageId ?? null,
    trade_type: log.tradeType,
    server_label: log.serverLabel,
    dm_sent: log.dmSent ? 1 : 0,
    dm_error: log.dmError ?? null,
    have: log.have,
    want: log.want,
  };
}

function mapLfgPost(post: any) {
  return {
    guild_id: post.guildId,
    post_id: post.id,
    owner_id: post.ownerId,
    owner_display_name: post.ownerDisplayName,
    server_id: post.serverId,
    server_label: post.serverLabel,
    when_play: post.whenPlay,
    looking_for: post.lookingFor,
    extra_info: post.extraInfo,
    channel_id: post.channelId,
    message_id: post.messageId ?? null,
    active: post.active ? 1 : 0,
    created_at_ms: post.createdAtMs,
    expires_at_ms: post.expiresAtMs ?? null,
    reminder_sent_at_ms: post.reminderSentAtMs ?? null,
    renewed_at_ms: post.renewedAtMs ?? null,
    renewals_count: post.renewalsCount ?? 0,
    closed_at_ms: post.closedAtMs ?? null,
    closed_by_user_id: post.closedByUserId ?? null,
    scope: post.scope ?? "public",
    clan_id: post.clanId ?? null,
    clan_tag: post.clanTag ?? null,
    persistent_voice_channel_id: post.persistentVoiceChannelId ?? null,
  };
}

function mapLfgApplication(application: any) {
  return {
    guild_id: application.guildId,
    post_id: application.postId,
    applicant_id: application.applicantId,
    applicant_display_name: application.applicantDisplayName,
    message: application.message,
    status: application.status,
    created_at_ms: application.createdAtMs,
    updated_at_ms: application.updatedAtMs,
    reviewed_by_user_id: application.reviewedByUserId ?? null,
    reviewed_at_ms: application.reviewedAtMs ?? null,
  };
}

function mapLfgVoiceChannel(channel: any) {
  return {
    guild_id: channel.guildId,
    post_id: channel.postId,
    channel_id: channel.channelId,
    created_at_ms: channel.createdAtMs,
    updated_at_ms: channel.updatedAtMs,
  };
}

function mapSteamLink(link: any) {
  return {
    guild_id: link.guildId,
    user_id: link.userId,
    steam_id64: link.steamId64,
    linked_at_ms: link.linkedAtMs,
    manual: link.manual ? 1 : 0,
    actioned_by_user_id: link.actionedByUserId ?? null,
    game_ownership_json: JSON.stringify(link.gameOwnership ?? []),
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/["`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function rowToSelectedValues(sql: string, row: Record<string, unknown>): unknown[] {
  const normalizedSql = normalizeSql(sql);

  if (normalizedSql.includes("from lfg_configs")) {
    return [
      row.guild_id,
      row.enabled ?? 1,
      row.notice_channel_id,
      row.notice_message_id,
      row.notification_role_id,
      row.notice_color,
      row.counter_voice_channel_id,
      row.counter_display_format,
      row.approval_flow_enabled,
      row.approval_audit_channel_id,
      row.approval_voice_category_id,
      row.expiry_action,
      row.expiry_duration_hours,
      row.server_options_json,
      row.updated_at_ms,
    ];
  }

  if (normalizedSql.includes("from lfg_applications")) {
    return [
      row.guild_id,
      row.post_id,
      row.applicant_id,
      row.applicant_display_name,
      row.message,
      row.status,
      row.created_at_ms,
      row.updated_at_ms,
      row.reviewed_by_user_id,
      row.reviewed_at_ms,
    ];
  }

  if (normalizedSql.includes("from lfg_voice_channels")) {
    return [row.guild_id, row.post_id, row.channel_id, row.created_at_ms, row.updated_at_ms];
  }

  if (normalizedSql.includes("from guild_notification_channels")) {
    return [row.guild_id, row.feature, row.notification_channel_id];
  }

  if (normalizedSql.includes("from guild_rbac_settings")) {
    return [row.guild_id, row.guild_admin_role_id];
  }

  if (normalizedSql.includes("from ticket_panels")) {
    return [
      row.guild_id,
      row.panel_id ?? "main",
      row.panel_name ?? "Main panel",
      row.panel_channel_id,
      row.category_channel_id,
      row.transcript_channel_id,
      row.panel_message_id,
      row.ticket_types_json,
      row.ticket_creation_limit,
      row.ticket_limit_rejection_message,
      row.enable_ticket_claiming,
    ];
  }

  if (normalizedSql.includes("from marketplace_configs")) {
    return [
      row.guild_id,
      row.enabled ?? 1,
      row.notice_channel_id,
      row.notice_message_id,
      row.log_channel_id,
      row.server_options_json,
      row.notice_embed_json,
      row.server_choice_enabled,
      row.additional_choices_enabled,
      row.additional_choices_json,
      row.flow_updated_at_ms,
      row.updated_at_ms,
    ];
  }

  if (normalizedSql.includes("from marketplace_posts")) {
    return [
      row.guild_id,
      row.post_id,
      row.owner_id,
      row.owner_display_name,
      row.trade_type,
      row.server_id,
      row.server_label,
      row.additional_choices_json,
      row.have,
      row.want,
      row.extra,
      row.channel_id,
      row.message_id,
      row.active,
      row.created_at_ms,
      row.closed_at_ms,
      row.closed_by_user_id,
      row.scope,
      row.clan_id,
      row.clan_tag,
      row.persistent_voice_channel_id,
    ];
  }

  if (normalizedSql.includes("from lfg_posts")) {
    return [
      row.guild_id,
      row.post_id,
      row.owner_id,
      row.owner_display_name,
      row.server_id,
      row.server_label,
      row.when_play,
      row.looking_for,
      row.extra_info,
      row.channel_id,
      row.message_id,
      row.active,
      row.created_at_ms,
      row.expires_at_ms,
      row.reminder_sent_at_ms,
      row.renewed_at_ms,
      row.renewals_count,
      row.closed_at_ms,
      row.closed_by_user_id,
    ];
  }

  if (normalizedSql.includes("from timed_roles")) {
    return [
      row.guild_id,
      row.user_id,
      row.role_id,
      row.target_display_name,
      row.duration_input,
      row.expires_at_ms,
      row.created_at_ms,
      row.updated_at_ms,
    ];
  }

  if (
    normalizedSql.includes("from new_member_timed_role_configs") ||
    normalizedSql.includes("from manual_assignment_timed_role_configs")
  ) {
    return [row.guild_id, row.role_id, row.duration_input, row.updated_at_ms];
  }

  if (normalizedSql.includes("from steam_link_configs")) {
    return selectValues(normalizedSql, {
      guild_id: row.guild_id,
      steam_linked_role_id: row.steam_linked_role_id,
      log_channel_id: row.log_channel_id,
      game_app_ids_json: row.game_app_ids_json,
      panel_title: row.panel_title,
      panel_description: row.panel_description,
      panel_button_label: row.panel_button_label,
      panel_button_style: row.panel_button_style,
      allow_relink: row.allow_relink,
      whois_fields_json: row.whois_fields_json,
      updated_at_ms: row.updated_at_ms,
      custom_links_json: row.custom_links_json,
      panel_channel_id: row.panel_channel_id,
      panel_message_id: row.panel_message_id,
    });
  }

  if (normalizedSql.includes("from steam_links")) {
    return [
      row.guild_id,
      row.user_id,
      row.steam_id64,
      row.linked_at_ms,
      row.manual,
      row.actioned_by_user_id,
      row.game_ownership_json,
    ];
  }

  if (normalizedSql.includes("from guild_entitlements")) {
    return [row.guild_id, row.tier, row.plan, row.updated_at_ms];
  }

  return Object.values(row);
}

function selectValues(normalizedSql: string, columns: Record<string, unknown>): unknown[] {
  const selectClause = normalizedSql.split(" from ")[0]?.replace(/^select /, "") ?? "";
  return Object.entries(columns)
    .filter(([column]) => selectClause.includes(column))
    .map(([, value]) => value);
}
