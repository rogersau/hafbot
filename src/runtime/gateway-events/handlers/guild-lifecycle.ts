import { createCloudflareObservationStore } from "../../attendance-observation-runtime";
import {
  buildAuditEmbed,
  type DiscordEmbed,
  type DiscordEmbedField,
} from "../../../discord/messages";
import type { DiscordGatewayGuildLifecycle } from "../../../services/gateway/event-types";
import { deriveGatewayOperationNonce } from "../../gateway-event-idempotency";
import type { GatewayEventCapabilities } from "../contracts";
import { defineGatewayEventHandler } from "../define-handler";
import { createCloudflareGuildServiceSuspensionStore } from "../../cloudflare-guild-service-suspension-store";
import { createCloudflareServerLevelStore } from "../../cloudflare-server-level-store";

export const guildLifecycleGatewayHandler = defineGatewayEventHandler(
  ["env", "operations", "discord", "standardDiscord", "productAnalytics"],
  ["knownGuild"],
  {
    key: "guild-lifecycle",
    eventTypes: ["GUILD_CREATE", "GUILD_DELETE"],
    order: 10,
    isEnabled: ({ env }) => Boolean(env.HAF_DB),
    async handle(
      { env, operations, stores, discord, standardDiscord, productAnalytics },
      envelope,
    ) {
      const guild = envelope.data as DiscordGatewayGuildLifecycle | null;
      const guildId = guild?.id?.trim();
      if (
        envelope.type === "GUILD_CREATE" &&
        guildId &&
        guildId !== env.HAF_ADMIN_GUILD_ID?.trim() &&
        env.HAF_DB &&
        (await createCloudflareGuildServiceSuspensionStore(env.HAF_DB).readActiveSuspension(
          guildId,
        ))
      ) {
        await operations.run("guild-lifecycle:suspended-auto-leave", () =>
          discord.leaveGuild(guildId),
        );
        return "stop";
      }
      await operations.run(`guild-lifecycle:${envelope.type}`, () =>
        logGlobalAdminGuildLifecycle(
          envelope.type as "GUILD_CREATE" | "GUILD_DELETE",
          guild,
          env,
          stores!.knownGuild,
          standardDiscord,
          productAnalytics,
          deriveGatewayOperationNonce(envelope.eventKey, `guild-lifecycle:${envelope.type}`),
        ),
      );
      await operations.run(`server-levels:guild-lifecycle:${envelope.type}`, () =>
        updateServerLevelGuildLifecycle(
          envelope.type as "GUILD_CREATE" | "GUILD_DELETE",
          guild,
          env,
        ),
      );
    },
  },
);

async function updateServerLevelGuildLifecycle(
  eventType: "GUILD_CREATE" | "GUILD_DELETE",
  guild: DiscordGatewayGuildLifecycle | null,
  env: GatewayEventCapabilities["env"],
): Promise<void> {
  const guildId = guild?.id?.trim();
  if (!guildId || !env.HAF_DB) return;
  if (
    eventType === "GUILD_DELETE" &&
    (guild as (DiscordGatewayGuildLifecycle & { unavailable?: boolean }) | null)?.unavailable ===
      true
  )
    return;
  if (eventType === "GUILD_DELETE")
    await createCloudflareObservationStore(env.HAF_DB).eraseGuild(guildId);
  const store = createCloudflareServerLevelStore(env.HAF_DB);
  const config = await store.readConfig(guildId);
  if (!config) return;
  const now = Date.now();
  if (eventType === "GUILD_CREATE") {
    if (config.removedAtMs !== null) {
      await store.upsertConfig({ ...config, enabled: false, removedAtMs: null, updatedAtMs: now });
    }
    return;
  }
  for (const server of await store.listConfiguredGameServers(guildId)) {
    await store.closeAllEarningSessions(server.id, now, "guild_uninstalled");
    await store.clearCurrentPresence(guildId, server.id);
  }
  await store.upsertConfig({ ...config, enabled: false, removedAtMs: now, updatedAtMs: now });
}

