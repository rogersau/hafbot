import { allowUserMentions } from "../discord";
import { DiscordApiError } from "../discord/client";
import type { Env } from "../env";
import type {
  MentionProtectionActionKey,
  MentionProtectionActionStatus,
  MentionProtectionBreach,
} from "../types";
import { assignTimedRole } from "../services/timed-roles/assign-timed-role";
import { postMessageAuditEvent } from "../services/guild-audit-log-service";
import type { MentionProtectionMessageDependencies } from "../services/mention-protection/message-handler";
import { createCloudflareMentionProtectionStore } from "./cloudflare-mention-protection-store";
import { createCloudflareGuildEntitlementStore } from "./cloudflare-guild-entitlement-store";
import { createCloudflareGuildAuditLogStore } from "./cloudflare-guild-audit-log-store";
import { createCloudflareTimedRoleStore } from "./cloudflare-timed-role-store";
import type { GatewayDiscordCapabilities } from "./gateway-events/discord-capabilities";

type MentionProtectionRuntimeEnv = Pick<Env, "HAF_DB" | "BOT_USER_ID" | "DISCORD_BOT_TOKEN">;

export function createMentionProtectionMessageDependencies(
  env: MentionProtectionRuntimeEnv,
  stores: {
    mentionProtection: ReturnType<typeof createCloudflareMentionProtectionStore>;
    entitlement: ReturnType<typeof createCloudflareGuildEntitlementStore>;
    timedRole: ReturnType<typeof createCloudflareTimedRoleStore>;
    audit: ReturnType<typeof createCloudflareGuildAuditLogStore>;
  },
  discord: GatewayDiscordCapabilities,
): MentionProtectionMessageDependencies {
  if (!env.HAF_DB) throw new Error("Mention Protection requires HAF_DB.");
  const store = stores.mentionProtection;
  const entitlementStore = stores.entitlement;
  const timedRoleStore = stores.timedRole;
  const auditStore = stores.audit;
  const botToken = env.DISCORD_BOT_TOKEN;

  return {
    now: () => Date.now(),
    readConfig: (guildId) => store.readConfig(guildId),
    readGuildEntitlement: (guildId) => entitlementStore.readGuildEntitlement(guildId),
    resolveChannelParent: (channelId) => discord.getChannelParent(channelId),
    fetchGuildMember: (guildId, userId) => discord.fetchGuildMember(guildId, userId),
    fetchMessage: (channelId, messageId) => discord.fetchChannelMessage(channelId, messageId),
    recordBurstMessage: (input) => store.recordBurstMessage(input),
    claimMessageBreaches: (input) => store.claimMessageBreaches(input),
    claimAction: (guildId, messageId, action) => store.claimAction(guildId, messageId, action),
    recordActionOutcome: (outcome) => store.recordActionOutcome(outcome),
    createWarningReply: async (channelId, messageId, _userId, content) => {
      await discord.createChannelMessage(channelId, {
        content,
        message_reference: { message_id: messageId, channel_id: channelId },
        allowed_mentions: { parse: [], replied_user: true },
        nonce: messageId,
        enforce_nonce: true,
      });
    },
    createWarningFallback: async (channelId, messageId, userId, content) => {
      await discord.createChannelMessage(channelId, {
        content: `<@${userId}> ${content}`,
        allowed_mentions: allowUserMentions([userId]),
        nonce: messageId,
        enforce_nonce: true,
      });
    },
    deleteMessage: async (channelId, messageId) => {
      try {
        await discord.deleteChannelMessage(channelId, messageId);
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) return;
        throw error;
      }
    },
    readMemberTimeoutUntil: async (guildId, userId) => {
      const member = await discord.fetchGuildMember(guildId, userId);
      const value = member?.communication_disabled_until;
      if (!value) return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    },
    applyMemberTimeout: async (guildId, userId, untilMs) => {
      await discord.applyGuildMemberTimeout(guildId, userId, untilMs);
    },
    readTimedRole: async (guildId, userId, roleId) => {
      const assignments = await timedRoleStore.listTimedRolesByGuild(guildId);
      return (
        assignments.find(
          (assignment) => assignment.userId === userId && assignment.roleId === roleId,
        ) ?? null
      );
    },
    memberHasRole: async (guildId, userId, roleId) => {
      const member = await discord.fetchGuildMember(guildId, userId);
      return member?.roles?.includes(roleId) ?? false;
    },
    assignTimedRole: (assignment) =>
      assignTimedRole(
        timedRoleStore,
        (guildId, userId, roleId) => discord.addGuildMemberRole(guildId, userId, roleId),
        assignment,
      ),
    extendTimedRole: (assignment) => timedRoleStore.upsertTimedRole(assignment),
    postDeletionAuditEvent: (breaches, outcomes) =>
      postMentionProtectionAuditEvent(breaches, outcomes, auditStore, botToken, env.BOT_USER_ID),
  };
}

async function postMentionProtectionAuditEvent(
  breaches: MentionProtectionBreach[],
  outcomes: Array<{ action: MentionProtectionActionKey; status: MentionProtectionActionStatus }>,
  store: ReturnType<typeof createCloudflareGuildAuditLogStore>,
  botToken: string,
  botUserId: string,
): Promise<void> {
  const first = breaches[0];
  if (!first) return;
  await postMessageAuditEvent(
    "mention-protection.delete",
    {
      guildId: first.guildId,
      channelId: first.channelId,
      messageId: first.messageId,
      content: first.contentSnapshot,
      author: { id: first.userId },
      mentionProtection: {
        protections: breaches.map((breach) =>
          breach.protection === "admin" ? "Admin Mention Protection" : "Mention Spam Protection",
        ),
        conditions: breaches.map((breach) => breach.condition),
        stages: breaches.map((breach) => breach.stage),
        actionOutcomes: outcomes.map((outcome) => `${outcome.action}: ${outcome.status}`),
      },
    },
    store,
    botToken,
    botUserId,
    true,
  );
}
