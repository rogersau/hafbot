import { platformLinkFailure, type PlatformLinkSaveWorkflow } from "./platform-link-workflow";
import { addGuildMemberRole, createChannelMessage, removeGuildMemberRole } from "../discord";
import { DiscordApiError } from "../discord/client";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import { buildAuditEmbed, formatStaffUserReference } from "../discord/messages";
import { resolveAuditChannelId } from "./guild-audit-log-service";
import type {
  PlatformLink,
  PlatformLinkConfig,
  PlatformLinkPlatform,
} from "../runtime/contracts/platform-link-store";
import type { GuildAuditLogStore, GuildEntitlementStore } from "../runtime/contracts";
import type { PlatformLinkStore } from "../runtime/contracts/platform-link-store";
import { getGuildEntitlementLimits, type AuditEventId } from "../types";
import { isAtLimit, QuantityLimitError } from "../runtime/entitlement-checks";
import type { PlatformIdentityAdapter } from "./platform-identity-adapter";
import {
  createDeterministicInsertionId,
  type ProductAnalyticsReporter,
  type ProductFailureCode,
} from "../product-analytics";

export interface PlatformLinkServiceOptions {
  platformLinkStore: PlatformLinkStore;
  discordBotToken: string;
  guildEntitlementStore?: GuildEntitlementStore;
  guildAuditLogStore?: GuildAuditLogStore;
  guildResources?: GuildResourceValidator;
  identityAdapters?: Partial<Record<PlatformLinkPlatform, PlatformIdentityAdapter>>;
  productAnalytics?: ProductAnalyticsReporter;
  waitUntil?: (promise: Promise<unknown>) => void;
  onLinksRemoving?: (links: PlatformLink[], removedAtMs: number) => Promise<void>;
  /** Hold processing leases across persistence and removal finalization. */
  onLinksReplacing?: (link: PlatformLink, replaceLinks: () => Promise<void>) => Promise<void>;
}

export class PlatformLinkFinalizationError extends Error {
  constructor(cause: unknown) {
    super("The account was linked, but follow-up processing failed.", { cause });
    this.name = "PlatformLinkFinalizationError";
  }
}

