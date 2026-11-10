import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { __testing as runtimeTesting } from "../src/node/postgres-runtime";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { InMemoryObjectStore } from "./support/in-memory-object-store";
import { moderationConfigSchema } from "../src/community-tools/config";
import { ReactionRoleService } from "../src/services/reaction-role-service";
import type { ReactionRoleDiscord } from "../src/discord/reaction-roles";
import type { GuildPermissionContext } from "../src/runtime/admin-permissions";
import { ReputationService } from "../src/reputation/service";
import { defaultReputationConfig } from "../src/reputation/types";
import { createReputationDiscord } from "../src/reputation/discord";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test("portable environment reuses the Discord OAuth client ID as the application ID", () => {
  const env = runtimeTesting.createPortableEnv(
    {
      NODE_ENV: "test",
      DISCORD_PUBLIC_KEY: "a".repeat(64),
      DISCORD_BOT_TOKEN: "portable-token",
      BOT_USER_ID: "123456789012345678",
      DISCORD_OAUTH_CLIENT_ID: "987654321098765432",
    },
    {} as D1Database,
    {} as never,
  );

  assert.equal(env.DISCORD_APPLICATION_ID, "987654321098765432");
});

test(
  "portable application context executes every bridged store's critical empty-state read",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async (t) => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "8",
    });
    try {
      await resetAndMigrate(database);
      const d1 = createPostgresD1CompatibilityDatabase(database);
      const jobs = createPostgresJobQueue(database);
      const queues = runtimeTesting.createQueueBindings(database, jobs);
      const environment = {
        NODE_ENV: "test",
        STAGING_MODE: "true",
        DISCORD_PUBLIC_KEY: "a".repeat(64),
        DISCORD_BOT_TOKEN: "application-context-token",
        BOT_USER_ID: "123456789012345678",
      };
      const env = runtimeTesting.createPortableEnv(environment, d1, queues);
      const { app } = runtimeTesting.createPortableContext({
        environment,
        env,
        database,
        d1,
        objects: new InMemoryObjectStore(),
      });
      const guildId = "empty-guild";
      const checks: Array<[string, () => Promise<unknown>]> = [
        ["blocklist", () => app.stores.blocklist.readConfig()],
        ["timed roles", () => app.stores.timedRoles.listTimedRolesByGuild(guildId)],
        ["tickets", () => app.stores.tickets.readTicketPanelConfig(guildId)],
        ["marketplace", () => app.stores.marketplace.readMarketplaceConfig(guildId)],
        ["events", () => app.stores.events.listEvents(guildId)],
        ["LFG", () => app.stores.lfg.readLfgConfig(guildId)],
        ["clans", () => app.stores.clans!.readConfig(guildId)],
        ["webhook proxy", () => app.stores.webhookProxy.listWebhookProxyConfigs(guildId)],
        ["player count", () => app.stores.playerCount.listPlayerCountServers(guildId)],
        ["platform links", () => app.stores.platformLink.listPlatformLinks(guildId)],
        ["effective plan", () => app.stores.effectiveGuildPlans.readEffectiveGuildPlan(guildId)],
        ["object accounting", () => app.stores.guildR2Objects.getGuildUsageBytes(guildId)],
        ["reaction limits", () => app.stores.reactionLimits.readReactionLimitConfig(guildId)],
        ["evidence vault", () => app.stores.evidenceVault.listRecords(guildId)],
        ["image rules", () => app.stores.imageRules.readConfig(guildId)],
        ["bot defense", () => app.stores.botDefense.readConfig(guildId)],
        ["mention protection", () => app.stores.mentionProtection.readConfig(guildId)],
        ["known guilds", () => app.stores.knownGuilds.readKnownGuild(guildId)],
        ["user preferences", () => app.stores.userPreferences.readUserPreferences("empty-user")],
        ["audit log", () => app.stores.guildAuditLog.readConfig(guildId)],
        ["white-label bots", () => app.stores.whiteLabelBots.listActiveWhiteLabelBots()],
        ["ban cases", () => app.stores.banCases.readConfig(guildId)],
        ["member verification", () => app.stores.memberVerification.readConfig(guildId)],
        ["managed messages", () => app.stores.managedMessages.listByGuild(guildId)],
        ["message templates", () => app.stores.messageTemplates!.listByGuild(guildId)],
        [
          "service suspension",
          () => app.stores.guildServiceSuspensions!.readActiveSuspension(guildId),
        ],
        ["feature setup", () => app.stores.featureSetup!.readActiveRun(guildId, "tickets")],
        ["suggestions", () => app.stores.suggestions.readConfig(guildId)],
        [
          "operational incidents",
          () =>
            app.stores.operationalIncidents.listByGuild({
              guildId,
              status: "open",
              limit: 10,
              before: null,
            }),
        ],
        ["admin feedback", () => app.stores.adminFeedback.countRecentByReporter("empty-user", 0)],
        [
          "analytics preference",
          () => app.stores.productAnalyticsPreferences!.readEnabled(guildId),
        ],
        [
          "configuration revisions",
          () =>
            app.stores.configurationRevisions!.readHead({
              guildId,
              feature: "tickets",
              resourceKey: "main",
            }),
        ],
        ["Discord account", () => app.discordAccounts!.readDiscordAccessToken("empty-user")],
        ["workspace", () => app.workspaceStore!.listGuildsForWorkspace("empty-workspace")],
        [
          "transcript capability",
          () =>
            app.ticketTranscriptCapabilities!.authorize({
              guildId,
              channelId: "empty-channel",
              accessToken: "empty-token",
              nowMs: 1,
            }),
        ],
      ];
      for (const [name, operation] of checks) {
        await t.test(name, async () => {
          await operation();
        });
      }

      await t.test(
        "self-hosted context enables core capabilities without billing writes",
        async () => {
          const selfHostedEnvironment = {
            ...environment,
            HAF_DEPLOYMENT_MODE: "self-hosted",
            BETTER_AUTH_URL: "https://independent.example",
            BETTER_AUTH_SECRET: "self-hosted-test-auth-secret-at-least-32-characters",
            DISCORD_OAUTH_CLIENT_ID: "987654321098765432",
            DISCORD_OAUTH_CLIENT_SECRET: "self-hosted-test-oauth-secret",
            SELF_HOSTED_OPERATOR_NAME: "Independent Operators",
            SELF_HOSTED_PRIVACY_URL: "https://policies.example/privacy",
          };
          const selfHosted = runtimeTesting.createPortableContext({
            environment: selfHostedEnvironment,
            env: runtimeTesting.createPortableEnv(selfHostedEnvironment, d1, queues),
            database,
            d1,
            objects: new InMemoryObjectStore(),
          });
          assert.equal(selfHosted.app.selfHostedSite?.operatorName, "Independent Operators");
          assert.equal(selfHosted.app.selfHostedSite?.publicUrl, "https://independent.example");
          assert.equal(
            selfHosted.app.selfHostedSite?.privacyUrl,
            "https://policies.example/privacy",
          );
          assert.equal(app.selfHostedSite, undefined);
          assert.equal(
            (await selfHosted.app.stores.guildEntitlements.readGuildEntitlement(guildId)).tier,
            "premium_plus",
          );
          assert.equal(
            (await app.stores.guildEntitlements.readGuildEntitlement(guildId)).tier,
            "free",
          );
          const rows = await database.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM guild_entitlements",
          );
          assert.equal(rows[0].count, "0");
        },
      );

      await t.test(
        "Chat Moderation staff roles cannot be configured or delivered through self-service role features",
        async () => {
          const rolePolicy = app.stores.reactionRoles!;
          const context: GuildPermissionContext = {
            guildId: "100",
            botUserId: "900",
            member: { roles: ["400"] },
            channels: [{ id: "200", name: "roles", type: 0, parent_id: null, position: 0 }],
            roles: [
              {
                id: "100",
                name: "@everyone",
                position: 0,
                permissions: String((1n << 10n) | (1n << 11n) | (1n << 6n) | (1n << 16n)),
              },
              { id: "400", name: "HAF", position: 10, permissions: String(1n << 28n) },
              { id: "300", name: "Selectable role", position: 1, permissions: "0" },
              { id: "301", name: "Reward role", position: 2, permissions: "0" },
            ],
          };
          let grants = 0;
          const discord: ReactionRoleDiscord = {
            loadPermissionContext: async () => context,
            createMessage: async () => ({ id: "500", channel_id: "200", content: "" }),
            editMessage: async () => ({ id: "500", channel_id: "200", content: "" }),
            deleteMessage: async () => {},
            seedReaction: async () => {},
            clearReaction: async () => {},
            fetchMember: async () => ({ user: { id: "800" }, roles: [] }),
            hasReaction: async () => true,
            addRole: async () => {
              grants++;
            },
            removeRole: async () => {},
          };
          const roles = new ReactionRoleService(rolePolicy, discord, "900");
          const settings = {
            channelId: "200",
            title: "Choose a game",
            description: "Choose your game role.",
            options: [{ emoji: "🟢", roleId: "300", label: "Game" }],
          };
          await roles.save("100", settings);
          await roles.publish("100");
          const reputationStore = (await app.reputationServiceForGuild!("100")).store;
          const reputationSettings = {
            ...defaultReputationConfig("100"),
            enabled: true,
            rewards: [{ threshold: 1, roleId: "301" }],
          };
          await reputationStore.saveConfig("100", reputationSettings, 0);
          await reputationStore.award({
            guildId: "100",
            interactionId: "501",
            nowMs: Date.now(),
            reason: null,
            giver: { userId: "801", displayName: "Giver", bot: false, roleIds: [] },
            recipient: { userId: "800", displayName: "Recipient", bot: false, roleIds: [] },
          });
          await app.communityTools!.store.save(
            "100",
            "moderation",
            moderationConfigSchema.parse({ enabled: true, moderatorRoleIds: ["300", "301"] }),
            0,
          );
          assert.equal(
            (await rolePolicy.readRestrictedRoleIds("100", { excludeReputationRewards: true })).has(
              "301",
            ),
            true,
          );
          assert.equal((await rolePolicy.readRestrictedRoleIds("101")).has("300"), false);
          await assert.rejects(() => roles.save("100", settings), /protected|staff|verification/);
          await roles.reconcile({
            guild_id: "100",
            channel_id: "200",
            message_id: "500",
            user_id: "800",
            emoji: { name: "🟢", id: null },
          });
          const reputation = new ReputationService(reputationStore, {
            ...createReputationDiscord({ token: "test-token", botUserId: "900", rolePolicy }),
            loadPermissionContext: async () => context,
            fetchMember: async (_guild, userId) => ({
              userId,
              displayName: "Member",
              bot: false,
              roleIds: [],
            }),
            addRole: async () => {
              grants++;
            },
          });
          await assert.rejects(
            () => reputation.saveConfig("100", reputationSettings, 1),
            /protected|staff|verification/,
          );
          assert.deepEqual(await reputation.processRewards(20, "100"), {
            delivered: 0,
            deferred: 1,
          });
          assert.equal(
            grants,
            0,
            "zero-permission staff roles remain protected after prior panels and rewards were configured",
          );
        },
      );

      assert.equal(
        await app.stores.oneTimeTokens.consume({
          nonce: "one-time-nonce",
          expiresAtMs: 1_000,
          consumedAtMs: 1,
        }),
        true,
      );
      assert.equal(
        await app.stores.oneTimeTokens.consume({
          nonce: "one-time-nonce",
          expiresAtMs: 1_000,
          consumedAtMs: 2,
        }),
        false,
      );
    } finally {
      await database.close();
    }
  },
);

async function resetAndMigrate(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await applyPostgresMigrations(
    database,
    await readPostgresMigrations(resolve("migrations/postgres")),
  );
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
