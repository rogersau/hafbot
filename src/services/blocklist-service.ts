import type {
  BlocklistStore,
  GuildEntitlementStore,
  GuildAuditLogStore,
} from "../runtime/contracts";
import { normalizeBlocklistEmoji, normalizeBlocklistEmojis } from "../blocklist";
import { getGuildEntitlementLimits, type ChannelFilterMode } from "../types";
import { isAtLimit, QuantityLimitError } from "../runtime/entitlement-checks";
import {
  buildBlocklistUpdateMessage,
  postGuildActivityUpdate,
  type ChannelMessageSender,
  type GuildNotificationChannelStore,
  type ActionActor,
} from "./activity-log";

export interface BlocklistMutation {
  guildId: string;
  action: "add" | "remove";
  emoji: string;
}

export class BlocklistService {
  constructor(
    private readonly store: BlocklistStore & Partial<GuildNotificationChannelStore>,
    private readonly sendChannelMessage?: ChannelMessageSender,
    private readonly guildEntitlementStore?: GuildEntitlementStore,
    private readonly auditLogStore?: GuildAuditLogStore,
  ) {}

  async setEnabled(guildId: string, enabled: boolean): Promise<void> {
    if (!this.store.setGuildEnabled) throw new Error("Blocklist availability is unavailable.");
    await this.store.setGuildEnabled(guildId, enabled);
  }

  async applyMutation(mutation: BlocklistMutation): Promise<void> {
    await this.store.applyGuildEmojiMutation(mutation);
  }

  async getGuildBlocklist(guildId: string): Promise<{
    enabled: boolean;
    emojis: string[];
    channelMode: ChannelFilterMode;
    channelIds: string[];
  }> {
    const config = await this.store.readConfig();
    const guildConfig = config.guilds?.[guildId];
    return {
      enabled: guildConfig?.enabled ?? true,
      emojis: guildConfig?.emojis ?? [],
      channelMode: guildConfig?.channelMode ?? "include",
      channelIds: guildConfig?.channelIds ?? [],
    };
  }

  async getGuildNotificationChannel(guildId: string): Promise<string | null> {
    if (typeof this.store.readGuildNotificationChannel !== "function") {
      return null;
    }

    return this.store.readGuildNotificationChannel(guildId, "blocklist");
  }

  async updateGuildNotificationChannel(
    guildId: string,
    notificationChannelId: string | null,
  ): Promise<void> {
    if (typeof this.store.upsertGuildNotificationChannel !== "function") {
      return;
    }

    await this.store.upsertGuildNotificationChannel({
      guildId,
      feature: "blocklist",
      notificationChannelId,
    });
  }

  async updateGuildChannelFilter(
    guildId: string,
    channelMode: ChannelFilterMode,
    channelIds: string[],
  ): Promise<void> {
    if (typeof this.store.upsertGuildChannelFilter !== "function") {
      return;
    }

    await this.store.upsertGuildChannelFilter({ guildId, channelMode, channelIds });
  }

  async addEmoji(
    guildId: string,
    emoji: string,
    actor?: ActionActor,
  ): Promise<{ alreadyBlocked: boolean }> {
    const guildConfig = await this.getGuildBlocklist(guildId);
    const isAlreadyBlocked = guildConfig.emojis.includes(emoji);

    if (!isAlreadyBlocked) {
      if (this.guildEntitlementStore) {
        const entitlement = await this.guildEntitlementStore.readGuildEntitlement(guildId);
        const max = getGuildEntitlementLimits(entitlement.tier).blocklistMaxEmojis;
        if (isAtLimit(guildConfig.emojis.length, max)) {
          throw new QuantityLimitError(
            "Free servers can block up to 10 emojis. Upgrade to premium for unlimited blocklist entries.",
          );
        }
      }

      await this.applyMutation({ guildId, emoji, action: "add" });
      await postGuildActivityUpdate(
        this.store,
        this.sendChannelMessage,
        guildId,
        "blocklist",
        buildBlocklistUpdateMessage({ action: "add", emojis: [emoji], actor }),
        this.auditLogStore,
        "reaction-rule.config-change",
      );
    }

    return { alreadyBlocked: isAlreadyBlocked };
  }

  async addEmojis(
    guildId: string,
    emojis: string[],
    actor?: ActionActor,
  ): Promise<{ added: string[]; alreadyBlocked: string[] }> {
    const normalizedEmojis = normalizeBlocklistEmojis(emojis);
    const guildConfig = await this.getGuildBlocklist(guildId);
    const existingEmojis = normalizeBlocklistEmojis(guildConfig.emojis);
    const alreadyBlocked: string[] = [];
    const added: string[] = [];

    for (const emoji of normalizedEmojis) {
      if (existingEmojis.includes(emoji)) {
        alreadyBlocked.push(emoji);
      } else {
        added.push(emoji);
      }
    }

    if (added.length > 0) {
      if (this.guildEntitlementStore) {
        const entitlement = await this.guildEntitlementStore.readGuildEntitlement(guildId);
        const max = getGuildEntitlementLimits(entitlement.tier).blocklistMaxEmojis;
        if (max !== null && existingEmojis.length + added.length > max) {
          throw new QuantityLimitError(
            "Free servers can block up to 10 emojis. Upgrade to premium for unlimited blocklist entries.",
          );
        }
      }

      if (added.length > 1 && typeof this.store.applyGuildEmojiMutations === "function") {
        await this.store.applyGuildEmojiMutations({ guildId, emojis: added, action: "add" });
      } else {
        for (const emoji of added) {
          await this.applyMutation({ guildId, emoji, action: "add" });
        }
      }

      await postGuildActivityUpdate(
        this.store,
        this.sendChannelMessage,
        guildId,
        "blocklist",
        buildBlocklistUpdateMessage({ action: "add", emojis: added, actor }),
        this.auditLogStore,
        "reaction-rule.config-change",
      );
    }

    return { added, alreadyBlocked };
  }

  async removeEmoji(
    guildId: string,
    emoji: string,
    actor?: ActionActor,
  ): Promise<{ wasBlocked: boolean }> {
    const normalizedEmoji = normalizeBlocklistEmoji(emoji);
    if (!normalizedEmoji) {
      return { wasBlocked: false };
    }

    const guildConfig = await this.getGuildBlocklist(guildId);
    const isBlocked = normalizeBlocklistEmojis(guildConfig.emojis).includes(normalizedEmoji);

    if (isBlocked) {
      await this.applyMutation({ guildId, emoji: normalizedEmoji, action: "remove" });
      await postGuildActivityUpdate(
        this.store,
        this.sendChannelMessage,
        guildId,
        "blocklist",
        buildBlocklistUpdateMessage({ action: "remove", emojis: [normalizedEmoji], actor }),
        this.auditLogStore,
        "reaction-rule.config-change",
      );
    }

    return { wasBlocked: isBlocked };
  }
}
