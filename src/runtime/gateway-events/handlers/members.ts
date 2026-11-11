import type {
  DiscordGuildMemberAdd,
  DiscordGuildMemberUpdate,
} from "../../../services/gateway/event-types";
import { createPlatformLinkService } from "../../../services/platform-link-service";
import { TimedRoleService } from "../../../services/timed-role-service";
import { resolveMemberDisplayName } from "../../discord-user";
import { deriveGatewayOperationNonce } from "../../gateway-event-idempotency";
import type { GatewayEventCapabilities } from "../contracts";
import { defineGatewayEventHandler, type ScopedGatewayEventCapabilities } from "../define-handler";
import { ServerLevelProcessor } from "../../../server-levels/processor";

type PlatformLinkGatewayCapabilities = ScopedGatewayEventCapabilities<
  "env" | "botEnv" | "operations" | "discord",
  "platformLink"
>;
type TimedRoleGatewayCapabilities = ScopedGatewayEventCapabilities<
  "env" | "botEnv" | "features" | "operations" | "discord",
  "blocklist" | "timedRole"
>;
type MemberVerificationGatewayCapabilities = ScopedGatewayEventCapabilities<
  "env" | "features" | "operations" | "memberVerificationService",
  never
>;

export const memberGatewayHandlers = [
  defineGatewayEventHandler(["env", "botEnv", "operations"], ["platformLink"], {
    key: "platform-link-deactivate",
    eventTypes: ["GUILD_MEMBER_REMOVE"],
    order: 5,

    async handle({ botEnv, operations, stores }, envelope) {
      await operations.run("member-remove:deactivate-platform-links", () =>
        deactivatePlatformLinks(envelope.data as DiscordGuildMemberUpdate | null, botEnv, stores),
      );
    },
  }),
  defineGatewayEventHandler(["env", "botEnv", "operations", "discord"], ["platformLink"], {
    key: "platform-link-restore",
    eventTypes: ["GUILD_MEMBER_ADD"],
    order: 10,

    async handle({ botEnv, operations, stores, discord }, envelope) {
      await operations.run("member-add:restore-linked-roles", () =>
        restorePlatformLinkedRoles(
          envelope.data as DiscordGuildMemberAdd | null,
          botEnv,
          stores,
          discord,
        ),
      );
    },
  }),
  defineGatewayEventHandler(
    ["env", "features", "operations"],
    ["entitlement", "platformLink", "serverLevel"],
    {
      key: "server-level-membership",
      eventTypes: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE"],
      order: 4,
      isEnabled: ({ features }) => Boolean(features.serverLevels !== false),
      async handle({ features, operations, stores }, envelope) {
        const member = envelope.data as DiscordGuildMemberUpdate | null;
        const guildId = member?.guild_id;
        const userId = member?.user?.id;
        if (!guildId || !userId) return;
        await operations.run("server-levels:membership", async () => {
          const now = envelope.receivedAtMs ?? Date.now();
          const current = envelope.type === "GUILD_MEMBER_ADD";
          if (!current) {
            const processor = new ServerLevelProcessor({
              store: stores.serverLevel,
              platformLinks: stores.platformLink,
              readEntitlementTier: async (targetGuildId) =>
                (await stores.entitlement.readGuildEntitlement(targetGuildId)).tier,
              isCurrentGuildMember: async () => false,
              isKillSwitchEnabled: () => features.serverLevels === false,
            });
            await processor.stopEarningForMember({
              guildId,
              userId,
              stoppedAtMs: now,
              sourceId: `gateway-member-departure:${envelope.eventKey}`,
            });
          }
          if (await stores.serverLevel.readProfile(guildId, userId)) {
            await stores.serverLevel.setCurrentMembership(guildId, userId, current, now);
          }
        });
      },
    },
  ),
  defineGatewayEventHandler(
    ["env", "botEnv", "features", "operations", "discord"],
    ["blocklist", "timedRole"],
    {
      key: "timed-roles",
      eventTypes: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE"],
      order: 20,
      isEnabled: ({ features }) => Boolean(features.timedRoles),
      async handle(capabilities, envelope) {
        if (envelope.type === "GUILD_MEMBER_ADD") {
          await handleNewMemberTimedRole(
            envelope.data as DiscordGuildMemberAdd | null,
            capabilities,
            envelope.eventKey,
            envelope.botUserId ?? capabilities.botEnv.BOT_USER_ID,
          );
        } else {
          await handleManualAssignmentTimedRole(
            envelope.data as DiscordGuildMemberUpdate | null,
            capabilities,
            envelope.eventKey,
            envelope.botUserId ?? capabilities.botEnv.BOT_USER_ID,
          );
        }
      },
    },
  ),
  defineGatewayEventHandler(["commerceLifecycle", "operations"], [], {
    key: "commerce-paid-role-membership",
    eventTypes: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE", "GUILD_BAN_ADD", "GUILD_DELETE"],
    order: 25,
    isEnabled: ({ commerceLifecycle }) => Boolean(commerceLifecycle),
    async handle({ commerceLifecycle, operations }, envelope) {
      const data = envelope.data as {
        guild_id?: string;
        user?: { id?: string };
        unavailable?: boolean;
      } | null;
      const guildId =
        data?.guild_id ??
        (envelope.type === "GUILD_DELETE"
          ? (envelope.data as { id?: string } | null)?.id
          : undefined);
      const userId = data?.user?.id;
      if (!guildId || !commerceLifecycle) return;
      await operations.run("commerce:paid-role-membership", async () => {
        if (envelope.type === "GUILD_DELETE") {
          if ((envelope.data as { unavailable?: boolean } | null)?.unavailable === true) return;
          await commerceLifecycle.guildRemoved(guildId, envelope.eventKey);
        } else if (userId) {
          await commerceLifecycle.memberChanged(
            guildId,
            userId,
            envelope.type === "GUILD_BAN_ADD"
              ? "banned"
              : envelope.type === "GUILD_MEMBER_REMOVE"
                ? "left"
                : "rejoined",
            envelope.eventKey,
          );
        }
      });
    },
  }),
  defineGatewayEventHandler(["env", "features", "operations", "memberVerificationService"], [], {
    key: "member-verification",
    eventTypes: ["GUILD_MEMBER_ADD"],
    order: 30,
    isEnabled: ({ features, memberVerificationService }) =>
      Boolean(features.memberVerification && memberVerificationService),
    async handle(capabilities, envelope) {
      await capabilities.operations.run("member-add:verification-role", () =>
        handleMemberVerification(envelope.data as DiscordGuildMemberAdd | null, capabilities),
      );
    },
  }),
];

