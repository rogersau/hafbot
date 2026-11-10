import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { AdminRouterContext } from "./context";

export const Route = createRootRouteWithContext<AdminRouterContext>()({
  component: () => <Outlet />,
});
