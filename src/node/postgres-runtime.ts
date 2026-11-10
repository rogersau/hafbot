import type { QueueProducer, QueueBatch } from "../runtime/queue-types";
import {
  createGameAccessRuntime,
  COMMERCE_GAME_QUEUE_NAME,
  handleCommerceGameQueueBatch,
} from "../runtime/commerce/game-access-runtime";
import { createPostgresGameAccessStore } from "../runtime/postgres/postgres-game-access-store";
import { createCloudflareCommerceBuyerRuntime } from "../runtime/commerce/cloudflare-commerce-runtime";
import {
  createPostgresObservationStore,
  createAttendanceObservationRuntime,
} from "../runtime/attendance-observation-runtime";
import { WardogsService } from "../wardogs/service";
import { wardogsNetworkPolicy } from "../wardogs/config";
import {
  createPostgresWardogsStore,
  createPostgresBanEnforcementStore,
} from "../runtime/postgres/postgres-wardogs-store";
import { resolve } from "node:path";

import type { Env } from "../env";
import {
  createEnvironmentProductAnalytics,
  withGuildAnalyticsPreference,
  withProductAnalyticsWaitUntil,
} from "../product-analytics";
import { createWebhookCredentialKeyRing } from "../security/webhook-credentials";
import { createCloudflareWebhookCredentialStore } from "../security/webhook-credentials/cloudflare-store";
import { WebhookCredentialService } from "../security/webhook-credentials/store";
import { SteamBanLookupService } from "../services/steam-ban-lookup-service";
import { createRuntimeApp } from "../runtime/app";
import { createCommunityToolsRuntime } from "../community-tools/runtime";
import { createPostgresReputationStore } from "../reputation/store";
import { createReputationRuntime } from "../reputation/runtime";
import { createPostgresBanAppealStore } from "../moderation-appeals/store";
import { createBanAppealRuntime } from "../moderation-appeals/runtime";
import { createCloudflareContext, type RuntimeAppContext } from "../runtime/cloudflare-context";
import type { GuildR2QuotaStore } from "../runtime/contracts";
import type { GatewayEventStores } from "../runtime/gateway-events/contracts";
import {
  deliverGatewayEventQueueBatch,
  GATEWAY_EVENT_QUEUE_NAME,
} from "../runtime/gateway-event-queue-consumer";
import {
  findGuildIdInValue,
  GuildServicePolicy,
  isGatewayGuildLifecycleEvent,
} from "../runtime/guild-service-policy";
import type { ObjectStore } from "../runtime/object-store";
import {
  createPortableEvidenceVaultBlobStore,
  createPortablePublicManagedMediaStore,
  createPortableTicketTranscriptBlobStore,
} from "../runtime/portable-blob-stores";
import type { QueueDeliveryOutcome } from "../runtime/queue-delivery";
import { deliverR2QuotaQueueBatch, R2_QUOTA_QUEUE_NAME } from "../runtime/r2-quota-queue-consumer";
import { createServiceFactory } from "../runtime/service-factory";
import {
  deliverSteamBanLookupQueueBatch,
  STEAM_BAN_LOOKUP_QUEUE_NAME,
} from "../runtime/steam-ban-lookup-queue-consumer";
import {
  deliverTicketRecoveryQueueBatch,
  TICKET_RECOVERY_QUEUE_NAME,
} from "../runtime/ticket-recovery-queue-consumer";
import {
  handleServerLevelQueueBatch,
  maintainServerLevels,
  SERVER_LEVELS_QUEUE_NAME,
} from "../runtime/server-level-queue-consumer";
import {
  deliverWebhookProxyDeliveryQueueBatch,
  WEBHOOK_PROXY_DELIVERY_QUEUE_NAME,
} from "../runtime/webhook-proxy-delivery-queue-consumer";
import {
  handleBillingSyncQueueBatch,
  BILLING_SYNC_QUEUE_NAME,
} from "../runtime/billing/cloudflare-billing-runtime";
import {
  handleBillingDeliveryQueueBatch,
  BILLING_DELIVERY_QUEUE_NAME,
} from "../runtime/billing/cloudflare-delivery-runtime";
import {
  handleCommerceSyncQueueBatch,
  COMMERCE_SYNC_QUEUE_NAME,
} from "../runtime/commerce/cloudflare-commerce-runtime";
import {
  handleCommerceRoleQueueBatch,
  COMMERCE_ROLE_QUEUE_NAME,
} from "../runtime/commerce/cloudflare-paid-role-runtime";
import { createPostgresAppConfigStore } from "../runtime/postgres/postgres-app-config-store";
import { createPostgresBlocklistStore } from "../runtime/postgres/postgres-blocklist-store";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../runtime/postgres/postgres-capability";
import { createPostgresCustomerAuth } from "../runtime/postgres/postgres-customer-auth";
import { createPostgresD1CompatibilityDatabase } from "../runtime/postgres/postgres-d1-compat";
import { createPostgresGatewayStateStore } from "../runtime/postgres/postgres-gateway-store";
import { createPostgresGuildEntitlementStore } from "../runtime/postgres/postgres-guild-entitlement-store";
import { createPostgresGuildObjectStore } from "../runtime/postgres/postgres-guild-object-store";
import { createPostgresGuildRbacStore } from "../runtime/postgres/postgres-guild-rbac-store";
import { createPostgresGuildServiceSuspensionStore } from "../runtime/postgres/postgres-guild-service-suspension-store";
import {
  createPostgresJobQueue,
  type PortableQueueName,
} from "../runtime/postgres/postgres-job-queue";
import {
  createPostgresJobWorker,
  type PostgresJobHandler,
} from "../runtime/postgres/postgres-job-worker";
import { createPostgresKnownGuildStore } from "../runtime/postgres/postgres-known-guild-store";
import { createPostgresLeaseStore } from "../runtime/postgres/postgres-lease-store";
import {
  applyPostgresMigrations,
  checkPostgresMigrations,
  readPostgresMigrations,
} from "../runtime/postgres/postgres-migrations";
import { createPostgresPlayerCountStreakReportedStore } from "../runtime/postgres/postgres-player-count-streak-store";
import { createPostgresProductAnalyticsPreferenceStore } from "../runtime/postgres/postgres-product-analytics-preference-store";
import { createPostgresQueueBinding } from "../runtime/postgres/postgres-queue-binding";
import { createPostgresReactionLimitStore } from "../runtime/postgres/postgres-reaction-limit-store";
import { createPostgresScheduler } from "../runtime/postgres/postgres-scheduler";
import { createPostgresSteamBanLookupStore } from "../runtime/postgres/postgres-steam-ban-lookup-store";
import { createPostgresUserPreferencesStore } from "../runtime/postgres/postgres-user-preferences-store";
import { createPostgresWebhookIngressGuard } from "../runtime/postgres/postgres-webhook-ingress-guard";
import { createPostgresWorkspaceStore } from "../runtime/postgres/postgres-workspace-store";
import { createAzureBlobObjectStoreFromEnvironment } from "./azure-blob-object-store";
import type { CreateNodeRuntimeContext, ManagedNodeComponent, NodeRuntime } from "./host";
import { createInMemoryWebhookIngressGuard } from "./in-memory-webhook-ingress-guard";
import { createLayeredWebhookIngressGuard } from "./layered-webhook-ingress-guard";
import { createMemoryKvNamespace } from "./memory-kv-namespace";
import { reconcilePortableObjectsPage } from "./portable-object-reconciliation";
import { createPostgresGatewaySupervisor } from "./postgres-gateway-supervisor";
import { createS3ObjectStoreFromEnvironment } from "./s3-object-store";
import { readSelfHostedSite } from "../runtime/self-hosted-site";