async function deactivatePlatformLinks(
  member: DiscordGuildMemberUpdate | null,
  env: GatewayEventCapabilities["botEnv"],
  stores: PlatformLinkGatewayCapabilities["stores"],
): Promise<void> {
  if (!member?.guild_id || !member.user?.id) return;
  const service = createPlatformLinkService({
    platformLinkStore: stores.platformLink,
    discordBotToken: env.DISCORD_BOT_TOKEN,
  });
  await service.deactivateLinksOnMemberLeave(member.guild_id, member.user.id);
}

async function restorePlatformLinkedRoles(
  member: DiscordGuildMemberAdd | null,
  env: GatewayEventCapabilities["botEnv"],
  stores: PlatformLinkGatewayCapabilities["stores"],
  discord: PlatformLinkGatewayCapabilities["discord"],
): Promise<void> {
  if (!member?.guild_id || !member.user?.id) return;
  const service = createPlatformLinkService(
    {
      platformLinkStore: stores.platformLink,
      discordBotToken: env.DISCORD_BOT_TOKEN,
    },
    discord.guildResources,
  );
  await service.restoreLinkedRolesOnMemberRejoin(member.guild_id, member.user.id);
}

async function handleNewMemberTimedRole(
  member: DiscordGuildMemberAdd | null,
  capabilities: TimedRoleGatewayCapabilities,
  eventKey: string,
  botUserId?: string | null,
): Promise<void> {
  const { botEnv: env, operations } = capabilities;
  const guildId = member?.guild_id;
  const userId = member?.user?.id;
  if (!guildId || !userId) return;
  const service = createTimedRoleService(
    env,
    operations,
    capabilities.stores,
    capabilities.discord,
    eventKey,
    "member-add",
    botUserId,
  );
  await service.restoreActiveTimedRolesForMember({ guildId, userId });
  await service.assignConfiguredNewMemberRole({
    guildId,
    userId,
    targetDisplayName: resolveMemberDisplayName(member),
  });
}