export function createPlatformLinkService(
  options: PlatformLinkServiceOptions,
  guildResourcesOverride?: GuildResourceValidator,
) {
  const guildResources = guildResourcesOverride ?? options.guildResources;
  const readResources = (guildId: string) => guildResources?.forGuild(guildId);
  return {
    async readConfig(
      guildId: string,
      platform: PlatformLinkPlatform,
    ): Promise<PlatformLinkConfig | null> {
      return options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
    },

    async saveConfig(config: PlatformLinkConfig): Promise<void> {
      const resources = guildResources ? await guildResources.forGuild(config.guildId) : null;
      if (config.linkedRoleId) resources?.requireRole(config.linkedRoleId);
      if (config.logChannelId) resources?.requireTextChannel(config.logChannelId);
      if (config.panelChannelId) resources?.requireTextChannel(config.panelChannelId);
      await options.platformLinkStore.upsertPlatformLinkConfig(config);
      if (config.enabled !== undefined)
        await options.platformLinkStore.setPlatformLinkEnabled?.(
          config.guildId,
          config.platform,
          config.enabled,
        );
    },

    async createPendingLink(
      state: string,
      guildId: string,
      userId: string,
      platform: PlatformLinkPlatform,
    ): Promise<void> {
      const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
      if (config?.enabled === false) throw new Error("Account linking is disabled in this server.");
      await options.platformLinkStore.createPendingPlatformLink({
        state,
        guildId,
        userId,
        platform,
        createdAtMs: Date.now(),
      });
    },

    async readPendingLink(state: string) {
      return options.platformLinkStore.readPendingPlatformLink(state);
    },

    async deletePendingLink(state: string): Promise<void> {
      await options.platformLinkStore.deletePendingPlatformLink(state);
    },

    async clearExpiredPendingLinks(nowMs: number): Promise<void> {
      await options.platformLinkStore.clearExpiredPendingPlatformLinks(nowMs);
    },

    async getLink(
      guildId: string,
      userId: string,
      platform: PlatformLinkPlatform,
    ): Promise<PlatformLink | null> {
      return options.platformLinkStore.readPlatformLink(guildId, userId, platform);
    },

    async getLinkEntry(
      guildId: string,
      userId: string,
      platform: PlatformLinkPlatform,
      platformId: string,
    ): Promise<PlatformLink | null> {
      return options.platformLinkStore.readPlatformLinkEntry(guildId, userId, platform, platformId);
    },

    async getLinksByUser(guildId: string, userId: string): Promise<PlatformLink[]> {
      return options.platformLinkStore.listPlatformLinksByUser(guildId, userId);
    },

    async getLinkByPlatformId(
      guildId: string,
      platform: PlatformLinkPlatform,
      platformId: string,
    ): Promise<PlatformLink | null> {
      return options.platformLinkStore.readPlatformLinkByPlatformId(guildId, platform, platformId);
    },

    async saveLink(link: PlatformLink, replaceExisting = false): Promise<void> {
      const currentConfig = await options.platformLinkStore.readPlatformLinkConfig(
        link.guildId,
        link.platform,
      );
      if (currentConfig?.enabled === false)
        throw new Error("Account linking is disabled in this server.");
      let workflow: PlatformLinkSaveWorkflow = { kind: "reading" };
      let replacedLinks: PlatformLink[] = [];
      try {
        if (replaceExisting) {
          replacedLinks = (
            await options.platformLinkStore.listPlatformLinksByUser(link.guildId, link.userId)
          ).filter((existing) => existing.platform === link.platform);
        }
        if (options.guildEntitlementStore) {
          const existing = await options.platformLinkStore.readPlatformLinkEntry(
            link.guildId,
            link.userId,
            link.platform,
            link.platformId,
          );
          if (!existing) {
            const entitlement = await options.guildEntitlementStore.readGuildEntitlement(
              link.guildId,
            );
            const max = getGuildEntitlementLimits(entitlement.tier).platformLinkMaxLinks;
            const links = await options.platformLinkStore.listPlatformLinks(link.guildId);
            if (isAtLimit(links.length - replacedLinks.length, max)) {
              workflow = { kind: "capacity-rejected" };
              throw new QuantityLimitError(
                `This Guild has reached its plan limit of ${max} Platform Links. Upgrade for Unlimited Platform Links.`,
              );
            }
          }
        }

        const adapter = options.identityAdapters?.[link.platform];
        const config = adapter
          ? await options.platformLinkStore.readPlatformLinkConfig(link.guildId, link.platform)
          : null;
        workflow = { kind: "enriching" };
        const metadataJson =
          adapter && config && !link.manual && link.metadataJson === null
            ? await adapter.enrichMetadata(link.platformId, config)
            : link.metadataJson;
        if (
          (await options.platformLinkStore.readPlatformLinkConfig(link.guildId, link.platform))
            ?.enabled === false
        ) {
          throw new Error("Account linking is disabled in this server.");
        }
        workflow = { kind: "persisting" };
        if (replaceExisting) {
          const replacement = { ...link, metadataJson };
          const replaceLinks = async () => {
            if (
              (await options.platformLinkStore.readPlatformLinkConfig(link.guildId, link.platform))
                ?.enabled === false
            )
              throw new Error("Account linking is disabled in this server.");
            await options.platformLinkStore.replacePlatformLinks(replacement);
            workflow = { kind: "committed" };
          };
          if (options.onLinksReplacing) {
            await options.onLinksReplacing(replacement, replaceLinks);
          } else {
            await replaceLinks();
          }
        } else {
          await options.platformLinkStore.upsertPlatformLink({ ...link, metadataJson });
          workflow = { kind: "committed" };
        }
      } catch (error) {
        const failure = platformLinkFailure(workflow);
        if (failure.kind === "finalization-failed") {
          reportLinkOutcome(options, link, "success");
          throw new PlatformLinkFinalizationError(error);
        }
        reportLinkOutcome(options, link, "failure", failure.reason);
        throw error;
      }
      reportLinkOutcome(options, link, "success");
    },

    async deactivateLinksOnMemberLeave(guildId: string, userId: string): Promise<void> {
      const links = await options.platformLinkStore.listPlatformLinksByUser(guildId, userId);
      const platforms = new Set(links.filter((link) => link.active).map((link) => link.platform));

      for (const platform of platforms) {
        const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
        if (!config?.requireRelinkOnRejoin) continue;
        await Promise.all(
          links
            .filter((link) => link.platform === platform && link.active)
            .map((link) =>
              options.platformLinkStore.upsertPlatformLink({ ...link, active: false }),
            ),
        );
      }
    },

    async deleteLink(
      guildId: string,
      userId: string,
      platform?: PlatformLinkPlatform,
      platformId?: string,
    ): Promise<void> {
      const links = (
        await options.platformLinkStore.listPlatformLinksByUser(guildId, userId)
      ).filter(
        (link) =>
          (platform === undefined || link.platform === platform) &&
          (platformId === undefined || link.platformId === platformId),
      );
      if (links.length > 0) await options.onLinksRemoving?.(links, Date.now());
      await options.platformLinkStore.deletePlatformLink(guildId, userId, platform, platformId);
    },

    async listLinks(guildId: string, platform?: PlatformLinkPlatform): Promise<PlatformLink[]> {
      return options.platformLinkStore.listPlatformLinks(guildId, platform);
    },

    async assignLinkedRole(
      guildId: string,
      userId: string,
      platform: PlatformLinkPlatform,
    ): Promise<void> {
      const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
      if (!config?.linkedRoleId || config.enabled === false) return;
      (await readResources(guildId))?.requireRole(config.linkedRoleId);
      try {
        await addGuildMemberRole(guildId, userId, config.linkedRoleId, options.discordBotToken);
      } catch (error) {
        console.warn(`Failed to assign ${platform} linked role: ${error}`);
      }
    },

    async restoreLinkedRolesOnMemberRejoin(guildId: string, userId: string): Promise<void> {
      const roleIds = new Set<string>();
      const links = (
        await options.platformLinkStore.listPlatformLinksByUser(guildId, userId)
      ).filter((link) => link.active);

      for (const platform of new Set(links.map((link) => link.platform))) {
        const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
        if (config?.linkedRoleId && config.enabled !== false) {
          roleIds.add(config.linkedRoleId);
        }
      }

      const resources = await readResources(guildId);
      resources?.requireRoles(roleIds);
      for (const roleId of roleIds) {
        try {
          await addGuildMemberRole(guildId, userId, roleId, options.discordBotToken);
        } catch (error) {
          if (error instanceof DiscordApiError && error.status === 404) {
            continue;
          }
          throw error;
        }
      }
    },

    async removeLinkedRole(
      guildId: string,
      userId: string,
      platform: PlatformLinkPlatform,
    ): Promise<void> {
      const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
      if (!config?.linkedRoleId) return;
      (await readResources(guildId))?.requireRole(config.linkedRoleId);
      try {
        await removeGuildMemberRole(guildId, userId, config.linkedRoleId, options.discordBotToken);
      } catch (error) {
        console.warn(`Failed to remove ${platform} linked role: ${error}`);
      }
    },

    async sendLogEmbed(
      guildId: string,
      type: "linked" | "manual" | "unlinked",
      data:
        | {
            linkSnapshot: PlatformLink;
            actionedBy?: string;
            discordId?: never;
            platform?: never;
            platformId?: never;
          }
        | {
            discordId: string;
            platform: PlatformLinkPlatform;
            platformId: string;
            actionedBy?: string;
            linkSnapshot?: never;
          },
    ): Promise<void> {
      const platform: PlatformLinkPlatform = data.linkSnapshot?.platform ?? data.platform!;
      const platformId = data.linkSnapshot?.platformId ?? data.platformId!;
      const discordId = data.linkSnapshot?.userId ?? data.discordId!;
      const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
      const eventId: AuditEventId =
        type === "linked"
          ? "platform-link.create"
          : type === "manual"
            ? "platform-link.manual-change"
            : "platform-link.remove";
      const logChannelId =
        config?.logChannelId ??
        (options.guildAuditLogStore
          ? await resolveAuditChannelId(guildId, null, options.guildAuditLogStore, eventId)
          : null);
      if (!logChannelId) return;

      const metadata = getPlatformMetadata(platform);
      try {
        (await readResources(guildId))?.requireTextChannel(logChannelId);
        const link =
          data.linkSnapshot ??
          (await options.platformLinkStore.readPlatformLinkByPlatformId(
            guildId,
            platform,
            platformId,
          ));
        const description = link
          ? (options.identityAdapters?.[platform]?.describe(link, config) ?? null)
          : null;
        const fields = [
          {
            name: "Discord User",
            value: formatStaffUserReference(discordId),
          },
          {
            name: `${metadata.displayName} Account`,
            value: [
              `${metadata.idLabel}: ${platformId}`,
              `Profile: ${metadata.profileUrl(platformId)}`,
              `Platform: ${metadata.displayName}`,
              ...(description?.accountLines ?? []),
            ].join("\n"),
          },
          ...(description?.detailFields ?? []),
          {
            name: "Time",
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          },
        ];

        if (data.actionedBy) {
          fields.push({
            name: "Actioned By",
            value: formatStaffUserReference(data.actionedBy),
          });
        }

        const embed = buildAuditEmbed({
          title:
            type === "linked"
              ? `${metadata.displayName} Account Linked`
              : type === "manual"
                ? `${metadata.displayName} Account Manually Linked`
                : `${metadata.displayName} Account Unlinked`,
          color: type === "unlinked" ? 0xe74c3c : metadata.color,
          fields,
        });
        embed.thumbnail = { url: metadata.iconUrl };

        await createChannelMessage(logChannelId, { embeds: [embed] }, options.discordBotToken);
      } catch (error) {
        console.warn(`Failed to send ${platform} link log embed: ${error}`);
      }
    },

    async syncLinkedRoles(
      guildId: string,
      platform: PlatformLinkPlatform,
    ): Promise<{
      total: number;
      fixed: number;
      skipped: number;
      failed: number;
    }> {
      const config = await options.platformLinkStore.readPlatformLinkConfig(guildId, platform);
      if (!config?.linkedRoleId || config.enabled === false) {
        return { total: 0, fixed: 0, skipped: 0, failed: 0 };
      }
      (await readResources(guildId))?.requireRole(config.linkedRoleId);

      const links = (await options.platformLinkStore.listPlatformLinks(guildId, platform)).filter(
        (link) => link.active,
      );
      const userIds = [...new Set(links.map((link) => link.userId))];
      let fixed = 0;
      let skipped = 0;
      let failed = 0;

      for (const userId of userIds) {
        if (
          (await options.platformLinkStore.readPlatformLinkConfig(guildId, platform))?.enabled ===
          false
        ) {
          skipped += userIds.length - fixed - failed;
          break;
        }
        try {
          await addGuildMemberRole(guildId, userId, config.linkedRoleId, options.discordBotToken);
          fixed++;
        } catch {
          failed++;
        }
      }

      return { total: userIds.length, fixed, skipped, failed };
    },
  };
}