async function logGlobalAdminGuildLifecycle(
  eventType: "GUILD_CREATE" | "GUILD_DELETE",
  guild: DiscordGatewayGuildLifecycle | null,
  env: GatewayEventCapabilities["env"],
  store: NonNullable<GatewayEventCapabilities["stores"]>["knownGuild"],
  discord: GatewayEventCapabilities["discord"],
  productAnalytics: GatewayEventCapabilities["productAnalytics"],
  dedupeNonce: string,
): Promise<void> {
  const channelId = env.GLOBAL_ADMIN_LOG_CHANNEL_ID?.trim();
  const guildId = guild?.id?.trim();
  if (!guildId || !env.HAF_DB) return;
  const now = Date.now();
  const existing = await store.readKnownGuild(guildId);
  const name = guild?.name?.trim() || existing?.name || "Unknown guild";

  if (eventType === "GUILD_CREATE") {
    const created = existing
      ? false
      : await store.insertKnownGuild({
          guildId,
          name,
          memberCount: guild?.member_count ?? 0,
          ownerId: guild?.owner_id?.trim() || "",
          icon: guild?.icon ?? null,
          installedAtMs: now,
          removedAtMs: null,
        });
    if (channelId && (created || existing?.removedAtMs !== null)) {
      await postLifecycleMessage(
        channelId,
        buildInstallEmbed({
          guildId,
          name,
          memberCount: guild?.member_count ?? 0,
          ownerId: guild?.owner_id?.trim() || existing?.ownerId || "",
          icon: guild?.icon ?? null,
        }),
        dedupeNonce,
        discord,
      );
    }
    if (created) {
      void productAnalytics.report({
        name: "guild_installed",
        insertionId: dedupeNonce,
        guildId,
      });
    } else {
      if (existing?.removedAtMs != null) await store.clearRemoved(guildId);
      await store.updateMetadata(guildId, {
        name: guild?.name?.trim(),
        memberCount: guild?.member_count,
        icon: guild?.icon,
      });
    }
    return;
  }

  if (channelId) {
    await postLifecycleMessage(
      channelId,
      existing
        ? buildRemovalEmbed({ guildId, name: existing.name })
        : buildUnknownRemovalEmbed({ guildId, name }),
      dedupeNonce,
      discord,
    );
  }
  if (existing) {
    await store.setRemoved(guildId, now);
  } else {
    await store.upsertKnownGuild({
      guildId,
      name,
      memberCount: guild?.member_count ?? 0,
      ownerId: guild?.owner_id?.trim() || "",
      icon: guild?.icon ?? null,
      installedAtMs: now,
      removedAtMs: now,
    });
  }
}

function postLifecycleMessage(
  channelId: string,
  embed: DiscordEmbed,
  nonce: string,
  discord: GatewayEventCapabilities["discord"],
) {
  return discord.createChannelMessage(channelId, { embeds: [embed], nonce, enforce_nonce: true });
}

function buildInstallEmbed(input: {
  guildId: string;
  name: string;
  memberCount: number;
  ownerId: string;
  icon: string | null;
}): DiscordEmbed {
  const fields: DiscordEmbedField[] = [
    { name: "Guild Name", value: input.name },
    { name: "Guild ID", value: input.guildId },
    { name: "Member Count", value: String(input.memberCount) },
  ];
  if (input.ownerId)
    fields.push({ name: "Owner", value: `<@${input.ownerId}>\nID: ${input.ownerId}` });
  const embed = buildAuditEmbed({ title: "🟢 Bot Installed", color: 0x2ecc71, fields });
  if (input.icon) {
    embed.thumbnail = {
      url: `https://cdn.discordapp.com/icons/${input.guildId}/${input.icon}.png`,
    };
  }
  return embed;
}

function buildRemovalEmbed(input: { guildId: string; name: string }): DiscordEmbed {
  return buildAuditEmbed({
    title: "🔴 Bot Removed",
    color: 0xe74c3c,
    fields: [
      { name: "Guild Name", value: input.name },
      { name: "Guild ID", value: input.guildId },
    ],
  });
}

function buildUnknownRemovalEmbed(input: { guildId: string; name: string }): DiscordEmbed {
  return buildAuditEmbed({
    title: "⚠️ Bot Removed From Unknown Guild",
    color: 0xf1c40f,
    fields: [
      { name: "Guild Name", value: input.name },
      { name: "Guild ID", value: input.guildId },
    ],
  });
}
