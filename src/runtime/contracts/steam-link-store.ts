export interface SteamLinkConfig {
  guildId: string;
  steamLinkedRoleId: string | null;
  logChannelId: string | null;
  gameAppIds: number[];
  panelTitle: string;
  panelDescription: string;
  panelButtonLabel: string;
  panelButtonStyle: string;
  panelColor?: number;
  allowRelink: boolean;
  allowMultipleLinks: boolean;
  whoisFields: string[];
  customLinks: SteamLinkCustomLink[];
  panelChannelId: string | null;
  panelMessageId: string | null;
  updatedAtMs: number;
}

export interface SteamLinkCustomLink {
  label: string;
  url: string;
}

export interface PendingSteamLink {
  state: string;
  guildId: string;
  userId: string;
  createdAtMs: number;
}

export interface GameOwnership {
  appId: string;
  name: string;
  owned: boolean;
  playtimeHours: number | null;
  note: string;
}

export interface SteamLink {
  guildId: string;
  userId: string;
  steamId64: string;
  linkedAtMs: number;
  manual: boolean;
  actionedByUserId: string | null;
  gameOwnership: GameOwnership[];
}

export interface SteamLinkStore {
  readSteamLinkConfig(guildId: string): Promise<SteamLinkConfig | null>;
  upsertSteamLinkConfig(config: SteamLinkConfig): Promise<void>;
  createPendingSteamLink(pending: PendingSteamLink): Promise<void>;
  readPendingSteamLink(state: string): Promise<PendingSteamLink | null>;
  deletePendingSteamLink(state: string): Promise<void>;
  clearExpiredPendingSteamLinks(nowMs: number): Promise<void>;
  readSteamLink(guildId: string, userId: string): Promise<SteamLink | null>;
  readSteamLinkEntry(guildId: string, userId: string, steamId64: string): Promise<SteamLink | null>;
  listSteamLinksByUser(guildId: string, userId: string): Promise<SteamLink[]>;
  readSteamLinkBySteamId64(guildId: string, steamId64: string): Promise<SteamLink | null>;
  upsertSteamLink(link: SteamLink): Promise<void>;
  deleteSteamLink(guildId: string, userId: string): Promise<void>;
  deleteSteamLinkBySteamId64(guildId: string, steamId64: string): Promise<void>;
  listSteamLinks(guildId: string): Promise<SteamLink[]>;
}
