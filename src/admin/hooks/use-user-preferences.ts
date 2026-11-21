import { useCallback, useRef } from "react";

import { describeError } from "../lib/api";
import { useAdminRead } from "./use-admin-read";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
  type UserPreferencesPatch,
} from "../../runtime/admin-types";

export interface ApplyUserPreferencesOptions {
  successMessage?: string;
  onError?: (error: string) => void;
  onSuccess?: () => void;
}

export interface UseUserPreferencesResult {
  preferences: UserPreferences;
  loading: boolean;
  error: string | null;
  applyPatch: (patch: UserPreferencesPatch, options?: ApplyUserPreferencesOptions) => Promise<void>;
}

export function useUserPreferences(authenticated: boolean): UseUserPreferencesResult {
  const { read, data, loading, error } = useAdminRead(
    authenticated ? "profile" : null,
    async () => {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      return crossCuttingClient.profile({});
    },
    { shared: true },
  );
  const queue = useRef(Promise.resolve());
  const enqueue = useCallback((action: () => Promise<void>) => {
    const pending = queue.current.then(action);
    queue.current = pending.catch(() => undefined);
    return pending;
  }, []);

  const applyPatch = useCallback(
    (patch: UserPreferencesPatch, options?: ApplyUserPreferencesOptions) =>
      enqueue(async () => {
        if (!read) return;
        const previous = read.getSnapshot().data ?? DEFAULT_USER_PREFERENCES;
        const optimistic = applyUserPreferencesPatch(previous, patch);
        read.setData(optimistic);

        try {
          const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
          const next = await crossCuttingClient.saveProfile(patch);
          read.setData(next);
        } catch (err) {
          const message = describeError(err);
          read.setData(previous, err);
          options?.onError?.(message);
          return;
        }
        options?.onSuccess?.();
      }),
    [enqueue, read],
  );

  return {
    preferences: data ?? DEFAULT_USER_PREFERENCES,
    loading,
    error: error ? describeError(error) : null,
    applyPatch,
  };
}

function applyUserPreferencesPatch(
  current: UserPreferences,
  patch: UserPreferencesPatch,
): UserPreferences {
  return {
    hiddenGuildIds: patch.hiddenGuildIds ?? current.hiddenGuildIds,
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
