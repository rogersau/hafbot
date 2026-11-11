import { syncApplicationCommands, syncGuildApplicationCommands } from "../discord";
import { getSlashCommandDefinitions } from "../discord-commands";
import { GatewayService } from "../services/gateway-service";
import { reportOperationalEvent } from "../observability/operational-reporter";
import type { ApplicationServices, RuntimeAppOptions, RuntimeStores } from "./app-types";
import type { FeatureFlags } from "./features";
import { GuildServicePolicy } from "./guild-service-policy";
import { createServiceFactory } from "./service-factory";

/**
 * Composition input for the one writable feature-service graph.
 *
 * Every field is a service, store, credential, capability or lifecycle hook
 * already selected by the composition root. Composition consumes them as-is;
 * it never constructs replacement persistence or spreads partial overrides.
 */
export type ApplicationServicesComposition = Omit<RuntimeAppOptions, "services"> & {
  features: FeatureFlags;
};

/**
 * Builds the single writable feature-service graph shared by HTTP dispatch,
 * native job delivery and scheduled maintenance.
 *
 * The caller supplies final selected stores, blob stores, credentials,
 * analytics, the Gateway controller and the host lifecycle. The returned graph
 * captures them from the outset, so the same stateful service instances serve
 * every consumer.
 */
export function composeApplicationServices(
  input: ApplicationServicesComposition,
): ApplicationServices {
  const features = input.features;
  const guildServicePolicy = new GuildServicePolicy(input.stores.guildServiceSuspensions);
  const stores = createSuspensionAwareScheduledStores(input.stores, guildServicePolicy);
  const gatewayService = new GatewayService(input.gateway, {
    discordApplicationId: input.discordApplicationId,
    syncApplicationCommands: input.discordApplicationId
      ? async (applicationId) => {
          const commands = getSlashCommandDefinitions(features);
          const globalCommands = commands.filter((command) => command.name !== "haf-admin");
          const hafAdminCommand = commands.find((command) => command.name === "haf-admin");

          await syncApplicationCommands(applicationId, input.discordBotToken, globalCommands);
          if (input.hafAdminGuildId && hafAdminCommand) {
            await syncGuildApplicationCommands(
              applicationId,
              input.hafAdminGuildId,
              input.discordBotToken,
              [hafAdminCommand],
            );
          }
        }
      : undefined,
  });
  const services = createServiceFactory({
    stores,
    discordBotToken: input.discordBotToken,
    discordBotUserId: input.discordBotUserId,
    discordCache: input.discordCache,
    steamWebApiKey: input.steamWebApiKey,
    webhookProxyLogPersistenceEnabled: input.webhookProxyLogPersistenceEnabled,
    ticketRecoveryQueue: input.ticketRecoveryQueue,
    webhookProxyDeliveryQueue: input.webhookProxyDeliveryQueue,
    steamBanLookupQueue: input.steamBanLookupQueue,
    webhookCredentialService: input.webhookCredentialService,
    evidenceVaultBlobs: input.evidenceVaultBlobs,
    evidenceMediaCapability: input.evidenceMediaCapability,
    publicManagedMedia: input.publicManagedMedia,
    publicUrl: input.publicUrl,
    turnstileSiteKey: input.turnstileSiteKey,
    turnstileSecretKey: input.turnstileSecretKey,
    steamLinkAvailable: features.steamLink,
    waitUntil: input.waitUntil,
    playerCountStreakReportedStore: input.playerCountStreakReportedStore,
    whiteLabelBotStore: input.stores.whiteLabelBots,
    publicWebhookSourceCaches: input.publicWebhookSourceCaches,
    guildResources: input.guildResources,
    componentIdSigner: input.componentIdSigner,
    productAnalytics: input.productAnalytics,
    reportOperationalEvent: input.reportOperationalEvent ?? reportOperationalEvent,
    serverLevelsEnabled: features.serverLevels,
    wardogs: input.wardogs,
    banEnforcementStore: input.banEnforcementStore,
    banIncidentStore: input.banIncidentStore,
    banCasesEnabled: features.banCases,
    wardogsPlayerCountEnabled: input.wardogsPlayerCountEnabled,
    playerCountEnabled: features.playerCount,
  });
  return { ...services, gatewayService };
}

/**
 * Bounds scheduled scans to Guilds that still receive HAF service.
 *
 * The wrappers filter only the due-work scans (Timed Role expiry, LFG due
 * expiries and renewal reminders, Event reminders and lifecycle, Player Count
 * scans and Managed Message draft claims). They are not blanket mutation
 * denial: ordinary HTTP reads and writes through the same stores are
 * unaffected, and operation-specific Guild policy keeps applying at the
 * service layer.
 */
export function createSuspensionAwareScheduledStores(
  stores: RuntimeAppOptions["stores"],
  policy: GuildServicePolicy,
): RuntimeStores {
  const filter = async <T>(items: T[], guildId: (item: T) => string | null | undefined) => {
    const allowed: T[] = [];
    for (const item of items) {
      if (!(await policy.isGuildSuspended(guildId(item)))) allowed.push(item);
    }
    return allowed;
  };
  return {
    ...stores,
    timedRoles: {
      ...stores.timedRoles,
      listExpiredTimedRoles: async (nowMs) =>
        filter(await stores.timedRoles.listExpiredTimedRoles(nowMs), (item) => item.guildId),
    },
    lfg: {
      ...stores.lfg,
      listDueLfgPostExpiries: async (nowMs, limit) => {
        const suspendedGuildIds = await policy.listSuspendedGuildIds();
        return stores.lfg.listDueLfgPostExpiries(nowMs, limit, suspendedGuildIds);
      },
      listDueLfgRenewalReminders: async (nowMs, limit) => {
        const suspendedGuildIds = await policy.listSuspendedGuildIds();
        return stores.lfg.listDueLfgRenewalReminders(nowMs, limit, suspendedGuildIds);
      },
    },
    events: {
      ...stores.events,
      listDueReminders: async (nowMs, limit) =>
        filter(await stores.events.listDueReminders(nowMs, limit), (item) => item.event.guildId),
      listDueLifecycleEvents: async (nowMs, limit) =>
        filter(await stores.events.listDueLifecycleEvents(nowMs, limit), (item) => item.guildId),
    },
    playerCount: {
      ...stores.playerCount,
      listAllPlayerCountServers: async () =>
        filter(await stores.playerCount.listAllPlayerCountServers(), (item) => item.guildId),
    },
    managedMessages: {
      ...stores.managedMessages,
      claimDueDrafts: async (nowMs, limit) =>
        filter(
          await stores.managedMessages.claimDueDrafts(nowMs, limit),
          (item) => item.draft.guildId,
        ),
    },
  };
}
