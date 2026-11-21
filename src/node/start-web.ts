import { resolve } from "node:path";
import type { WebRequestContext } from "../web/request-context";

interface StartEntry {
  fetch(request: Request, options: { context: WebRequestContext }): Promise<Response>;
}

const serverEntryPath = resolve("dist/server/server.js");
export async function fetchStart(request: Request, context: WebRequestContext): Promise<Response> {
  const { default: entry } = (await import(serverEntryPath)) as { default: StartEntry };
  return entry.fetch(request, { context });
}