export interface PostgresNodeRuntimeOptions {
  environment: Record<string, string | undefined>;
  lifecycle: CreateNodeRuntimeContext;
  migrationsDirectory?: string;
  objects?: ObjectStore | null;
  discordE2eActors?: Env["discordE2eActors"];
}

export async function createPostgresNodeRuntime(
  options: PostgresNodeRuntimeOptions,
): Promise<NodeRuntime> {
  const environment = options.environment;
  readSelfHostedSite(environment);
  const database = createPostgresDatabaseCapabilityFromEnvironment(environment);
  let httpDatabase: PostgresDatabaseCapability | undefined;
  try {
    const migrations = await readPostgresMigrations(
      options.migrationsDirectory ?? resolve("migrations/postgres"),
    );
    const migrationStatus = readBoolean(environment, "HAF_RUN_MIGRATIONS", false)
      ? await applyPostgresMigrations(database, migrations)
      : await checkPostgresMigrations(database, migrations);
    if (migrationStatus.pending.length > 0) {
      throw new Error(
        `PostgreSQL has ${migrationStatus.pending.length} pending migration(s); set HAF_RUN_MIGRATIONS=true for the release migration step.`,
      );
    }

    const maintenanceMode = readBoolean(environment, "HAF_MAINTENANCE_MODE", false);
    const objectStore =
      options.objects === undefined ? createObjectStore(environment) : options.objects;
    const d1 = createPostgresD1CompatibilityDatabase(database);
    const jobs = createPostgresJobQueue(database);
    const queueBindings = createQueueBindings(database, jobs);
    const env = {
      ...createPortableEnv(environment, d1, queueBindings),
      discordE2eActors: options.discordE2eActors,
    };
    const context = createPortableContext({
      environment,
      env,
      database,
      d1,
      objects: objectStore,
    });
    httpDatabase = maintenanceMode
      ? createPostgresDatabaseCapabilityFromEnvironment(environment, { readOnly: true })
      : database;
    if (httpDatabase !== database && !(await httpDatabase.isReady())) {
      throw new Error("The read-only PostgreSQL HTTP pool is unavailable.");
    }
    const httpContext = maintenanceMode
      ? createHttpMaintenanceContext({ environment, database: httpDatabase, objects: objectStore })
      : context;
    const objects = context.objects;
    const gatewayEnabled = readBoolean(environment, "HAF_GATEWAY_ENABLED", false);
    const jobsEnabled = readBoolean(environment, "HAF_JOBS_ENABLED", false);
    const schedulerEnabled = readBoolean(environment, "HAF_SCHEDULER_ENABLED", false);
    const leases = createPostgresLeaseStore(database);
    const gatewayState = createPostgresGatewayStateStore(database, jobs);
    const gateway = gatewayEnabled
      ? createPostgresGatewaySupervisor({
          store: gatewayState,
          leases,
          listIdentities: () => listGatewayIdentities(env, context.app.stores.whiteLabelBots),
          leaseMs: readPositiveInteger(environment, "HAF_GATEWAY_LEASE_MS", 30_000),
          tickIntervalMs: readPositiveInteger(environment, "HAF_GATEWAY_TICK_MS", 5_000),
          identityRefreshMs: readPositiveInteger(
            environment,
            "HAF_GATEWAY_IDENTITY_REFRESH_MS",
            60_000,
          ),
          onError: reportComponentError("gateway"),
        })
      : createDisabledComponent("gateway");

    context.app.gateway = {
      start: () => gateway.start(),
      status: () => Promise.resolve(gateway.status?.() ?? { configured: true }),
    };
    httpContext.app.gateway = context.app.gateway;
    const writableProductAnalytics = withProductAnalyticsWaitUntil(
      context.productAnalytics,
      options.lifecycle.waitUntil,
    );
    const runtimeApp = createRuntimeApp({
      ...httpContext.app,
      environment: env.STAGING_MODE === "true" ? "staging" : "production",
      ...(maintenanceMode
        ? {}
        : {
            productAnalytics: withProductAnalyticsWaitUntil(
              httpContext.productAnalytics,
              options.lifecycle.waitUntil,
            ),
          }),
      waitUntil: options.lifecycle.waitUntil,
      sweepServerLevels: () => maintainServerLevels(env),
    });
    const schedulerRuntimeApp = maintenanceMode
      ? createRuntimeApp({
          ...context.app,
          environment: env.STAGING_MODE === "true" ? "staging" : "production",
          productAnalytics: writableProductAnalytics,
          waitUntil: options.lifecycle.waitUntil,
          sweepServerLevels: () => maintainServerLevels(env),
        })
      : runtimeApp;
    const jobWorker = jobsEnabled
      ? createPostgresJobWorker({
          queue: jobs,
          handlers: createJobHandlers({
            env,
            context: context.app,
            database,
            guildObjects: context.guildObjects,
          }),
          batchSize: readPositiveInteger(environment, "HAF_JOB_BATCH_SIZE", 10),
          leaseMs: readPositiveInteger(environment, "HAF_JOB_LEASE_MS", 30_000),
          pollIntervalMs: readPositiveInteger(environment, "HAF_JOB_POLL_MS", 1_000),
          onError: reportComponentError("jobs"),
        })
      : createDisabledComponent("jobs");
    const durableGuard = createPostgresWebhookIngressGuard(database);
    const scheduler = schedulerEnabled
      ? createPostgresScheduler({
          database,
          leaseMs: readPositiveInteger(environment, "HAF_SCHEDULER_LEASE_MS", 60_000),
          pollIntervalMs: readPositiveInteger(environment, "HAF_SCHEDULER_POLL_MS", 5_000),
          tasks: [
            ...(context.app.communityTools
              ? [
                  {
                    name: "community-automation",
                    intervalMs: 60_000,
                    run: ({ signal }: { signal: AbortSignal }) =>
                      context.app.communityTools!.sweep(signal),
                  },
                ]
              : []),
            ...(context.app.sweepReputationRewards
              ? [
                  {
                    name: "reputation-rewards",
                    intervalMs: 60_000,
                    run: async () => {
                      await context.app.sweepReputationRewards!();
                    },
                  },
                ]
              : []),
            {
              name: "application-maintenance",
              intervalMs: readPositiveInteger(
                environment,
                "HAF_MAINTENANCE_INTERVAL_MS",
                5 * 60_000,
              ),
              run: () => schedulerRuntimeApp.refreshPlayerCount(),
            },
            {
              name: "webhook-guard-maintenance",
              intervalMs: 5 * 60_000,
              run: () => durableGuard.pruneExpired().then(() => undefined),
            },
            {
              name: "gateway-cache-maintenance",
              intervalMs: 60 * 60_000,
              run: () => gatewayState.cleanupMessageAuditContext().then(() => undefined),
            },
            {
              name: "job-retention",
              intervalMs: 60 * 60_000,
              run: () =>
                jobs
                  .purgeFinishedBefore(new Date(Date.now() - 14 * 24 * 60 * 60_000))
                  .then(() => undefined),
            },
            ...(objects
              ? [
                  {
                    name: "object-reconciliation",
                    intervalMs: 5 * 60_000,
                    run: () =>
                      reconcilePortableObjectsPage({
                        database,
                        objects,
                        guildObjects: context.guildObjects,
                        bucketId: context.objectStoreKind,
                        pageSize: 1_000,
                      }).then(() => undefined),
                  },
                ]
              : []),
          ],
          onError: reportComponentError("scheduler"),
        })
      : createDisabledComponent("scheduler");

    return {
      fetch: runtimeApp.fetch,
      components: { gateway, jobs: jobWorker, scheduler },
      async isReady() {
        return (
          (await database.isReady()) &&
          (httpDatabase === database || Boolean(await httpDatabase?.isReady()))
        );
      },
      async status() {
        return {
          migrationRuntime: "postgres",
          migrations: migrationStatus.applied.length,
          migrationNames: migrationStatus.applied,
          revision: environment.HAF_IMAGE_REVISION ?? environment.GITHUB_SHA ?? "portable-node",
          ...(env.discordE2eActors ? { discordE2eGuildId: env.discordE2eActors.guildId } : {}),
          objectStore: context.objectStoreKind,
          httpPersistence: maintenanceMode ? "read-only" : "read-write",
          activation: {
            gateway: gatewayEnabled,
            jobs: jobsEnabled,
            scheduler: schedulerEnabled,
            maintenance: maintenanceMode,
          },
          queues: await jobs.stats(),
        };
      },
      async close() {
        try {
          if (httpDatabase !== database) await httpDatabase?.close();
        } finally {
          await database.close();
        }
      },
    };
  } catch (error) {
    if (httpDatabase !== database) await httpDatabase?.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

function createHttpMaintenanceContext(input: {
  environment: Record<string, string | undefined>;
  database: PostgresDatabaseCapability;
  objects: ObjectStore | null;
}) {
  const d1 = createPostgresD1CompatibilityDatabase(input.database);
  const jobs = createPostgresJobQueue(input.database);
  const env = createPortableEnv(input.environment, d1, createQueueBindings(input.database, jobs));
  return createPortableContext({ ...input, env, d1 });
}

function createQueueBindings(
  database: PostgresDatabaseCapability,
  jobs: ReturnType<typeof createPostgresJobQueue>,
): Record<PortableQueueName, QueueProducer<unknown>> {
  const names: PortableQueueName[] = [
    "r2-quota",
    "gateway-events",
    "webhook-proxy-deliveries",
    "steam-ban-lookups",
    "billing-sync",
    "billing-delivery",
    "commerce-sync",
    "commerce-roles",
    "commerce-game-access",
    "ticket-recovery",
    "server-levels",
  ];
  return Object.fromEntries(
    names.map((queueName) => [
      queueName,
      createPostgresQueueBinding({ database, jobs, queueName }),
    ]),
  ) as Record<PortableQueueName, QueueProducer<unknown>>;
}

function createPortableEnv(
  environment: Record<string, string | undefined>,
  d1: D1Database,
  queues: Record<PortableQueueName, QueueProducer<unknown>>,
): Env {
  const stagingMode =
    environment.STAGING_MODE ?? (environment.NODE_ENV === "production" ? "false" : "true");
  return {
    ...environment,
    discordE2eActors: undefined,
    STAGING_MODE: stagingMode,
    GATEWAY_ENABLED: "false",
    DISCORD_APPLICATION_ID:
      normalizeString(environment.DISCORD_APPLICATION_ID) ??
      normalizeString(environment.DISCORD_OAUTH_CLIENT_ID),
    DISCORD_BOT_TOKEN: requireString(environment, "DISCORD_BOT_TOKEN"),
    BOT_USER_ID: requireString(environment, "BOT_USER_ID"),
    DISCORD_PUBLIC_KEY: requireString(environment, "DISCORD_PUBLIC_KEY"),
    HAF_DB: d1,
    GATEWAY_SESSION_DO: disabledDurableObjectNamespace(),
    GATEWAY_EVENT_QUEUE: queues["gateway-events"],
    R2_QUOTA_QUEUE: queues["r2-quota"],
    WEBHOOK_PROXY_DELIVERY_QUEUE: queues["webhook-proxy-deliveries"],
    STEAM_BAN_LOOKUP_QUEUE: queues["steam-ban-lookups"],
    BILLING_SYNC_QUEUE: queues["billing-sync"],
    BILLING_DELIVERY_QUEUE: queues["billing-delivery"],
    COMMERCE_SYNC_QUEUE: queues["commerce-sync"],
    COMMERCE_ROLE_QUEUE: queues["commerce-roles"],
    COMMERCE_GAME_QUEUE: queues["commerce-game-access"],
    TICKET_RECOVERY_QUEUE: queues["ticket-recovery"],
    SERVER_LEVELS_QUEUE: queues["server-levels"],
    DISCORD_CACHE_KV: createMemoryKvNamespace(),
    WORKER_VERSION: {
      id: environment.HAF_IMAGE_REVISION ?? environment.GITHUB_SHA ?? "portable-node",
    },
  } as Env;
}

function createPortableContext(input: {
  environment: Record<string, string | undefined>;
  env: Env;
  database: PostgresDatabaseCapability;
  d1: D1Database;
  objects: ObjectStore | null;
}): {
  app: RuntimeAppContext;
  guildObjects: GuildR2QuotaStore;
  objects: ObjectStore | null;
  objectStoreKind: string;
  productAnalytics: ReturnType<typeof createEnvironmentProductAnalytics>;
} {
  const baseEnv = {
    ...input.env,
    BETTER_AUTH_SECRET: undefined,
    DISCORD_OAUTH_CLIENT_ID: undefined,
    DISCORD_OAUTH_CLIENT_SECRET: undefined,
  };
  const app = createCloudflareContext(baseEnv);
  const guildObjects = createPostgresGuildObjectStore(input.database);
  const guildEntitlements = createPostgresGuildEntitlementStore(
    input.database,
    input.environment.HAF_DEPLOYMENT_MODE,
  );
  const productAnalyticsPreferences = createPostgresProductAnalyticsPreferenceStore(input.database);
  const reactionLimits = createPostgresReactionLimitStore(input.database);
  app.stores = {
    ...app.stores,
    appConfig: createPostgresAppConfigStore(input.database),
    blocklist: createPostgresBlocklistStore(input.database, input.env.BOT_USER_ID),
    guildRbac: createPostgresGuildRbacStore(input.database),
    guildEntitlements,
    guildR2Objects: guildObjects,
    reactionLimits,
    knownGuilds: createPostgresKnownGuildStore(input.database),
    userPreferences: createPostgresUserPreferencesStore(input.database),
    guildServiceSuspensions: createPostgresGuildServiceSuspensionStore(input.database),
    productAnalyticsPreferences,
  };
  app.sweepReactionLimitCounterRetention = () =>
    reactionLimits.purgeExpiredCounters(Date.now() - 30 * 24 * 60 * 60_000);
  app.workspaceStore = createPostgresWorkspaceStore(input.database);
  const resolveCommunityBot = (guildId: string) =>
    app.resolveGuildBotIdentity
      ? app.resolveGuildBotIdentity(guildId)
      : Promise.resolve({
          token: input.env.DISCORD_BOT_TOKEN,
          userId: input.env.BOT_USER_ID ?? "",
        });
  app.communityTools = createCommunityToolsRuntime({
    database: input.database,
    d1: input.d1,
    stores: app.stores,
    resolveGuildBotIdentity: resolveCommunityBot,
    twitchClientId: input.environment.TWITCH_CLIENT_ID,
    twitchClientSecret: input.environment.TWITCH_CLIENT_SECRET,
  });
  const reputationStore = createPostgresReputationStore(input.database);
  app.banAppealServiceForGuild = createBanAppealRuntime({
    store: createPostgresBanAppealStore(input.database),
    resolveGuildBotIdentity: resolveCommunityBot,
    isSuspended: (guildId) =>
      new GuildServicePolicy(app.stores.guildServiceSuspensions).isGuildSuspended(guildId),
  }).serviceForGuild;
  if (app.stores.reactionRoles) {
    const rolePolicy = app.stores.reactionRoles;
    const readRestrictedRoleIds = rolePolicy.readRestrictedRoleIds.bind(rolePolicy);
    rolePolicy.readRestrictedRoleIds = async (guildId, options) => {
      const restricted = await readRestrictedRoleIds(guildId, options);
      const { config } = await app.communityTools!.read(guildId, "moderation");
      if ("moderatorRoleIds" in config)
        for (const roleId of config.moderatorRoleIds) restricted.add(roleId);
      if (!options?.excludeReputationRewards)
        for (const reward of (await reputationStore.getConfig(guildId)).rewards)
          restricted.add(reward.roleId);
      return restricted;
    };
    const reputation = createReputationRuntime({
      store: reputationStore,
      resolveGuildBotIdentity: resolveCommunityBot,
      rolePolicy,
      isSuspended: (guildId) =>
        new GuildServicePolicy(app.stores.guildServiceSuspensions).isGuildSuspended(guildId),
    });
    app.reputationServiceForGuild = reputation.serviceForGuild;
    app.sweepReputationRewards = reputation.processRewards;
  }
  app.playerCountStreakReportedStore = createPostgresPlayerCountStreakReportedStore(input.database);
  app.commercePurchaseSigningSecret = normalizeString(input.environment.BETTER_AUTH_SECRET);
  app.customerAuth = createOptionalPostgresAuth(input.environment, input.database);

  const gameAccessStore = createPostgresGameAccessStore(input.database);
  app.banEnforcementStore = createPostgresBanEnforcementStore(input.database);
  app.wardogs = new WardogsService({
    reservedAccessEnabled: false,
    mutationsEnabled: input.environment.WARDOGS_MUTATIONS_ENABLED === "true",
    commerceGrantsEnabled: false,
    canChangeOrigin: (guildId, targetId) => gameAccessStore.canChangeOrigin(guildId, targetId),
    store: createPostgresWardogsStore(input.database),
    runtime: "portable",
    policy: wardogsNetworkPolicy(input.environment),
    keyRing: input.environment.WEBHOOK_CREDENTIAL_KEY_V1
      ? () =>
          createWebhookCredentialKeyRing({
            keyV1: input.environment.WEBHOOK_CREDENTIAL_KEY_V1!,
            keyV2: input.environment.WEBHOOK_CREDENTIAL_KEY_V2,
          })
      : undefined,
  });
  const commercePremium = {
    isPremium: async (guildId: string) => {
      const entitlement = await guildEntitlements.readGuildEntitlement(guildId);
      return entitlement?.tier === "premium" || entitlement?.tier === "premium_plus";
    },
  };
  app.commerceGameAccess = createGameAccessRuntime({
    database: baseEnv.HAF_DB,
    store: gameAccessStore,
    wardogs: app.wardogs,
    platformLink: app.stores.platformLink,
    botUserId: baseEnv.BOT_USER_ID,
    botToken: baseEnv.DISCORD_BOT_TOKEN,
    queue: baseEnv.COMMERCE_GAME_QUEUE,
    premium: commercePremium,
    enabled: false,
    steamEnabled: app.features.steamLink,
  });
  if (app.commerceAdmin) app.commerceAdmin.gameAccess = app.commerceGameAccess;
  app.commerceBuyerCheckoutService =
    createCloudflareCommerceBuyerRuntime(baseEnv, commercePremium, app.commerceGameAccess.hooks) ??
    undefined;
  app.attendanceObservations = createAttendanceObservationRuntime({
    store: createPostgresObservationStore(input.database),
    wardogs: app.wardogs,
    stores: app.stores,
    enabled: app.features.serverLevels !== false,
    steamEnabled: app.features.steamLink,
    processingAvailable:
      Boolean(baseEnv.SERVER_LEVELS_QUEUE) &&
      readBoolean(input.environment, "HAF_JOBS_ENABLED", false) &&
      readBoolean(input.environment, "HAF_SCHEDULER_ENABLED", false),
    botToken: baseEnv.DISCORD_BOT_TOKEN,
    botUserId: baseEnv.BOT_USER_ID,
  });
  const credentialKey = normalizeString(input.environment.WEBHOOK_CREDENTIAL_KEY_V1);
  app.webhookCredentialService = credentialKey
    ? new WebhookCredentialService(
        createCloudflareWebhookCredentialStore(input.d1),
        createWebhookCredentialKeyRing({
          keyV1: credentialKey,
          keyV2: normalizeString(input.environment.WEBHOOK_CREDENTIAL_KEY_V2),
        }),
      )
    : undefined;
  const durableGuard = createPostgresWebhookIngressGuard(input.database);
  app.webhookIngressGuard = createLayeredWebhookIngressGuard({
    process: createInMemoryWebhookIngressGuard(),
    durable: durableGuard,
  });
  if (input.objects) {
    const blobOptions = { objects: input.objects, guildEntitlements, guildObjects };
    app.ticketTranscriptBlobs = createPortableTicketTranscriptBlobStore(blobOptions);
    app.evidenceVaultBlobs = createPortableEvidenceVaultBlobStore(blobOptions);
    app.publicManagedMedia = createPortablePublicManagedMediaStore(blobOptions);
  } else {
    app.ticketTranscriptBlobs = undefined;
    app.evidenceVaultBlobs = undefined;
    app.publicManagedMedia = undefined;
  }
  const productAnalytics = withGuildAnalyticsPreference(
    createEnvironmentProductAnalytics(input.env),
    (guildId) => productAnalyticsPreferences.readEnabled(guildId),
  );
  return {
    app,
    guildObjects,
    objects: input.objects,
    objectStoreKind: objectStoreKind(input.environment, input.objects),
    productAnalytics,
  };
}

function createJobHandlers(input: {
  env: Env;
  context: RuntimeAppContext;
  database: PostgresDatabaseCapability;
  guildObjects: GuildR2QuotaStore;
}): Partial<Record<PortableQueueName, PostgresJobHandler>> {
  const services = createServiceFactory({
    stores: input.context.stores,
    discordBotToken: input.env.DISCORD_BOT_TOKEN,
    discordBotUserId: input.env.BOT_USER_ID,
    discordCacheKv: input.context.discordCacheKv,
    steamWebApiKey: input.context.steamWebApiKey,
    wardogs: input.context.wardogs,
    banEnforcementStore: input.context.banEnforcementStore,
    banIncidentStore: input.context.banIncidentStore,
    banCasesEnabled: input.context.features?.banCases,
    wardogsPlayerCountEnabled: input.context.wardogsPlayerCountEnabled,
    playerCountEnabled: input.context.features.playerCount,
    webhookProxyLogPersistenceEnabled: input.context.webhookProxyLogPersistenceEnabled,
    webhookProxyDeliveryQueue: input.context.webhookProxyDeliveryQueue,
    steamBanLookupQueue: input.context.steamBanLookupQueue,
    ticketRecoveryQueue: input.context.ticketRecoveryQueue,
    evidenceVaultBlobs: input.context.evidenceVaultBlobs,
    publicManagedMedia: input.context.publicManagedMedia,
    webhookCredentialService: input.context.webhookCredentialService,
    publicUrl: input.context.publicUrl,
    waitUntil: (promise) => void promise.catch(() => undefined),
    playerCountStreakReportedStore: input.context.playerCountStreakReportedStore,
    whiteLabelBotStore: input.context.stores.whiteLabelBots,
    componentIdSigner: input.context.componentIdSigner,
    serverLevelsEnabled: input.context.features.serverLevels,
  });
  const recheckIntervalMs = readOptionalPositiveInteger(
    input.env.STEAM_BAN_LOOKUP_RECHECK_INTERVAL_MS,
  );
  const steam = new SteamBanLookupService({
    steamWebApiKey: input.env.STEAM_WEB_API_KEY,
    store: createPostgresSteamBanLookupStore(
      input.database,
      recheckIntervalMs ? { ttlSeconds: Math.ceil(recheckIntervalMs / 1_000) } : {},
    ),
    ...(recheckIntervalMs ? { recheckIntervalMs } : {}),
  });
  const gatewayStores: GatewayEventStores = {
    communityTools: input.context.communityTools,
    reputationServiceForGuild: input.context.reputationServiceForGuild,
    audit: input.context.stores.guildAuditLog,
    blocklist: input.context.stores.blocklist as GatewayEventStores["blocklist"],
    entitlement: input.context.stores.guildEntitlements,
    guildRbac: input.context.stores.guildRbac,
    knownGuild: input.context.stores.knownGuilds,
    productAnalyticsPreferences: input.context.stores.productAnalyticsPreferences!,
    lfg: input.context.stores.lfg,
    clan: input.context.stores.clans!,
    managedMessage: input.context.stores.managedMessages,
    memberVerification: input.context.stores.memberVerification,
    mentionProtection: input.context.stores.mentionProtection,
    platformLink: input.context.stores.platformLink,
    reactionLimit: input.context.stores.reactionLimits,
    reactionRole: input.context.stores.reactionRoles,
    ticket: input.context.stores.tickets as GatewayEventStores["ticket"],
    timedRole: input.context.stores.timedRoles,
    whiteLabel: input.context.stores.whiteLabelBots,
    suggestion: input.context.stores.suggestions,
    serverLevel: input.context.stores.serverLevels!,
    webhookCredential: createCloudflareWebhookCredentialStore(input.env.HAF_DB),
  };
  const policy = new GuildServicePolicy(input.context.stores.guildServiceSuspensions);
  const protectedHandler =
    (
      handler: PostgresJobHandler,
      allowSuspendedMessage?: (payload: unknown) => boolean,
    ): PostgresJobHandler =>
    async (payload, context) => {
      if (
        (await policy.isGuildSuspended(findGuildIdInValue(payload))) &&
        !allowSuspendedMessage?.(payload)
      ) {
        return { status: "terminal", reasonCode: "guild_suspended" };
      }
      return handler(payload, context);
    };

  return {
    "r2-quota": protectedHandler(
      createSingleMessageHandler(R2_QUOTA_QUEUE_NAME, (batch) =>
        deliverR2QuotaQueueBatch(batch, input.guildObjects),
      ),
    ),
    "gateway-events": protectedHandler(
      createSingleMessageHandler(GATEWAY_EVENT_QUEUE_NAME, (batch) =>
        deliverGatewayEventQueueBatch(batch, input.env, console, { stores: gatewayStores }),
      ),
      isGatewayGuildLifecycleEvent,
    ),
    "webhook-proxy-deliveries": protectedHandler(
      createSingleMessageHandler(WEBHOOK_PROXY_DELIVERY_QUEUE_NAME, (batch) =>
        deliverWebhookProxyDeliveryQueueBatch(batch, services.webhookProxyService),
      ),
    ),
    "steam-ban-lookups": protectedHandler(
      createSingleMessageHandler(STEAM_BAN_LOOKUP_QUEUE_NAME, (batch) =>
        deliverSteamBanLookupQueueBatch(
          batch,
          steam,
          console,
          input.context.webhookCredentialService,
        ),
      ),
    ),
    "billing-sync": createSingleMessageHandler(BILLING_SYNC_QUEUE_NAME, (batch) =>
      handleBillingSyncQueueBatch(batch, input.env),
    ),
    "billing-delivery": createSingleMessageHandler(BILLING_DELIVERY_QUEUE_NAME, (batch) =>
      handleBillingDeliveryQueueBatch(batch, input.env),
    ),
    "commerce-sync": createSingleMessageHandler(COMMERCE_SYNC_QUEUE_NAME, (batch) =>
      handleCommerceSyncQueueBatch(batch, input.env, input.context.commerceAdmin?.sellerReviews),
    ),
    "commerce-roles": createSingleMessageHandler(COMMERCE_ROLE_QUEUE_NAME, (batch) =>
      handleCommerceRoleQueueBatch(batch, input.env),
    ),
    "commerce-game-access": createSingleMessageHandler(COMMERCE_GAME_QUEUE_NAME, (batch) => {
      if (!input.context.commerceGameAccess)
        throw new Error("Commerce game delivery is unavailable.");
      return handleCommerceGameQueueBatch(batch, input.context.commerceGameAccess);
    }),
    "ticket-recovery": createSingleMessageHandler(TICKET_RECOVERY_QUEUE_NAME, (batch) =>
      deliverTicketRecoveryQueueBatch(
        batch,
        services.ticketLifecycle,
        services.ticketPanelService,
        input.env.DISCORD_BOT_TOKEN,
      ),
    ),
    "server-levels": protectedHandler(
      createSingleMessageHandler(SERVER_LEVELS_QUEUE_NAME, (batch) =>
        handleServerLevelQueueBatch(batch, input.env),
      ),
    ),
  };
}

function createSingleMessageHandler(
  queueName: string,
  consume: (batch: QueueBatch<unknown>) => Promise<void>,
): PostgresJobHandler {
  return async (payload, context) => {
    let outcome: QueueDeliveryOutcome | undefined;
    const settle = (next: QueueDeliveryOutcome) => {
      if (outcome) throw new Error(`Queue consumer settled ${queueName} more than once.`);
      outcome = next;
    };
    const message = {
      id: context.jobId,
      timestamp: new Date(),
      body: payload,
      attempts: context.attempts,
      ack: () => settle({ status: "complete" }),
      retry: (options?: QueueRetryOptions) =>
        settle({
          status: "retry",
          reasonCode: "consumer_requested_retry",
          ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
        }),
    } as Message<unknown>;
    const batch = {
      queue: queueName,
      messages: [message],
      ackAll: () => message.ack(),
      retryAll: (options?: QueueRetryOptions) => message.retry(options),
    } as QueueBatch<unknown>;
    await consume(batch);
    if (!outcome) throw new Error(`Queue consumer did not settle ${queueName}.`);
    return outcome;
  };
}

async function listGatewayIdentities(
  env: Env,
  whiteLabelBots: RuntimeAppContext["stores"]["whiteLabelBots"],
) {
  const identities = [
    {
      identityId: "standard",
      botUserId: env.BOT_USER_ID,
      token: env.DISCORD_BOT_TOKEN,
    },
  ];
  for (const bot of await whiteLabelBots.listActiveWhiteLabelBots()) {
    identities.push({
      identityId: `white-label:${bot.guildId}`,
      botUserId: bot.botUserId,
      token: resolveSecretReference(env, bot.tokenSecretRef),
    });
  }
  return identities;
}

function resolveSecretReference(env: Env, secretReference: string): string {
  const binding = secretReference.startsWith("secrets-store:")
    ? secretReference.split(":").at(-1)
    : secretReference;
  const value = binding ? env[binding] : undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Gateway credential binding ${binding ?? "invalid"} is not configured.`);
  }
  return value;
}

function createOptionalPostgresAuth(
  environment: Record<string, string | undefined>,
  database: PostgresDatabaseCapability,
) {
  const names = [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "DISCORD_OAUTH_CLIENT_ID",
    "DISCORD_OAUTH_CLIENT_SECRET",
  ] as const;
  const values = names.map((name) => normalizeString(environment[name]));
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error(`PostgreSQL customer auth requires ${names.join(", ")} together.`);
  }
  return createPostgresCustomerAuth({
    database,
    betterAuthSecret: values[0]!,
    betterAuthUrl: values[1]!,
    discordOAuthClientId: values[2]!,
    discordOAuthClientSecret: values[3]!,
  });
}

function createObjectStore(environment: Record<string, string | undefined>): ObjectStore | null {
  const azureConfigured = Boolean(
    normalizeString(environment.AZURE_STORAGE_ACCOUNT_URL) ||
    normalizeString(environment.AZURE_STORAGE_CONNECTION_STRING),
  );
  const s3Configured = Boolean(normalizeString(environment.S3_BUCKET_NAME));
  if (azureConfigured && s3Configured) {
    throw new Error("Configure either Azure Blob or S3 object storage, not both.");
  }
  if (azureConfigured) return createAzureBlobObjectStoreFromEnvironment(environment);
  if (s3Configured) return createS3ObjectStoreFromEnvironment(environment);
  if (
    environment.NODE_ENV === "production" &&
    !readBoolean(environment, "HAF_ALLOW_OBJECT_STORAGE_DISABLED", false)
  ) {
    throw new Error(
      "Production requires Azure Blob or S3 object storage; explicitly set HAF_ALLOW_OBJECT_STORAGE_DISABLED=true only for a deliberate degraded deployment.",
    );
  }
  return null;
}

function objectStoreKind(
  environment: Record<string, string | undefined>,
  objects: ObjectStore | null,
): string {
  if (!objects) return "disabled";
  return normalizeString(environment.AZURE_STORAGE_ACCOUNT_URL) ||
    normalizeString(environment.AZURE_STORAGE_CONNECTION_STRING)
    ? "azure-blob"
    : normalizeString(environment.S3_BUCKET_NAME)
      ? "s3"
      : "injected";
}

function createDisabledComponent(name: string): ManagedNodeComponent {
  let running = false;
  return {
    async start() {
      running = true;
    },
    async stop() {
      running = false;
    },
    isReady: () => running,
    status: () => ({ configured: false, name, running }),
  };
}

function disabledDurableObjectNamespace(): DurableObjectNamespace {
  return {
    idFromName() {
      throw new Error("Cloudflare Durable Objects are disabled in the PostgreSQL runtime.");
    },
    get() {
      throw new Error("Cloudflare Durable Objects are disabled in the PostgreSQL runtime.");
    },
  } as unknown as DurableObjectNamespace;
}

function reportComponentError(component: string) {
  return (error: unknown, context: Record<string, unknown>) => {
    console.error({
      event: "haf.node.component_error",
      component,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
  };
}

function readBoolean(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const value = normalizeString(environment[name]);
  if (value === undefined) return fallback;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

function readPositiveInteger(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = normalizeString(environment[name]);
  if (value === undefined) return fallback;
  const parsed = readOptionalPositiveInteger(value);
  if (parsed === undefined) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requireString(environment: Record<string, string | undefined>, name: string): string {
  const value = normalizeString(environment[name]);
  if (!value) throw new Error(`${name} is required for the PostgreSQL runtime.`);
  return value;
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export const __testing = {
  createPortableContext,
  createPortableEnv,
  createQueueBindings,
};
