import { isDiscordRateLimitError } from "../discord";

export function rethrowDiscordRateLimit(error: unknown): void {
  if (isDiscordRateLimitError(error)) throw error;
}