async function handleManualAssignmentTimedRole(
  member: DiscordGuildMemberUpdate | null,
  capabilities: TimedRoleGatewayCapabilities,
  eventKey: string,
  botUserId?: string | null,
): Promise<void> {
  const { botEnv: env, operations } = capabilities;
  const guildId = member?.guild_id;
  const userId = member?.user?.id;
  if (!guildId || !userId || !Array.isArray(member.roles)) return;
  const service = createTimedRoleService(
    env,
    operations,
    capabilities.stores,
    capabilities.discord,
    eventKey,
    "member-update",
    botUserId,
  );
  await service.createManualAssignmentTimedRole({
    guildId,
    userId,
    roleIds: member.roles,
    targetDisplayName: resolveMemberDisplayName(member),
  });
}

function createTimedRoleService(
  env: GatewayEventCapabilities["botEnv"],
  operations: GatewayEventCapabilities["operations"],
  stores: TimedRoleGatewayCapabilities["stores"],
  discord: GatewayEventCapabilities["discord"],
  eventKey: string,
  eventScope: "member-add" | "member-update",
  botUserId?: string | null,
): TimedRoleService {
  const notificationStore = stores.blocklist;
  return new TimedRoleService(
    stores.timedRole,
    env.DISCORD_BOT_TOKEN,
    discord.guildResources,
    (guildId, userId, roleId) => discord.addGuildMemberRole(guildId, userId, roleId),
    (guildId, userId, roleId) => discord.removeGuildMemberRole(guildId, userId, roleId),
    notificationStore,
    (channelId, body) => discord.createChannelMessage(channelId, body).then(() => undefined),
    (userId, body) => discord.createUserDmMessage(userId, body).then(() => undefined),
    (assignment) => resolveTimedRoleDmContext(assignment.guildId, assignment.roleId, discord),
    undefined,
    undefined,
    operations,
    (kind, assignment, destinationId) =>
      deriveGatewayOperationNonce(
        eventKey,
        `${eventScope}:timed-role:${kind}:${assignment.roleId}:${destinationId}`,
      ),
    async (guildId, userId) => {
      const member = await discord.fetchGuildMember(guildId, userId);
      if (!member || !Array.isArray(member.roles)) {
        throw new Error("The selected member is no longer in this Guild.");
      }
      return member.roles;
    },
    async (guildId) => {
      if (!botUserId) throw new Error("The Discord bot user is not configured.");
      const member = await discord.fetchGuildMember(guildId, botUserId);
      if (!member || !Array.isArray(member.roles)) {
        throw new Error("The bot is no longer in this Guild.");
      }
      return member.roles;
    },
  );
}

async function handleMemberVerification(
  member: DiscordGuildMemberAdd | null,
  capabilities: MemberVerificationGatewayCapabilities,
): Promise<void> {
  const guildId = member?.guild_id;
  const userId = member?.user?.id;
  if (!guildId || !userId || !capabilities.memberVerificationService) return;
  await capabilities.memberVerificationService.handleMemberAdd({
    guildId,
    userId,
    user: member.user,
  });
}

async function resolveTimedRoleDmContext(
  guildId: string,
  roleId: string,
  discord: GatewayEventCapabilities["discord"],
): Promise<{ guildName?: string | null; roleName?: string | null }> {
  const [guild, roles] = await Promise.all([
    discord.fetchGuildSummary(guildId),
    discord.listGuildRoles(guildId),
  ]);
  return {
    guildName: guild.name,
    roleName: roles.find((role) => role.id === roleId)?.name ?? null,
  };
}
