import type { SubjectIdentifierPlatform } from "../../types";

export type PlatformLinkPlatform = SubjectIdentifierPlatform;

export interface PlatformLinkCustomLink {
  label: string;
  url: string;
}

export interface PlatformLinkConfig {
  /** Defaults to enabled when omitted from a new configuration. */
  enabled?: boolean;
  guildId: string;
  platform: PlatformLinkPlatform;
  linkedRoleId: string | null;
  logChannelId: string | null;
  gameAppIds: number[];
  panelTitle: string;
  panelDescription: string;
  panelButtonLabel: string;
  panelButtonStyle: string;
  panelColor?: number;
  allowRelink: boolean;
  allowMultipleLinks: boolean;
  requireRelinkOnRejoin: boolean;
  whoisFields: string[];
  customLinks: PlatformLinkCustomLink[];
  panelChannelId: string | null;
  panelMessageId: string | null;
  updatedAtMs: number;
}

export interface PendingPlatformLink {
  state: string;
  guildId: string;
  userId: string;
  platform: PlatformLinkPlatform;
  createdAtMs: number;
}

export interface PlatformLink {
  guildId: string;
  userId: string;
  platform: PlatformLinkPlatform;
  platformId: string;
  linkedAtMs: number;
  manual: boolean;
  actionedByUserId: string | null;
  metadataJson: string | null;
  active: boolean;
}

export interface PlatformLinkStore {
  setPlatformLinkEnabled?(
    guildId: string,
    platform: PlatformLinkPlatform,
    enabled: boolean,
  ): Promise<boolean>;
  readPlatformLinkConfig(
    guildId: string,
    platform: PlatformLinkPlatform,
  ): Promise<PlatformLinkConfig | null>;
  upsertPlatformLinkConfig(config: PlatformLinkConfig): Promise<void>;
  createPendingPlatformLink(pending: PendingPlatformLink): Promise<void>;
  readPendingPlatformLink(state: string): Promise<PendingPlatformLink | null>;
  deletePendingPlatformLink(state: string): Promise<void>;
  clearExpiredPendingPlatformLinks(nowMs: number): Promise<void>;
  readPlatformLink(
    guildId: string,
    userId: string,
    platform: PlatformLinkPlatform,
  ): Promise<PlatformLink | null>;
  readPlatformLinkEntry(
    guildId: string,
    userId: string,
    platform: PlatformLinkPlatform,
    platformId: string,
  ): Promise<PlatformLink | null>;
  listPlatformLinksByUser(guildId: string, userId: string): Promise<PlatformLink[]>;
  readPlatformLinkByPlatformId(
    guildId: string,
    platform: PlatformLinkPlatform,
    platformId: string,
  ): Promise<PlatformLink | null>;
  upsertPlatformLink(link: PlatformLink): Promise<void>;
  /** Atomically replace this user's links for one platform. */
  replacePlatformLinks(link: PlatformLink): Promise<void>;
  deletePlatformLink(
    guildId: string,
    userId: string,
    platform?: PlatformLinkPlatform,
    platformId?: string,
  ): Promise<void>;
  listPlatformLinks(guildId: string, platform?: PlatformLinkPlatform): Promise<PlatformLink[]>;
}

export interface GameOwnership {
  appId: string;
  name: string;
  owned: boolean;
  playtimeHours: number | null;
  note: string;
}
