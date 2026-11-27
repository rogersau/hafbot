import type { GuildDashboardPath } from "../admin/dashboard-routes";
import type { FileRoutesByFullPath } from "./routeTree.gen";

type RoutedGuildDashboardPath = {
  [Path in keyof FileRoutesByFullPath]: Path extends `/admin/$guildId/${infer Section}`
    ? Section extends ""
      ? never
      : `/admin/${Section}`
    : never;
}[keyof FileRoutesByFullPath];

type AssertRegistryMatchesRouter<Drift extends never> = Drift;

export type GuildDashboardRouteRegistry = AssertRegistryMatchesRouter<
  | Exclude<RoutedGuildDashboardPath, GuildDashboardPath>
  | Exclude<GuildDashboardPath, RoutedGuildDashboardPath>
>;
