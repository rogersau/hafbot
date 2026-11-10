import type { EntitlementInfo } from "../hooks/use-entitlement";
import { parseAdminApiError, readJsonOrThrow } from "./api";

export interface AdminLoaderQuery {
  workspaceId?: string;
  guildId?: string;
  search?: Record<string, string | number | boolean | null | undefined>;
}

export interface AdminLoaderContext {
  abortController?: AbortController;
  params?: Record<string, string>;
  location?: { searchStr?: string };
  deps?: Record<string, unknown>;
  parentMatchPromise?: Promise<{ loaderData?: unknown }>;
  cause?: "preload" | "enter" | "stay";
}

export interface LoadedAdminRouteData<T> {
  data: T;
  loadedAt: number;
}

export interface AdminPostOptions {
  workspaceId?: string;
  guildId?: string;
  signal?: AbortSignal;
}

export interface AdminRouteTableRow<TResponse, TData = TResponse> {
  path: string;
  entitlementGate?: "attach" | "return-null-on-free";
  freeTierFallback?: (ctx: AdminLoaderContext, entitlement: EntitlementInfo | null) => TData;
  fetchErrorFallback?: (
    ctx: AdminLoaderContext,
    entitlement: EntitlementInfo | null,
    error: unknown,
  ) => TData;
  query?: (ctx: AdminLoaderContext) => AdminLoaderQuery;
  transform?: (
    response: TResponse,
    ctx: AdminLoaderContext,
    entitlement: EntitlementInfo | null,
  ) => TData;
}

export interface AdminLoaderClient {
  getJson<T>(path: string, query?: AdminLoaderQuery): Promise<T>;
  postJson<T>(
    path: string,
    body?: Record<string, unknown> | object,
    options?: AdminPostOptions,
  ): Promise<T>;
  loadRoute<TResponse, TData = TResponse>(
    row: AdminRouteTableRow<TResponse, TData>,
    ctx: AdminLoaderContext,
    resolveEntitlement: (
      ctx: AdminLoaderContext,
      guildId: string,
    ) => Promise<EntitlementInfo | null>,
  ): Promise<LoadedAdminRouteData<TData>>;
}

export function createAdminLoaderClient(signal?: AbortSignal): AdminLoaderClient {
  return {
    getJson<T>(path: string, query?: AdminLoaderQuery) {
      return readJsonOrThrow<T>(buildAdminLoaderPath(path, query), { signal });
    },

    async postJson<T>(
      path: string,
      body: Record<string, unknown> | object = {},
      options: AdminPostOptions = {},
    ): Promise<T> {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          ...(options.guildId ? { guildId: options.guildId } : {}),
        }),
        signal: options.signal ?? signal,
      });

      if (!response.ok) {
        throw await parseAdminApiError(response, `${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    },

    async loadRoute<TResponse, TData = TResponse>(
      row: AdminRouteTableRow<TResponse, TData>,
      ctx: AdminLoaderContext,
      resolveEntitlement: (
        ctx: AdminLoaderContext,
        guildId: string,
      ) => Promise<EntitlementInfo | null>,
    ): Promise<LoadedAdminRouteData<TData>> {
      const guildId = getGuildId(ctx);
      let entitlement: EntitlementInfo | null = null;

      if (row.entitlementGate) {
        entitlement = await resolveEntitlement(ctx, guildId);
        if (row.entitlementGate === "return-null-on-free" && entitlement?.tier === "free") {
          if (!row.freeTierFallback) {
            throw new Error(`${row.path} must provide freeTierFallback for free-tier fallback`);
          }
          return wrapLoaded(row.freeTierFallback(ctx, entitlement));
        }
      }

      const query = row.query ? row.query(ctx) : { workspaceId: getWorkspaceId(ctx), guildId };
      const client = createAdminLoaderClient(ctx.abortController?.signal);
      let response: TResponse;
      try {
        response = await client.getJson<TResponse>(row.path, query);
      } catch (error) {
        if (row.fetchErrorFallback) {
          return wrapLoaded(row.fetchErrorFallback(ctx, entitlement, error));
        }
        throw error;
      }

      const data = row.transform
        ? row.transform(response, ctx, entitlement)
        : (response as unknown as TData);
      return wrapLoaded(data);
    },
  };
}

export function buildAdminLoaderPath(path: string, query: AdminLoaderQuery = {}): string {
  const [pathname, search = ""] = path.split("?");
  const params = new URLSearchParams(search);
  const workspaceId = query.workspaceId?.trim();
  const guildId = query.guildId?.trim();

  if (workspaceId) params.set("workspaceId", workspaceId);
  if (guildId) params.set("guildId", guildId);
  for (const [key, value] of Object.entries(query.search ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }

  const nextSearch = params.toString();
  return nextSearch ? `${pathname}?${nextSearch}` : pathname;
}

export function wrapLoaded<T>(data: T): LoadedAdminRouteData<T> {
  return { data, loadedAt: Date.now() };
}

function getGuildId(ctx: AdminLoaderContext): string {
  return (ctx.params?.guildId ?? "").trim();
}

function getWorkspaceId(ctx: AdminLoaderContext): string {
  return new URLSearchParams(ctx.location?.searchStr ?? "").get("workspaceId")?.trim() ?? "";
}
