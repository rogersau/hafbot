import { hasGuildAdminPermission } from "../../../discord-interactions";
import { createDiscordSuggestionProjection } from "../../../discord/suggestions";
import { SuggestionService } from "../../../services/suggestion-service";
import { postSuggestionAuditEvent } from "../../../services/guild-audit-log-service";
import { isRecord } from "../../../unknown-parse";
import { defineGatewayEventHandler } from "../define-handler";
import type { GatewayDiscordCapabilities } from "../discord-capabilities";
import type { GuildAuditLogStore, SuggestionStore } from "../../contracts";
import type { WebhookCredentialStore } from "../../../security/webhook-credentials/store";
import { WebhookCredentialService } from "../../../security/webhook-credentials/store";
import {
  createWebhookCredentialKeyRing,
  parseDiscordWebhookCredential,
} from "../../../security/webhook-credentials";
import { createComponentIdSigner } from "../../../security/component-id-signer";

interface SuggestionHandlerCapabilities {
  discord: GatewayDiscordCapabilities;
  stores: {
    suggestion: SuggestionStore;
    audit: GuildAuditLogStore;
    webhookCredential: WebhookCredentialStore;
  } | null;
}

export const suggestionGatewayHandler = defineGatewayEventHandler(
  ["botEnv", "features", "discord", "operations"],
  ["suggestion", "audit", "webhookCredential"],
  {
    key: "suggestions",
    eventTypes: [
      "MESSAGE_REACTION_ADD",
      "MESSAGE_REACTION_REMOVE",
      "MESSAGE_CREATE",
      "GUILD_MEMBER_REMOVE",
    ],
    order: 85,
    isEnabled: ({ features }) => features.suggestions === true,
    async handle(capabilities, envelope) {
      if (!capabilities.stores || !isRecord(envelope.data)) return;
      const store = capabilities.stores.suggestion;
      const credentialKey = capabilities.botEnv.WEBHOOK_CREDENTIAL_KEY_V1;
      const componentIdSigner = capabilities.botEnv.COMPONENT_ID_SIGNING_SECRET
        ? createComponentIdSigner({
            currentSecret: capabilities.botEnv.COMPONENT_ID_SIGNING_SECRET,
            previousSecret: capabilities.botEnv.COMPONENT_ID_PREVIOUS_SIGNING_SECRET,
          })
        : undefined;
      const credentialService = credentialKey
        ? new WebhookCredentialService(
            capabilities.stores.webhookCredential,
            createWebhookCredentialKeyRing({
              keyV1: credentialKey,
              keyV2: capabilities.botEnv.WEBHOOK_CREDENTIAL_KEY_V2,
            }),
          )
        : null;
      let service: SuggestionService;
      service = new SuggestionService(
        store,
        createDiscordSuggestionProjection({
          token: capabilities.botEnv.DISCORD_BOT_TOKEN,
          componentIdSigner,
          guildResources: capabilities.discord.guildResources,
          readConfig: (guildId) => service.getConfig(guildId),
          resolveReplyWebhook: async (guildId, credentialId) => {
            if (!credentialService) {
              throw new Error("Webhook credential encryption is unavailable.");
            }
            const revealed = await credentialService.resolve(credentialId, {
              kind: "suggestion_reply",
              guildId,
              publicId: "reply-webhook",
            });
            const parsed = await parseDiscordWebhookCredential(revealed.url);
            return { id: parsed.webhookId, token: parsed.token };
          },
        }),
        Date.now,
        () => crypto.randomUUID(),
        (event) =>
          postSuggestionAuditEvent(
            event,
            capabilities.stores!.audit,
            capabilities.botEnv.DISCORD_BOT_TOKEN,
          ),
      );
      const data = envelope.data;
      await capabilities.operations.run(`suggestions:${envelope.type.toLowerCase()}`, async () => {
        if (envelope.type === "GUILD_MEMBER_REMOVE") {
          const guildId = stringValue(data, "guild_id");
          const user = recordValue(data, "user");
          const userId = user ? stringValue(user, "id") : null;
          if (guildId && userId) await service.memberLeftGuild(guildId, userId);
          return;
        }
        if (
          envelope.type === "MESSAGE_REACTION_ADD" ||
          envelope.type === "MESSAGE_REACTION_REMOVE"
        ) {
          await handleFlag(capabilities, service, data, envelope.type === "MESSAGE_REACTION_ADD");
          return;
        }
        await enforceStructuredReplies(capabilities, data);
      });
    },
  },
);

async function handleFlag(
  capabilities: SuggestionHandlerCapabilities,
  service: SuggestionService,
  data: Record<string, unknown>,
  active: boolean,
): Promise<void> {
  const guildId = stringValue(data, "guild_id");
  const messageId = stringValue(data, "message_id");
  const userId = stringValue(data, "user_id");
  const emoji = recordValue(data, "emoji");
  if (!guildId || !messageId || !userId || stringValue(emoji ?? {}, "name") !== "🚩") return;
  const reply = await capabilities.stores?.suggestion.readConsideredReplyByMessage(
    guildId,
    messageId,
  );
  if (!reply) return;
  let member = recordValue(data, "member");
  if (!member) {
    const fetched = await capabilities.discord.fetchGuildMember(guildId, userId);
    member = isRecord(fetched) ? fetched : null;
  }
  const user = member ? recordValue(member, "user") : null;
  await service.setReplyFlag({
    guildId,
    replyId: reply.id,
    memberId: userId,
    active,
    member: {
      isBot: user?.bot === true,
      isGuildMember: Boolean(member),
      roleIds: arrayStrings(member?.roles),
      joinedAtMs: dateValue(member?.joined_at),
    },
  });
}

async function enforceStructuredReplies(
  capabilities: SuggestionHandlerCapabilities,
  data: Record<string, unknown>,
): Promise<void> {
  const guildId = stringValue(data, "guild_id");
  const channelId = stringValue(data, "channel_id");
  const messageId = stringValue(data, "id");
  const author = recordValue(data, "author");
  const authorId = author ? stringValue(author, "id") : null;
  if (
    !guildId ||
    !channelId ||
    !messageId ||
    !authorId ||
    author?.bot === true ||
    stringValue(data, "webhook_id")
  )
    return;
  const suggestion = await capabilities.stores?.suggestion.readSuggestionByThread(
    guildId,
    channelId,
  );
  if (!suggestion || suggestion.authorId === authorId) return;
  const config = await capabilities.stores?.suggestion.readConfig(guildId);
  const member = recordValue(data, "member");
  const roles = arrayStrings(member?.roles);
  const permissions = typeof member?.permissions === "string" ? member.permissions : "0";
  const isMod =
    hasGuildAdminPermission(permissions) ||
    Boolean(config?.modRoleIds.some((roleId) => roles.includes(roleId)));
  if (isMod) return;
  await capabilities.discord.deleteChannelMessage(channelId, messageId);
  await capabilities.discord.createChannelMessage(channelId, {
    content: `<@${authorId}> please use **Add Considered Reply** on the Suggestion starter message.`,
    allowed_mentions: { parse: [], users: [authorId] },
  });
}

function recordValue(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(value[key]) ? value[key] : null;
}

function stringValue(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dateValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
