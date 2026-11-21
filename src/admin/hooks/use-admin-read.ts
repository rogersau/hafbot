import { useState, useSyncExternalStore } from "react";
import {
  getAdminRead,
  idleAdminRead,
  type AdminRead,
  type AdminReadCache,
} from "../lib/admin-read";
import { useOptionalAdminSession } from "../lib/admin-session";

const getIdle = () => idleAdminRead;
const subscribeIdle = () => () => undefined;

export function useAdminRead<T>(
  key: string | null,
  load: () => Promise<T>,
  { shared = false, revalidate = false }: { shared?: boolean; revalidate?: boolean } = {},
) {
  const session = useOptionalAdminSession();
  const [local] = useState<AdminReadCache>(() => new Map());
  const cache = shared && session ? session.reads : local;
  const read = key === null ? null : getAdminRead(cache, key, load, revalidate);
  const snapshot = useAdminReadSnapshot(read);
  return { read, ...snapshot };
}

export function useAdminReadSnapshot<T>(read: AdminRead<T> | null) {
  return useSyncExternalStore(
    read?.subscribe ?? subscribeIdle,
    read?.getSnapshot ?? getIdle,
    read?.getServerSnapshot ?? getIdle,
  );
}
