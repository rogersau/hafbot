import type { AuditEventId, DiscordMessageDelete, DiscordMessageUpdate } from "../../../types";
import {
  postMemberAuditEvent,
  postMessageAuditEvent,
  postStructureAuditEvent,
} from "../../../services/guild-audit-log-service";
import { handleManagedMessageCanonicalDelete } from "../../../services/managed-message-service";
import type {
  DiscordGuildMemberAdd,
  DiscordGuildMemberUpdate,
} from "../../../services/gateway/event-types";
import { deriveGatewayOperationNonce } from "../../gateway-event-idempotency";
import { defineGatewayEventHandler } from "../define-handler";

export const auditGatewayHandlers = [
  defineGatewayEventHandler(["env", "botEnv"], ["audit", "managedMessage"], {
    key: "managed-message-delete",
    eventTypes: ["MESSAGE_DELETE"],
    order: 50,

    async handle({ stores, botEnv }, envelope) {
      const data = envelope.data as DiscordMessageDelete | null;
      if (!data?.guild_id || !data.channel_id || !data.id) return;
      const handled = await handleManagedMessageCanonicalDelete(
        { guildId: data.guild_id, channelId: data.channel_id, messageId: data.id },
        {
          store: stores.managedMessage,
          guildAuditLog: stores.audit,
          discordBotToken: botEnv.DISCORD_BOT_TOKEN,
        },
      );
      return handled ? "stop" : "continue";
    },
  }),
  defineGatewayEventHandler(["env", "botEnv", "operations"], ["audit"], {
    key: "message-audit",
    eventTypes: ["MESSAGE_UPDATE", "MESSAGE_DELETE"],
    order: 60,

    async handle({ env, botEnv, operations, stores }, envelope) {
      const data = envelope.data as DiscordMessageUpdate | DiscordMessageDelete | null;
      if (!data?.guild_id || !data.channel_id) return;
      const isUpdate = envelope.type === "MESSAGE_UPDATE";
      const handlerKey = isUpdate ? "message-update:audit-post" : "message-delete:audit-post";
      const oldContent = isUpdate
        ? (data as DiscordMessageUpdate & { old_content?: unknown }).old_content
        : undefined;
      await operations.run(handlerKey, () =>
        postMessageAuditEvent(
          isUpdate ? "message.update" : "message.delete",
          {
            guildId: data.guild_id!,
            channelId: data.channel_id!,
            messageId: data.id,
            content: typeof data.content === "string" ? data.content : undefined,
            ...(typeof oldContent === "string" ? { oldContent } : {}),
            author: data.author,
            memberRoleIds: data.member?.roles,
          },
          stores.audit,
          botEnv.DISCORD_BOT_TOKEN,
          env.BOT_USER_ID,
          true,
          deriveGatewayOperationNonce(envelope.eventKey, handlerKey),
        ),
      );
    },
  }),
  defineGatewayEventHandler(["env", "botEnv", "operations"], ["audit"], {
    key: "member-audit",
    eventTypes: ["GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE"],
    order: 60,

    async handle({ botEnv, operations, stores }, envelope) {
      const data = envelope.data as DiscordGuildMemberAdd | DiscordGuildMemberUpdate | null;
      if (!data?.guild_id) return;
      const store = stores.audit;
      if (envelope.type === "GUILD_MEMBER_ADD") {
        await operations.run("member-add:audit-post", () =>
          postMemberAuditEvent(
            "member.join",
            { guildId: data.guild_id!, user: data.user, nick: data.nick },
            store,
            botEnv.DISCORD_BOT_TOKEN,
            true,
            deriveGatewayOperationNonce(envelope.eventKey, "member-add:audit-post"),
          ),
        );
        return;
      }
      if (envelope.type === "GUILD_MEMBER_REMOVE") {
        await operations.run("member-remove:audit-post", () =>
          postMemberAuditEvent(
            "member.leave",
            { guildId: data.guild_id!, user: data.user },
            store,
            botEnv.DISCORD_BOT_TOKEN,
            true,
            deriveGatewayOperationNonce(envelope.eventKey, "member-remove:audit-post"),
          ),
        );
        return;
      }
      const update = data as DiscordGuildMemberUpdate;
      const currentRoles = update.roles ?? [];
      const previousRoles = envelope.previousRoleIds ?? [];
      const addedRoles = currentRoles.filter((roleId) => !previousRoles.includes(roleId));
      const removedRoles = previousRoles.filter((roleId) => !currentRoles.includes(roleId));
      if (addedRoles.length > 0) {
        await operations.run("member-update:audit-role-assign", () =>
          postMemberAuditEvent(
            "member.role-assign",
            {
              guildId: data.guild_id!,
              user: data.user,
              roles: addedRoles,
              memberRoleIds: Array.isArray(update.roles) ? currentRoles : undefined,
            },
            store,
            botEnv.DISCORD_BOT_TOKEN,
            true,
            deriveGatewayOperationNonce(envelope.eventKey, "member-update:audit-role-assign"),
          ),
        );
      }
      if (removedRoles.length > 0) {
        await operations.run("member-update:audit-role-remove", () =>
          postMemberAuditEvent(
            "member.role-remove",
            {
              guildId: data.guild_id!,
              user: data.user,
              roles: removedRoles,
              memberRoleIds: Array.isArray(update.roles) ? currentRoles : undefined,
            },
            store,
            botEnv.DISCORD_BOT_TOKEN,
            true,
            deriveGatewayOperationNonce(envelope.eventKey, "member-update:audit-role-remove"),
          ),
        );
      }
      const currentNick = update.nick ?? null;
      if (envelope.previousNick !== undefined && envelope.previousNick !== currentNick) {
        await operations.run("member-update:audit-nickname", () =>
          postMemberAuditEvent(
            "member.nickname-change",
            {
              guildId: data.guild_id!,
              user: data.user,
              oldNick: envelope.previousNick,
              nick: currentNick,
              memberRoleIds: Array.isArray(update.roles) ? currentRoles : undefined,
            },
            store,
            botEnv.DISCORD_BOT_TOKEN,
            true,
            deriveGatewayOperationNonce(envelope.eventKey, "member-update:audit-nickname"),
          ),
        );
      }
    },
  }),
  defineGatewayEventHandler(["env", "botEnv", "operations"], ["audit"], {
    key: "ban-audit",
    eventTypes: ["GUILD_BAN_ADD", "GUILD_BAN_REMOVE"],
    order: 60,

    async handle({ botEnv, operations, stores }, envelope) {
      const data = envelope.data as {
        guild_id?: string;
        user?: { id?: string; username?: string; global_name?: string | null };
      } | null;
      if (!data?.guild_id) return;
      const eventId = envelope.type === "GUILD_BAN_ADD" ? "member.ban" : "member.unban";
      const handlerKey = `ban:${eventId}:audit-post`;
      await operations.run(handlerKey, () =>
        postMemberAuditEvent(
          eventId,
          { guildId: data.guild_id!, user: data.user },
          stores.audit,
          botEnv.DISCORD_BOT_TOKEN,
          true,
          deriveGatewayOperationNonce(envelope.eventKey, handlerKey),
        ),
      );
    },
  }),
  defineGatewayEventHandler(["env", "botEnv", "operations"], ["audit"], {
    key: "structure-audit",
    eventTypes: ["INVITE_CREATE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"],
    order: 60,

    async handle({ env, botEnv, operations, stores }, envelope) {
      const store = stores.audit;
      if (envelope.type === "INVITE_CREATE") {
        const data = envelope.data as {
          guild_id?: string;
          channel_id?: string;
          code?: string;
          inviter?: { id?: string; username?: string; global_name?: string | null };
        } | null;
        if (!data?.guild_id || !data.channel_id) return;
        await operations.run("invite-create:audit-post", () =>
          postStructureAuditEvent(
            "guild-structure.invite-create",
            {
              guildId: data.guild_id!,
              channelId: data.channel_id!,
              inviteCode: data.code,
              inviter: data.inviter,
            },
            store,
            botEnv.DISCORD_BOT_TOKEN,
            env.BOT_USER_ID,
            true,
            deriveGatewayOperationNonce(envelope.eventKey, "invite-create:audit-post"),
          ),
        );
        return;
      }
      const data = envelope.data as {
        guild_id?: string;
        id?: string;
        name?: string;
        type?: number;
      } | null;
      const eventMap: Record<string, AuditEventId> = {
        CHANNEL_CREATE: "guild-structure.channel-create",
        CHANNEL_UPDATE: "guild-structure.channel-update",
        CHANNEL_DELETE: "guild-structure.channel-delete",
      };
      const eventId = eventMap[envelope.type];
      if (!eventId || !data?.guild_id || !data.id) return;
      const handlerKey = `channel:${eventId}:audit-post`;
      await operations.run(handlerKey, () =>
        postStructureAuditEvent(
          eventId,
          {
            guildId: data.guild_id!,
            channelId: data.id!,
            channelName: data.name,
            channelType: data.type,
          },
          store,
          botEnv.DISCORD_BOT_TOKEN,
          env.BOT_USER_ID,
          true,
          deriveGatewayOperationNonce(envelope.eventKey, handlerKey),
        ),
      );
    },
  }),
];
