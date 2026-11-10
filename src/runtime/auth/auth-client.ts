import { createAuthClient } from "better-auth/react";

const globalWindow = (globalThis as Record<string, unknown>)["window"] as
  | { location: { origin: string } }
  | undefined;

export const authClient = createAuthClient({
  baseURL: globalWindow?.location.origin,
});
