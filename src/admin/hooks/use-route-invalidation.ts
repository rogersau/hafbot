import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";

import { resetGuildResourcesCache } from "../lib/guild-resources-cache";
import { useOptionalAdminSession } from "../lib/admin-session";

export function useRouteInvalidation() {
  const router = useRouter({ warn: false });
  const cache = useOptionalAdminSession()?.guildResourcesCache;

  return useCallback(async () => {
    resetGuildResourcesCache(cache);
    await router?.invalidate({ sync: true });
  }, [router, cache]);
}
