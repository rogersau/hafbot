import type { GuildResourceValidator } from "../../discord/guild-resource-validator";
import type { CreateChannelMessageInput } from "../../discord/messages";
import type { Env } from "../../env";
import { withDiscordE2eActors } from "../discord-e2e-actors";
import { isRecord } from "../../unknown-parse";
import { createCloudflareWhiteLabelBotStore } from "../cloudflare-white-label-bot-store";
import { createCloudflareBlocklistStore } from "../cloudflare-blocklist-store";
import { createCloudflareGuildAuditLogStore } from "../cloudflare-guild-audit-log-store";
import { createCloudflareGuildEntitlementStore } from "../cloudflare-guild-entitlement-store";
import { createCloudflareGuildRbacStore } from "../cloudflare-guild-rbac-store";
import { createCloudflareGuildServiceSuspensionStore } from "../cloudflare-guild-service-suspension-store";
import { createCloudflareKnownGuildStore } from "../cloudflare-known-guild-store";
import { createCloudflareProductAnalyticsPreferenceStore } from "../cloudflare-product-analytics-preference-store";
import { createCloudflareLfgStore } from "../cloudflare-lfg-store";
import { createCloudflareClanStore } from "../cloudflare-clan-store";
import { createCloudflareManagedMessageStore } from "../cloudflare-managed-message-store";
import { createCloudflareMemberVerificationStore } from "../cloudflare-member-verification-store";
import { createCloudflareMentionProtectionStore } from "../cloudflare-mention-protection-store";
import { createCloudflarePlatformLinkStore } from "../cloudflare-platform-link-store";
import { createCloudflareReactionLimitStore } from "../cloudflare-reaction-limit-store";
import { createCloudflareReactionRoleStore } from "../cloudflare-reaction-role-store";
import { createCloudflareTicketStore } from "../cloudflare-ticket-store";
import { createCloudflareTimedRoleStore } from "../cloudflare-timed-role-store";
import { createCloudflareSuggestionStore } from "../cloudflare-suggestion-store";
import { createCloudflareServerLevelStore } from "../cloudflare-server-level-store";
import { createCloudflareWebhookCredentialStore } from "../../security/webhook-credentials/cloudflare-store";
import { createGuildBrandingResolver } from "../guild-branding";
import {
  createGatewayEventOperationRunner,
  createGatewayEventOperationStore,
  deriveGatewayOperationNonce,
  type GatewayEventOperationRunner,
} from "../gateway-event-idempotency";
import { parseFeatureFlags } from "../features";
import { createMentionProtectionMessageDependencies } from "../mention-protection-runtime";
import { QueueTerminalError } from "../queue-delivery";
import type {
  GatewayEventCapabilities,
  GatewayEventEnvelope,
  GatewayEventQueueLogger,
  GatewayEventStores,
} from "./contracts";
import { createGatewayDiscordCapabilities } from "./discord-capabilities";
import { ClanService } from "../../services/clan-service";
import {
  createClanCategory,
  createClanRole,
  createClanTextChannel,
  createClanVoiceChannel,
  deleteClanRole,
  inspectClanResources,
  setClanArchivedPermissions,
} from "../../discord/clans";
import { addGuildMemberRole, removeGuildMemberRole } from "../../discord/members";
import { deleteChannel } from "../../discord/messages";
import { postClanAuditEvent, postMemberAuditEvent } from "../../services/guild-audit-log-service";
import { createHafDatabaseCapability } from "../haf-database-capability";
import {
  createEnvironmentProductAnalytics,
  withGuildAnalyticsPreference,
  withProductAnalyticsWaitUntil,
} from "../../product-analytics";
import { createComponentIdSigner } from "../../security/component-id-signer";
import { signSensitiveMessageComponentIds } from "../../security/sensitive-component-ids";
import {
  createMemberVerificationService,
  type MemberVerificationService,
} from "../../services/member-verification-service";

export interface GatewayEventCapabilityOverrides {
  guildResources?: GuildResourceValidator;
  waitUntil?: (promise: Promise<unknown>) => void;
  stores?: GatewayEventStores;
}

