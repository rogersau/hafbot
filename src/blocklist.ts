import type {
  AppConfigRow,
  BlocklistConfig,
  ChannelFilterMode,
  GuildBlockedEmojiRow,
  GuildSettingRow,
} from "./types";

export const MAX_BLOCKLIST_BATCH_EMOJIS = 50;

export function buildBlocklistConfig(
  guildRows: GuildSettingRow[],
  guildEmojiRows: GuildBlockedEmojiRow[],
  appConfigRows: AppConfigRow[],
): BlocklistConfig {
  const guilds: BlocklistConfig["guilds"] = {};
  const botUserId = appConfigRows.find((row) => row.key === "bot_user_id")?.value ?? "";

  for (const row of guildRows) {
    guilds[row.guild_id] = {
      enabled: row.moderation_enabled === 1,
      emojis: [],
      channelMode: mapChannelMode(row.channel_mode),
      channelIds: mapChannelIds(row.channel_ids_json),
    };
  }

  for (const row of guildEmojiRows) {
    guilds[row.guild_id] ??= {
      enabled: true,
      emojis: [],
      channelMode: "include",
      channelIds: [],
    };
    guilds[row.guild_id].emojis.push(row.normalized_emoji);
  }

  return {
    guilds,
    botUserId,
  };
}

export async function getBlocklistFromStore(
  fetchConfig: () => Promise<Response>,
): Promise<BlocklistConfig> {
  const response = await fetchConfig();

  if (!response.ok) {
    throw new Error(`Failed to load moderation config from store (${response.status})`);
  }

  return (await response.json()) as BlocklistConfig;
}

export function isEmojiBlocked(
  emoji: string,
  config: BlocklistConfig,
  guildId: string | undefined,
  channelId?: string,
): boolean {
  if (guildId && config.guilds[guildId]) {
    const guildConfig = config.guilds[guildId];
    if (!guildConfig.enabled) {
      return false;
    }

    if (!channelMatchesFilter(guildConfig.channelMode, guildConfig.channelIds ?? [], channelId)) {
      return false;
    }

    const baseEmoji = stripToneVariant(emoji);
    if (guildConfig.emojis.includes(emoji) || guildConfig.emojis.includes(baseEmoji)) {
      return true;
    }
  }

  return false;
}

export function channelMatchesFilter(
  mode: ChannelFilterMode | undefined,
  channelIds: string[],
  channelId?: string,
): boolean {
  if (channelIds.length === 0) {
    return true;
  }

  if (mode === "exclude") {
    return !channelId || !channelIds.includes(channelId);
  }

  return channelId !== undefined && channelIds.includes(channelId);
}

export function normalizeEmoji(rawEmoji: string | null): string | null {
  if (!rawEmoji) {
    return null;
  }

  return rawEmoji.replace(/^:/, "").replace(/:$/, "");
}

export function normalizeBlocklistEmoji(rawEmoji: string | null): string | null {
  const trimmed = rawEmoji?.trim() ?? "";
  if (!trimmed) return null;

  const customEmoji = /^(?:<a?:|:a?:)([^:>]+):(\d+)>?$/.exec(trimmed);
  if (customEmoji) return `${customEmoji[1]}:${customEmoji[2]}`;

  return normalizeEmoji(trimmed);
}

export function normalizeBlocklistEmojis(rawEmojis: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawEmoji of rawEmojis) {
    const trimmed = rawEmoji.trim();
    if (!trimmed) continue;

    const candidates = /^(?:<a?:|:a?:)([^:>]+):(\d+)>?$/.test(trimmed)
      ? [trimmed]
      : parseBlocklistEmojis(trimmed);
    for (const candidate of candidates) {
      const value = normalizeBlocklistEmoji(candidate);
      if (value && !seen.has(value)) {
        seen.add(value);
        normalized.push(value);
      }
    }
  }

  return normalized;
}

export function parseBlocklistEmojis(rawEmoji: string | null): string[] {
  const normalizedEmoji = normalizeEmoji(rawEmoji);
  if (!normalizedEmoji) {
    return [];
  }

  return normalizedEmoji
    .split(/\s+/)
    .flatMap(splitEmojiToken)
    .map((emoji) => normalizeEmoji(emoji))
    .filter((emoji): emoji is string => Boolean(emoji));
}

function splitEmojiToken(value: string): string[] {
  const customEmojiTokens = value.match(/<a?:[^:>]+:\d+>/g);
  if (customEmojiTokens?.join("") === value) {
    return customEmojiTokens;
  }

  return splitNativeEmojiRun(value);
}

function splitNativeEmojiRun(value: string): string[] {
  const emojis = splitGraphemes(value);
  if (!emojis.every(isNativeEmojiGrapheme)) {
    return [value];
  }

  return emojis;
}

function splitGraphemes(value: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity?: "grapheme" },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;

  if (!Segmenter) {
    return Array.from(value);
  }

  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );
}

function isNativeEmojiGrapheme(value: string): boolean {
  return /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji}\uFE0F/u.test(
    value,
  );
}

function stripToneVariant(emoji: string): string {
  return emoji.replace(/_tone[1-5](?=:|$)/, "");
}

function mapChannelMode(value: string | null | undefined): ChannelFilterMode {
  return value === "exclude" ? "exclude" : "include";
}

function mapChannelIds(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
