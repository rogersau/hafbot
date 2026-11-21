import { Store } from "@tanstack/react-store";

interface ReadSnapshot<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

export const idleAdminRead: ReadSnapshot<never> = { data: null, loading: false, error: null };
const pendingAdminRead: ReadSnapshot<never> = { ...idleAdminRead, loading: true };

export function createAdminRead<T>(load: () => Promise<T>, revalidateOnSubscribe = false) {
  const store = new Store<ReadSnapshot<T>>(pendingAdminRead);
  let pending: Promise<T> | null = null;
  let subscribers = 0;

  function setData(data: T, error: unknown = null) {
    pending = null;
    store.setState(() => ({ data, error, loading: false }));
  }

  function refresh(reload?: () => Promise<T>): Promise<T> {
    if (pending && !reload) return pending;
    const request = Promise.resolve().then(reload ?? load);
    pending = request;
    store.setState((state) => ({ ...state, loading: true, error: null }));
    void request.then(
      (data) => {
        if (pending === request) setData(data);
      },
      (error: unknown) => {
        if (pending !== request) return;
        pending = null;
        store.setState((state) => ({ ...state, error, loading: false }));
      },
    );
    return request;
  }

  return {
    getSnapshot: () => store.state,
    getServerSnapshot: () => pendingAdminRead,
    subscribe(onChange: () => void) {
      const subscription = store.subscribe(onChange);
      subscribers += 1;
      if (
        subscribers === 1 &&
        (revalidateOnSubscribe || store.state === pendingAdminRead || store.state.error !== null)
      ) {
        void refresh();
      }
      return () => {
        subscribers -= 1;
        subscription.unsubscribe();
      };
    },
    refresh,
    ensure() {
      if (pending) return pending;
      const { data, error } = store.state;
      return data !== null && error === null ? Promise.resolve(data) : refresh();
    },
    setData,
  };
}

export type AdminRead<T> = ReturnType<typeof createAdminRead<T>>;
export type AdminReadCache = Map<string, AdminRead<unknown>>;

export function getAdminRead<T>(
  cache: AdminReadCache,
  key: string,
  load: () => Promise<T>,
  revalidateOnSubscribe = false,
) {
  const existing = cache.get(key);
  if (existing) return existing as AdminRead<T>;
  const read = createAdminRead(load, revalidateOnSubscribe);
  cache.set(key, read as AdminRead<unknown>);
  return read;
}