function reportLinkOutcome(
  options: PlatformLinkServiceOptions,
  link: PlatformLink,
  status: "success" | "failure",
  reasonCode?: ProductFailureCode,
): void {
  if (!options.productAnalytics) return;
  const delivery = createDeterministicInsertionId([
    "player_link_completed",
    link.guildId,
    link.userId,
    link.platform,
    link.platformId,
    String(link.linkedAtMs),
    status,
    reasonCode ?? "",
  ])
    .then((insertionId) =>
      options.productAnalytics!.report({
        name: "feature_outcome",
        insertionId,
        guildId: link.guildId,
        feature: "player_link",
        action: "player_link_completed",
        status,
        ...(reasonCode ? { reasonCode } : {}),
        provider:
          link.platform === "steam" || link.platform === "xbox" || link.platform === "playstation"
            ? link.platform
            : "other",
      }),
    )
    .catch(() => undefined);
  try {
    if (options.waitUntil) options.waitUntil(delivery);
  } catch {
    // Analytics cannot affect Platform Link persistence.
  }
}

export type PlatformLinkService = ReturnType<typeof createPlatformLinkService>;

function getPlatformMetadata(platform: PlatformLinkPlatform): {
  displayName: string;
  idLabel: string;
  iconUrl: string;
  color: number;
  profileUrl: (platformId: string) => string;
} {
  if (platform === "xbox") {
    return {
      displayName: "Xbox",
      idLabel: "Xbox XUID",
      iconUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Xbox_Logo.svg/512px-Xbox_Logo.svg.png",
      color: 0x107c10,
      profileUrl: (platformId) => `https://account.xbox.com/profile?gamertag=${platformId}`,
    };
  }

  if (platform === "playstation") {
    return {
      displayName: "PlayStation",
      idLabel: "PSN Online ID",
      iconUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Playstation_logo_colour.svg/512px-Playstation_logo_colour.svg.png",
      color: 0x003791,
      profileUrl: (platformId) => `https://psnprofiles.com/${platformId}`,
    };
  }

  return {
    displayName: platform === "steam" ? "Steam" : platform,
    idLabel: platform === "steam" ? "SteamID64" : "Platform ID",
    iconUrl: "https://cdn.cloudflare.steamstatic.com/store/home/store_home_share.jpg",
    color: 0x2ecc71,
    profileUrl: (platformId) =>
      platform === "steam"
        ? `https://steamcommunity.com/profiles/${platformId}`
        : `https://example.invalid/${platform}/${platformId}`,
  };
}