export async function createGatewayEventCapabilities(
  envelope: GatewayEventEnvelope,
  env: Env,
  logger: GatewayEventQueueLogger,
  overrides: GatewayEventCapabilityOverrides = {},
): Promise<GatewayEventCapabilities | null> {
  const database = env.HAF_DB ? createHafDatabaseCapability(env.HAF_DB) : undefined;
  const hafDb = database?.binding;
  const whiteLabelStore =
    overrides.stores?.whiteLabel ?? (hafDb ? createCloudflareWhiteLabelBotStore(hafDb) : undefined);
  const guildServiceSuspensionStore = hafDb
    ? createCloudflareGuildServiceSuspensionStore(hafDb)
    : undefined;
  if (
    await shouldSuppressStandardBotEnvelope(envelope, whiteLabelStore, guildServiceSuspensionStore)
  )
    return null;
  const discordBotToken = await resolveGatewayDiscordBotToken(envelope, env, whiteLabelStore);
  const botEnv =
    discordBotToken === env.DISCORD_BOT_TOKEN
      ? env
      : { ...env, DISCORD_BOT_TOKEN: discordBotToken };
  const branding = createGuildBrandingResolver(whiteLabelStore);
  const actorView = (discord: ReturnType<typeof createGatewayDiscordCapabilities>) =>
    withDiscordE2eActors(
      discord,
      env.discordE2eActors,
      extractGatewayGuildId(envelope) ?? "",
      envelope.botUserId ?? env.BOT_USER_ID,
    );
  const discord = actorView(
    createGatewayDiscordCapabilities(discordBotToken, overrides.guildResources),
  );
  const stores =
    overrides.stores ??
    (hafDb
      ? {
          audit: createCloudflareGuildAuditLogStore(hafDb),
          blocklist: createCloudflareBlocklistStore(hafDb, env.BOT_USER_ID),
          entitlement: createCloudflareGuildEntitlementStore(hafDb, env.HAF_DEPLOYMENT_MODE),
          guildRbac: createCloudflareGuildRbacStore(hafDb),
          knownGuild: createCloudflareKnownGuildStore(hafDb),
          productAnalyticsPreferences: createCloudflareProductAnalyticsPreferenceStore(hafDb),
          lfg: createCloudflareLfgStore(hafDb),
          clan: createCloudflareClanStore(hafDb),
          managedMessage: createCloudflareManagedMessageStore(hafDb),
          memberVerification: createCloudflareMemberVerificationStore(hafDb),
          mentionProtection: createCloudflareMentionProtectionStore(hafDb),
          platformLink: createCloudflarePlatformLinkStore(hafDb),
          reactionLimit: createCloudflareReactionLimitStore(hafDb),
          reactionRole: createCloudflareReactionRoleStore(hafDb, {
            guildId: env.HAF_ADMIN_GUILD_ID?.trim(),
            roleIds: [env.HAF_ADMIN_ROLE_ID, env.BILLING_SUPPORT_ROLE_ID],
          }),
          ticket: createCloudflareTicketStore(hafDb),
          timedRole: createCloudflareTimedRoleStore(hafDb),
          whiteLabel: whiteLabelStore!,
          suggestion: createCloudflareSuggestionStore(hafDb),
          serverLevel: createCloudflareServerLevelStore(hafDb),
          webhookCredential: createCloudflareWebhookCredentialStore(hafDb),
        }
      : null);
  const clanService = stores
    ? new ClanService(
        stores.clan,
        {
          createCategory: ({ guildId, name }) => createClanCategory(guildId, name, discordBotToken),
          createRole: ({ guildId, name }) => createClanRole(guildId, name, discordBotToken),
          createTextChannel: (input) => createClanTextChannel(input, discordBotToken),
          createVoiceChannel: (input) => createClanVoiceChannel(input, discordBotToken),
          addMemberRole: (guildId, userId, roleId) =>
            addGuildMemberRole(guildId, userId, roleId, discordBotToken),
          removeMemberRole: (guildId, userId, roleId) =>
            removeGuildMemberRole(guildId, userId, roleId, discordBotToken),
          deleteChannel: (channelId) => deleteChannel(channelId, discordBotToken),
          deleteRole: (guildId, roleId) => deleteClanRole(guildId, roleId, discordBotToken),
          setClanArchivedPermissions: (input) => setClanArchivedPermissions(input, discordBotToken),
          inspectClanResources: (input) => inspectClanResources(input, discordBotToken),
        },
        {
          getTier: async (guildId) => (await stores.entitlement.readGuildEntitlement(guildId)).tier,
        },
        envelope.botUserId ?? env.BOT_USER_ID ?? "",
        Date.now,
        () => crypto.randomUUID(),
        (event) => postClanAuditEvent(event, stores.audit, discordBotToken),
      )
    : null;
  const preferenceAwareProductAnalytics = stores
    ? withGuildAnalyticsPreference(createEnvironmentProductAnalytics(env), (guildId) =>
        stores.productAnalyticsPreferences.readEnabled(guildId),
      )
    : createEnvironmentProductAnalytics(env);
  const features = parseFeatureFlags(env);
  const operations = createEnvelopeOperationRunner(envelope, env, logger);
  const memberVerificationService = createGatewayMemberVerificationService({
    envelope,
    botEnv,
    features,
    stores,
    discord,
    branding,
  });
  return {
    env,
    botEnv,
    features,
    operations,
    discord,
    standardDiscord:
      discordBotToken === env.DISCORD_BOT_TOKEN
        ? discord
        : actorView(
            createGatewayDiscordCapabilities(env.DISCORD_BOT_TOKEN, overrides.guildResources),
          ),
    mentionProtection: stores
      ? createMentionProtectionMessageDependencies(botEnv, stores, discord)
      : null,
    stores,
    clanService,
    memberVerificationService,
    productAnalytics: overrides.waitUntil
      ? withProductAnalyticsWaitUntil(preferenceAwareProductAnalytics, overrides.waitUntil)
      : preferenceAwareProductAnalytics,
    resolveBotDisplayName: (guildId) => branding.resolveBotDisplayName(guildId),
    resolveFooterText: (guildId) => branding.resolveFooterText(guildId),
  };
}

