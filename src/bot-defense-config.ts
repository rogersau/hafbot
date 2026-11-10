export const MAX_BOT_DEFENSE_HONEYPOT_CHANNELS = 10;

export function getBotDefenseHoneypotChannelLimitError(
  channelIds: readonly string[],
): string | null {
  return channelIds.length > MAX_BOT_DEFENSE_HONEYPOT_CHANNELS
    ? `Choose no more than ${MAX_BOT_DEFENSE_HONEYPOT_CHANNELS} honeypot channels.`
    : null;
}
