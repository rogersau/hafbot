import {
  createDiscordSocialProviderConfig,
  customerAuthUserOptions,
  rejectDiscordUserIdUpdate,
} from "../../../../../src/runtime/auth/discord-auth";
export * from "../../../../../src/runtime/auth/discord-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import * as schema from "../../db/auth-schema";
import { createD1DrizzleDatabase } from "../drizzle-db";
import {
  adminRole,
  ownerRole,
  viewerRole,
  workspaceAccessControl,
} from "../../../../../src/runtime/auth/permissions";
import { getCustomerAuthCookieSettings } from "../../../../../src/contracts/auth-session-cookie";

export interface CustomerAuthConfig {
  betterAuthSecret: string;
  betterAuthUrl: string;
  discordOAuthClientId: string;
  discordOAuthClientSecret: string;
  database: D1Database;
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;

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
