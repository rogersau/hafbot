import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";

import { resetGuildResourcesCache } from "../lib/guild-resources-cache";

export function useRouteInvalidation() {
  const router = useRouter({ warn: false });

  return useCallback(async () => {
    resetGuildResourcesCache();
    await router?.invalidate({ sync: true });
  }, [router]);
}
