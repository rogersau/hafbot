import { DiscordApiError } from "./discord";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const DURATION_PATTERN = /^(\d+)(min|[hwm])$/i;

export interface ParsedTimedRoleDuration {
  durationInput: string;
  expiresAtMs: number;
}

function addUtcMonthsClamped(nowMs: number, amount: number): number {
  const current = new Date(nowMs);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + amount + 1, 0)).getUTCDate();

  return Date.UTC(
    year,
    month + amount,
    Math.min(day, lastDayOfTargetMonth),
    current.getUTCHours(),
    current.getUTCMinutes(),
    current.getUTCSeconds(),
    current.getUTCMilliseconds(),
  );
}

export function parseTimedRoleDuration(
  input: string,
  nowMs = Date.now(),
): ParsedTimedRoleDuration | null {
  const match = input.trim().match(DURATION_PATTERN);
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  if (unit === "min") {
    return { durationInput: input, expiresAtMs: nowMs + amount * 60_000 };
  }

  if (unit === "h") {
    return { durationInput: input, expiresAtMs: nowMs + amount * HOUR_MS };
  }

  if (unit === "w") {
    return { durationInput: input, expiresAtMs: nowMs + amount * WEEK_MS };
  }

  return { durationInput: input, expiresAtMs: addUtcMonthsClamped(nowMs, amount) };
}

export function formatTimedRoleExpiry(expiresAtMs: number): string {
  return `<t:${Math.floor(expiresAtMs / 1000)}:R>`;
}

export function describeTimedRoleAssignmentFailure(error: unknown): string {
  if (
    error instanceof Error &&
    error.message === "Failed to assign the timed role, and rollback failed."
  ) {
    return error.message;
  }

  if (!(error instanceof DiscordApiError)) {
    return "Failed to assign the timed role.";
  }

  if (error.status === 403) {
    return "Failed to assign the timed role. Ensure the bot has Manage Roles and that its highest role is above the target role.";
  }

  if (error.status === 404) {
    return "Failed to assign the timed role. The member or role could not be found in this server.";
  }

  if (error.status >= 500) {
    return "Failed to assign the timed role because Discord is currently unavailable.";
  }

  return `Failed to assign the timed role (${error.status}).`;
}

export function describeTimedRoleRemovalFailure(error: unknown): string {
  if (!(error instanceof DiscordApiError)) {
    return "Failed to remove the timed role.";
  }

  if (error.status === 403) {
    return "Failed to remove the timed role. Ensure the bot has Manage Roles and that its highest role is above the target role.";
  }

  if (error.status === 404) {
    return "Failed to remove the timed role. The member or role could not be found in this server.";
  }

  if (error.status >= 500) {
    return "Failed to remove the timed role because Discord is currently unavailable.";
  }

  return `Failed to remove the timed role (${error.status}).`;
}
