import type {
  pendingPlatformLinks,
  platformLinkConfigs,
  platformLinks,
} from "../db/postgres/app-schema";
import type {
  PendingPlatformLink,
  PlatformLink,
  PlatformLinkConfig,
  PlatformLinkPlatform,
} from "./contracts/platform-link-store";

type PlatformLinkConfigRow = typeof platformLinkConfigs.$inferSelect;
type PlatformLinkConfigInsert = typeof platformLinkConfigs.$inferInsert;
type PendingPlatformLinkRow = typeof pendingPlatformLinks.$inferSelect;
type PendingPlatformLinkInsert = typeof pendingPlatformLinks.$inferInsert;
type PlatformLinkRow = typeof platformLinks.$inferSelect;
type PlatformLinkInsert = typeof platformLinks.$inferInsert;

export function rowToConfig(row: PlatformLinkConfigRow): PlatformLinkConfig | null {
  try {
    const platform = parsePlatform(row.platform);
    if (!platform) return null;
    return {
      guildId: row.guildId,
      platform,
      ...(row.enabled === 0 ? { enabled: false } : {}),
      linkedRoleId: row.linkedRoleId,
      logChannelId: row.logChannelId,
      gameAppIds: JSON.parse(row.gameAppIdsJson ?? "[]") as number[],
      panelTitle: row.panelTitle,
      panelDescription: row.panelDescription,
      panelButtonLabel: row.panelButtonLabel,
      panelButtonStyle: row.panelButtonStyle,
      panelColor:
        row.panelColor ??
        (platform === "xbox" ? 0x107c10 : platform === "playstation" ? 0x003791 : 0x5865f2),
      allowRelink: row.allowRelink !== 0,
      allowMultipleLinks: row.allowMultipleLinks === 1,
      requireRelinkOnRejoin: row.requireRelinkOnRejoin === 1,
      whoisFields: JSON.parse(row.whoisFieldsJson ?? "[]") as string[],
      customLinks:
        row.customLinksJson === undefined || row.customLinksJson === null
          ? []
          : (JSON.parse(row.customLinksJson) as PlatformLinkConfig["customLinks"]),
      panelChannelId: row.panelChannelId,
      panelMessageId: row.panelMessageId,
      updatedAtMs: row.updatedAtMs,
    };
  } catch {
    return null;
  }
}

export function configToRow(config: PlatformLinkConfig): PlatformLinkConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled === false ? 0 : 1,
    platform: config.platform,
    linkedRoleId: config.linkedRoleId,
    logChannelId: config.logChannelId,
    gameAppIdsJson: JSON.stringify(config.gameAppIds),
    panelTitle: config.panelTitle,
    panelDescription: config.panelDescription,
    panelButtonLabel: config.panelButtonLabel,
    panelButtonStyle: config.panelButtonStyle,
    panelColor:
      config.panelColor ??
      (config.platform === "xbox"
        ? 0x107c10
        : config.platform === "playstation"
          ? 0x003791
          : 0x5865f2),
    allowRelink: config.allowRelink ? 1 : 0,
    allowMultipleLinks: config.allowMultipleLinks ? 1 : 0,
    requireRelinkOnRejoin: config.requireRelinkOnRejoin ? 1 : 0,
    updatedAtMs: config.updatedAtMs,
    whoisFieldsJson: JSON.stringify(config.whoisFields),
    customLinksJson: JSON.stringify(config.customLinks),
    panelChannelId: config.panelChannelId,
    panelMessageId: config.panelMessageId,
  };
}

export function rowToPending(row: PendingPlatformLinkRow): PendingPlatformLink {
  const platform = parsePlatform(row.platform);
  if (!platform) throw new Error(`Invalid platform: ${row.platform}`);
  return {
    state: row.state,
    guildId: row.guildId,
    userId: row.userId,
    platform,
    createdAtMs: row.createdAtMs,
  };
}

export function pendingToRow(pending: PendingPlatformLink): PendingPlatformLinkInsert {
  return {
    state: pending.state,
    guildId: pending.guildId,
    userId: pending.userId,
    platform: pending.platform,
    createdAtMs: pending.createdAtMs,
  };
}

export function rowToLink(row: PlatformLinkRow): PlatformLink {
  const platform = parsePlatform(row.platform);
  if (!platform) throw new Error(`Invalid platform: ${row.platform}`);
  return {
    guildId: row.guildId,
    userId: row.userId,
    platform,
    platformId: row.platformId,
    linkedAtMs: row.linkedAtMs,
    manual: row.manual !== 0,
    actionedByUserId: row.actionedByUserId,
    metadataJson: row.metadataJson,
    active: row.active !== 0,
  };
}

function parsePlatform(value: string): PlatformLinkPlatform | null {
  return value === "discord" ||
    value === "steam" ||
    value === "xbox" ||
    value === "playstation" ||
    value === "cftools"
    ? value
    : null;
}

export function linkToRow(link: PlatformLink): PlatformLinkInsert {
  return {
    guildId: link.guildId,
    userId: link.userId,
    platform: link.platform,
    platformId: link.platformId,
    linkedAtMs: link.linkedAtMs,
    manual: link.manual ? 1 : 0,
    actionedByUserId: link.actionedByUserId,
    metadataJson: link.metadataJson,
    active: link.active ? 1 : 0,
  };
}
