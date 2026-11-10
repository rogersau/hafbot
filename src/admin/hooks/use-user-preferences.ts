import { useCallback, useEffect, useRef, useState } from "react";

import { describeError } from "../lib/api";
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
  refresh: () => Promise<void>;
}

export function useUserPreferences(authenticated: boolean): UseUserPreferencesResult {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchedAtMs = useRef<number>(0);

  const refresh = useCallback(async () => {
    if (!authenticated) {
      setPreferences(DEFAULT_USER_PREFERENCES);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      const next = await crossCuttingClient.profile({});
      lastFetchedAtMs.current = Date.now();
      setPreferences(next);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyPatch = useCallback(
    async (patch: UserPreferencesPatch, options?: ApplyUserPreferencesOptions) => {
      const previous = preferences;
      const optimistic = applyUserPreferencesPatch(previous, patch);
      setPreferences(optimistic);
      setError(null);

      try {
        const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
        const next = await crossCuttingClient.saveProfile(patch);
        setPreferences(next);
        lastFetchedAtMs.current = Date.now();
      } catch (err) {
        setPreferences(previous);
        const message = describeError(err);
        setError(message);
        options?.onError?.(message);
        return;
      }
      options?.onSuccess?.();
    },
    [preferences],
  );

  return { preferences, loading, error, applyPatch, refresh };
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