function createGatewayMemberVerificationService(input: {
  envelope: GatewayEventEnvelope;
  botEnv: Env;
  features: ReturnType<typeof parseFeatureFlags>;
  stores: GatewayEventStores | null;
  discord: ReturnType<typeof createGatewayDiscordCapabilities>;
  branding: ReturnType<typeof createGuildBrandingResolver>;
}): MemberVerificationService | null {
  const { envelope, botEnv, features, stores, discord, branding } = input;
  const guildId = extractGatewayGuildId(envelope);
  if (envelope.type !== "GUILD_MEMBER_ADD" || !features.memberVerification || !stores || !guildId) {
    return null;
  }

  const componentIdSigner = botEnv.COMPONENT_ID_SIGNING_SECRET
    ? createComponentIdSigner({
        currentSecret: botEnv.COMPONENT_ID_SIGNING_SECRET,
        previousSecret: botEnv.COMPONENT_ID_PREVIOUS_SIGNING_SECRET,
      })
    : undefined;

  return createMemberVerificationService({
    store: stores.memberVerification,
    guildEntitlementStore: stores.entitlement,
    guildResources: discord.guildResources,
    guildAuditLogStore: stores.audit,
    discordBotToken: botEnv.DISCORD_BOT_TOKEN,
    addGuildMemberRole: (nextGuildId, userId, roleId) =>
      discord.addGuildMemberRole(nextGuildId, userId, roleId),
    guildMemberHasRole: (nextGuildId, userId, roleId) =>
      discord.guildMemberHasRole(nextGuildId, userId, roleId),
    resolveGuildName: async (nextGuildId) => {
      try {
        return (await discord.fetchGuildSummary(nextGuildId)).name;
      } catch {
        return null;
      }
    },
    sendUserDm: async (userId, body) =>
      discord.createUserDmMessage(
        userId,
        withGatewayMessageNonce(
          await signSensitiveMessageComponentIds(body, componentIdSigner, {
            guildId,
            actorUserId: userId,
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
          }),
          envelope.eventKey,
          "member-add:verification-role:dm",
          userId,
        ),
      ),
    createChannelMessage: (channelId, body) =>
      discord.createChannelMessage(
        channelId,
        withGatewayMessageNonce(
          body,
          envelope.eventKey,
          "member-add:verification-role:message",
          channelId,
        ),
      ),
    editChannelMessage: (channelId, messageId, body) =>
      discord.editChannelMessage(channelId, messageId, body).then(() => undefined),
    resolveFooterText: (nextGuildId) => branding.resolveFooterText(nextGuildId),
    platformLinkStore: stores.platformLink,
    steamLinkAvailable: features.steamLink,
    postAudit: (eventId, data) =>
      postMemberAuditEvent(
        eventId,
        data,
        stores.audit,
        botEnv.DISCORD_BOT_TOKEN,
        true,
        deriveGatewayOperationNonce(
          envelope.eventKey,
          `member-add:verification-role:audit:${eventId}`,
        ),
      ),
  });
}

export function withGatewayMessageNonce(
  body: CreateChannelMessageInput,
  eventKey: string,
  handlerKey: string,
  destinationId: string,
): CreateChannelMessageInput {
  return {
    ...body,
    nonce: deriveGatewayOperationNonce(eventKey, `${handlerKey}:${destinationId}`),
    enforce_nonce: true,
  };
}

