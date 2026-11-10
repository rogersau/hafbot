import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import * as schema from "../../db/auth-schema";
import { createD1DrizzleDatabase } from "../drizzle-db";
import { adminRole, ownerRole, viewerRole, workspaceAccessControl } from "./permissions";
import { resolveDisplayName } from "../discord-user";
import { getCustomerAuthCookieSettings } from "../../contracts/auth-session-cookie";

export interface CustomerAuthConfig {
  betterAuthSecret: string;
  betterAuthUrl: string;
  discordOAuthClientId: string;
  discordOAuthClientSecret: string;
  database: D1Database;
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;

export interface DiscordOAuthProfile {
  id?: unknown;
  global_name?: string | null;
  username?: string | null;
  email?: string | null;
  verified?: boolean;
  avatar?: string | null;
}

export interface DiscordSocialProviderConfigInput {
  discordOAuthClientId: string;
  discordOAuthClientSecret: string;
}

export const customerAuthUserOptions = {
  additionalFields: {
    discordUserId: {
      type: "string",
      required: true,
      // Better Auth treats mapProfileToUser values as provider input. This must
      // allow input so Discord OAuth can initialize the field on first login.
      input: true,
      unique: true,
    },
  },
} as const;

export async function rejectDiscordUserIdUpdate(user: Record<string, unknown>): Promise<void> {
  if ("discordUserId" in user) {
    throw new APIError("BAD_REQUEST", {
      message: "Discord user ID cannot be updated",
    });
  }
}

export function mapDiscordProfileToUser(profile: DiscordOAuthProfile) {
  if (typeof profile.id !== "string" || profile.id.trim().length === 0) {
    throw new Error("Discord OAuth profile missing required id field");
  }

  const fallbackEmail = `${profile.id}@discord.local`;
  return {
    name:
      resolveDisplayName(
        { global_name: profile.global_name || null, username: profile.username || null },
        { terminalFallback: "Discord user" },
      ) ?? "Discord user",
    email: nonEmptyString(profile.email, fallbackEmail),
    emailVerified: isNonEmptyString(profile.email) && profile.verified === true,
    discordUserId: profile.id,
    image: isNonEmptyString(profile.avatar)
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : undefined,
  };
}

export function getDiscordOAuthScopes(): string[] {
  return ["identify", "email", "guilds"];
}

export function createDiscordSocialProviderConfig(config: DiscordSocialProviderConfigInput) {
  return {
    clientId: config.discordOAuthClientId,
    clientSecret: config.discordOAuthClientSecret,
    scope: getDiscordOAuthScopes(),
    mapProfileToUser(profile: DiscordOAuthProfile) {
      return mapDiscordProfileToUser(profile);
    },
  };
}

function nonEmptyString(value: string | null | undefined, fallback: string): string {
  return isNonEmptyString(value) ? value : fallback;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createCustomerAuth(config: CustomerAuthConfig) {
  const db = createD1DrizzleDatabase(config.database);
  const cookieSettings = getCustomerAuthCookieSettings(config.betterAuthUrl);

  return betterAuth({
    appName: "HAF Bot",
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret,
    advanced: cookieSettings.advanced,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      camelCase: true,
    }),
    user: customerAuthUserOptions,
    // Dashboard authority belongs to the Discord identity, not an email that
    // may later be reused by another Discord account.
    account: { accountLinking: { disableImplicitLinking: true } },
    databaseHooks: {
      user: {
        update: {
          before: rejectDiscordUserIdUpdate,
        },
      },
    },
    socialProviders: {
      discord: createDiscordSocialProviderConfig(config),
    },
    plugins: [
      organization({
        ac: workspaceAccessControl,
        roles: {
          owner: ownerRole,
          admin: adminRole,
          member: viewerRole,
        },
      }),
    ],
  });
}
