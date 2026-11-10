import { defineRoute, type Route } from "../admin-route-registry";
import type { UserPreferencesStore } from "../contracts/user-preferences-store";
import type { CustomerSession } from "../auth/customer-session";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
  type UserPreferencesPatch,
} from "../admin-types";
import { bindAdminContract } from "../admin-contract-route";
import {
  getProfilePreferences,
  patchProfilePreferences,
} from "../../contracts/admin/cross-cutting";

export interface UserProfileAdminRoutesOptions {
  store: UserPreferencesStore;
  readCustomerSession: (request: Request) => Promise<CustomerSession | null>;
}

export function createUserProfileAdminRoutes(
  options: UserProfileAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...bindAdminContract(getProfilePreferences),
      method: "GET",
      path: "/admin/api/profile/preferences",
      access: { mode: "read", customerSessionOnly: true },
      handler: async ({ request }) => {
        const session = await options.readCustomerSession(request);
        if (!session) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const stored = await options.store.readUserPreferences(session.user.id);
        return Response.json(stored ?? DEFAULT_USER_PREFERENCES);
      },
    }),
    defineRoute({
      ...bindAdminContract(patchProfilePreferences),
      method: "PATCH",
      path: "/admin/api/profile/preferences",
      access: { mode: "write", customerSessionOnly: true },
      handler: async ({ request, body }) => {
        const session = await options.readCustomerSession(request);
        if (!session) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const stored =
          (await options.store.readUserPreferences(session.user.id)) ?? DEFAULT_USER_PREFERENCES;
        const merged: UserPreferences = applyUserPreferencesPatch(stored, body);

        await options.store.upsertUserPreferences(session.user.id, merged);
        return Response.json(merged);
      },
    }),
  ];
}

function applyUserPreferencesPatch(
  current: UserPreferences,
  patch: UserPreferencesPatch,
): UserPreferences {
  return {
    hiddenGuildIds: dedupeStrings(patch.hiddenGuildIds ?? current.hiddenGuildIds),
    defaultGuildId:
      patch.defaultGuildId !== undefined ? patch.defaultGuildId : current.defaultGuildId,
    emailNotifications:
      patch.emailNotifications !== undefined
        ? patch.emailNotifications
        : current.emailNotifications,
    pushNotifications:
      patch.pushNotifications !== undefined ? patch.pushNotifications : current.pushNotifications,
    theme: patch.theme ?? current.theme,
    language: patch.language ?? current.language,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
