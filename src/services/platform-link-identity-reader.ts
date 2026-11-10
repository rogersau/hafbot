import type {
  PlatformLink,
  PlatformLinkPlatform,
  PlatformLinkStore,
} from "../runtime/contracts/platform-link-store";

export type PlatformIdentityAssurance = "authenticated" | "self_reported" | "administrative";

export interface LinkedPlatformIdentity {
  guildId: string;
  userId: string;
  platform: PlatformLinkPlatform;
  platformId: string;
  active: boolean;
  assurance: PlatformIdentityAssurance;
  linkedAtMs: number;
}

export interface PlatformLinkIdentityReader {
  listActiveIdentities(
    guildId: string,
    userId: string,
    platform?: PlatformLinkPlatform,
  ): Promise<LinkedPlatformIdentity[]>;
  readIdentity(
    guildId: string,
    userId: string,
    platform: PlatformLinkPlatform,
    platformId: string,
  ): Promise<LinkedPlatformIdentity | null>;
}

export function createPlatformLinkIdentityReader(
  store: PlatformLinkStore,
): PlatformLinkIdentityReader {
  return {
    async listActiveIdentities(guildId, userId, platform) {
      const links = await store.listPlatformLinksByUser(guildId, userId);
      return links
        .filter((link) => link.active && (!platform || link.platform === platform))
        .map(toLinkedPlatformIdentity);
    },
    async readIdentity(guildId, userId, platform, platformId) {
      const link = await store.readPlatformLinkEntry(guildId, userId, platform, platformId);
      return link ? toLinkedPlatformIdentity(link) : null;
    },
  };
}

export function getPlatformIdentityAssurance(link: PlatformLink): PlatformIdentityAssurance {
  if (link.manual) return "administrative";

  switch (link.platform) {
    case "steam":
    case "xbox":
      return "authenticated";
    case "playstation":
      return "self_reported";
    case "discord":
    case "cftools":
      throw new Error(`${link.platform} is not a supported Platform Link provider`);
    default:
      return assertNeverPlatform(link.platform);
  }
}

function assertNeverPlatform(platform: never): never {
  throw new Error(`Unsupported Platform Link provider: ${String(platform)}`);
}

function toLinkedPlatformIdentity(link: PlatformLink): LinkedPlatformIdentity {
  return {
    guildId: link.guildId,
    userId: link.userId,
    platform: link.platform,
    platformId: link.platformId,
    active: link.active,
    assurance: getPlatformIdentityAssurance(link),
    linkedAtMs: link.linkedAtMs,
  };
}