export function createEnvelopeOperationRunner(
  envelope: GatewayEventEnvelope,
  env: Env,
  logger: GatewayEventQueueLogger,
): GatewayEventOperationRunner {
  if (!env.HAF_DB) {
    return {
      async run(_handlerKey, operation) {
        await operation();
        return true;
      },
      async runResult(_handlerKey, operation) {
        return operation();
      },
      async hasStarted() {
        return false;
      },
    };
  }
  return createGatewayEventOperationRunner({
    eventKey: envelope.eventKey,
    store: createGatewayEventOperationStore(env.HAF_DB),
    emit(event) {
      logger.info?.("gateway_event_idempotency", event);
    },
  });
}

async function shouldSuppressStandardBotEnvelope(
  envelope: GatewayEventEnvelope,
  whiteLabelStore: ReturnType<typeof createCloudflareWhiteLabelBotStore> | undefined,
  guildServiceSuspensionStore:
    | ReturnType<typeof createCloudflareGuildServiceSuspensionStore>
    | undefined,
): Promise<boolean> {
  if (!whiteLabelStore || envelope.botIdentityId !== "standard") return false;
  const guildId = extractGatewayGuildId(envelope);
  if (!guildId) return false;
  if (
    envelope.type === "GUILD_CREATE" &&
    (await guildServiceSuspensionStore?.readActiveSuspension(guildId))
  ) {
    return false;
  }
  const whiteLabelBot = await whiteLabelStore.readWhiteLabelBot(guildId);
  return whiteLabelBot?.status === "active";
}

async function resolveGatewayDiscordBotToken(
  envelope: GatewayEventEnvelope,
  env: Env,
  whiteLabelStore: ReturnType<typeof createCloudflareWhiteLabelBotStore> | undefined,
): Promise<string> {
  const botIdentityId = envelope.botIdentityId?.trim();
  if (!botIdentityId || botIdentityId === "standard") return env.DISCORD_BOT_TOKEN;
  if (!botIdentityId.startsWith("white-label:")) {
    throw new QueueTerminalError(
      "unknown_bot_identity",
      `Unknown gateway bot identity ${botIdentityId}.`,
    );
  }
  const guildId = botIdentityId.slice("white-label:".length).trim();
  if (!guildId) {
    throw new QueueTerminalError(
      "invalid_bot_identity",
      "White-Label Bot identity has no Guild ID.",
    );
  }
  const eventGuildId = extractGatewayGuildId(envelope);
  if (eventGuildId && eventGuildId !== guildId) {
    throw new QueueTerminalError(
      "bot_identity_guild_mismatch",
      "White-Label Bot gateway identity does not match the event Guild.",
    );
  }
  if (!whiteLabelStore) {
    throw new QueueTerminalError("missing_haf_db", "White-Label Bot routing requires HAF_DB.");
  }
  const bot = await whiteLabelStore.readWhiteLabelBot(guildId);
  if (!bot || bot.status !== "active") {
    throw new QueueTerminalError(
      "inactive_bot_identity",
      `White-Label Bot identity ${botIdentityId} is not active.`,
    );
  }
  if (envelope.botUserId && envelope.botUserId !== bot.botUserId) {
    throw new QueueTerminalError(
      "bot_user_mismatch",
      "White-Label Bot gateway identity does not match the active bot user.",
    );
  }
  return resolveWhiteLabelBotToken(env, bot.tokenSecretRef);
}

function resolveWhiteLabelBotToken(env: Env, secretRef: string): string {
  const binding = secretRef.startsWith("secrets-store:") ? secretRef.split(":").at(-1) : secretRef;
  if (!binding) {
    throw new QueueTerminalError(
      "invalid_token_secret_ref",
      "Bot token secret reference is invalid.",
    );
  }
  const token = (env as unknown as Record<string, unknown>)[binding];
  if (typeof token !== "string" || !token.trim()) {
    throw new QueueTerminalError(
      "missing_token_binding",
      `White-Label Bot token binding ${binding} is not configured.`,
    );
  }
  return token;
}

function extractGatewayGuildId(envelope: GatewayEventEnvelope): string | null {
  if (!isRecord(envelope.data)) return null;
  const guildId = envelope.data.guild_id;
  if (typeof guildId === "string" && guildId) return guildId;
  if (envelope.type === "GUILD_CREATE" || envelope.type === "GUILD_DELETE") {
    const id = envelope.data.id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}
