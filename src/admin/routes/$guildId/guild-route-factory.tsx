import { useCallback, useState, type ComponentType } from "react";
import { createRoute } from "@tanstack/react-router";

import { buildGuildScopedViewInstanceKey } from "../../App";
import { AdminRouteErrorContent } from "../../components/admin-route-error";
import { PaidFeatureGate } from "../../components/paid-feature-gate";
import { getPaidAdminFeature } from "../../dashboard-routes";
import { useRouteInvalidation } from "../../hooks/use-route-invalidation";
import type { AdminLoaderContext, LoadedAdminRouteData } from "../../lib/admin-route-loaders";
import { Route as guildRoute } from "../$guildId";
import { createLazyAdminPage } from "../lazy-page";
import { useAdminRouteContext } from "../page-context";
import type { AdminRouterContext } from "../context";

type PageModule = Record<string, unknown>;

type BaseGuildPageProps<TExtraProps extends Record<string, unknown>> = {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: unknown;
  onRouteDataRefresh?: () => Promise<void>;
} & TExtraProps;

interface GuildRoutePageDeclaration {
  load: () => Promise<PageModule>;
  exportName: string;
}

interface GuildRouteFactoryConfig<TData, TExtraProps extends Record<string, unknown>> {
  path: string;
  loader: (ctx: AdminLoaderContext) => Promise<LoadedAdminRouteData<TData>>;
  page: GuildRoutePageDeclaration;
  extraProps?: (
    context: AdminRouterContext,
    loaderData: LoadedAdminRouteData<TData> | undefined,
  ) => TExtraProps;
  key?: (
    context: AdminRouterContext,
    loaderData: LoadedAdminRouteData<TData> | undefined,
  ) => string;
  useKey?: boolean;
  useInvalidation?: boolean;
  initialData?: false | ((loaderData: LoadedAdminRouteData<TData> | undefined) => unknown);
  validateSearch?: (search: unknown) => unknown;
  loaderDeps?: (opts: { search: unknown }) => Record<string, unknown>;
}

export function createGuildRoute<
  TData,
  TExtraProps extends Record<string, unknown> = Record<string, unknown>,
>(config: GuildRouteFactoryConfig<TData, TExtraProps>) {
  type PageProps = BaseGuildPageProps<TExtraProps>;

  const Page = createLazyAdminPage(
    config.page.load,
    config.page.exportName,
  ) as ComponentType<PageProps> & { preload: () => Promise<void> };

  const routeOptions = {
    getParentRoute: () => guildRoute,
    path: config.path,
    ...(config.validateSearch ? { validateSearch: config.validateSearch } : {}),
    loaderDeps: (options: { search: unknown }) => ({
      ...config.loaderDeps?.(options),
      workspaceId: (options.search as { workspaceId?: string }).workspaceId ?? "",
    }),
    loader: async (ctx: AdminLoaderContext) => {
      const loaderData = await config.loader(ctx);
      if (ctx.cause !== "preload") {
        void reportDashboardPage(config.path, ctx).catch(() => undefined);
      }
      // TanStack Router preloads route loaders on intent. Start the page import
      // after route data is available without making a chunk failure block data.
      void Page.preload().catch(() => undefined);
      return loaderData;
    },
    errorComponent: AdminRouteErrorContent,
    component: function GuildRouteComponent() {
      const context = useAdminRouteContext();
      const loaderData = Route.useLoaderData() as LoadedAdminRouteData<TData> | undefined;
      const loaderDeps = Route.useLoaderDeps();
      const invalidateRoute = config.useInvalidation === false ? undefined : useRouteInvalidation();
      const [refreshVersion, setRefreshVersion] = useState(0);
      const refreshRouteData = useCallback(async () => {
        await invalidateRoute?.();
        setRefreshVersion((version) => version + 1);
      }, [invalidateRoute]);

      const key =
        config.useKey === false
          ? undefined
          : config.key
            ? config.key(context, loaderData)
            : `${buildGuildScopedViewInstanceKey(
                context.selectedWorkspaceId,
                context.pathGuildId,
                refreshVersion,
              )}:${context.guildResourcesRefreshVersion}:${JSON.stringify(loaderDeps)}`;

      const extraProps = config.extraProps
        ? config.extraProps(context, loaderData)
        : ({} as TExtraProps);

      const initialDataProp =
        config.initialData === false
          ? {}
          : {
              initialData: config.initialData
                ? config.initialData(loaderData)
                : (loaderData?.data ?? null),
            };

      const invalidationProp =
        config.useInvalidation === false ? {} : { onRouteDataRefresh: refreshRouteData };

      const commonProps = {
        selectedWorkspaceId: context.selectedWorkspaceId,
        selectedGuildId: context.pathGuildId,
        ...initialDataProp,
        ...invalidationProp,
        ...extraProps,
      };

      const page =
        key !== undefined ? <Page key={key} {...commonProps} /> : <Page {...commonProps} />;
      const paidFeature = getPaidAdminFeature(`/admin/${config.path}`);
      return paidFeature && context.entitlement?.tier === "free" ? (
        <PaidFeatureGate feature={paidFeature} guildId={context.pathGuildId}>
          {page}
        </PaidFeatureGate>
      ) : (
        page
      );
    },
  };

  const Route = createRoute(routeOptions as never);

  return Route;
}

async function reportDashboardPage(path: string, ctx: AdminLoaderContext): Promise<void> {
  const guildId = ctx.params?.guildId?.trim();
  if (!guildId) return;
  const page = dashboardPage(path);
  const feature = dashboardFeature(path);
  const { crossCuttingClient } = await import("../../generated/admin-client/cross-cutting");
  await crossCuttingClient.createProductAnalyticsEvent({
    event: "page_viewed",
    workspaceId: ctx.params?.workspaceId?.trim() || undefined,
    guildId,
    page,
    feature,
  });
}

function dashboardPage(path: string) {
  if (path === "blocklist") return "reaction_rules" as const;
  if (path === "guild-settings") return "guild_settings" as const;
  if (path === "member-verification") return "member_verification" as const;
  if (path === "player-link") return "player_link" as const;
  if (path === "server-levels") return "server_levels" as const;
  if (path === "tickets" || path === "lfg") return path;
  return path === "overview" ? ("overview" as const) : ("other" as const);
}

function dashboardFeature(path: string) {
  if (path === "blocklist") return "reaction_rules" as const;
  if (path === "member-verification") return "member_verification" as const;
  if (path === "player-link") return "player_link" as const;
  if (path === "server-levels") return "server_levels" as const;
  if (path === "tickets" || path === "lfg") return path;
  return undefined;
}
