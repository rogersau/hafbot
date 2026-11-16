import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

import * as schema from "../../db/postgres/auth-schema";
import { getCustomerAuthCookieSettings } from "../../contracts/auth-session-cookie";
import {
  createDiscordSocialProviderConfig,
  customerAuthUserOptions,
  rejectDiscordUserIdUpdate,
} from "../auth/discord-auth";
import { adminRole, ownerRole, viewerRole, workspaceAccessControl } from "../auth/permissions";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export interface PostgresCustomerAuthConfig {
  betterAuthSecret: string;
  betterAuthUrl: string;
  discordOAuthClientId: string;
  discordOAuthClientSecret: string;
  database: PostgresDatabaseCapability;
}

export function createPostgresCustomerAuth(config: PostgresCustomerAuthConfig) {
  const cookieSettings = getCustomerAuthCookieSettings(config.betterAuthUrl);
  return betterAuth({
    appName: "HAF Bot",
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret,
    advanced: cookieSettings.advanced,
    database: drizzleAdapter(config.database.drizzle, {
      provider: "pg",
      schema,
      camelCase: true,
    }),
    user: customerAuthUserOptions,
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
