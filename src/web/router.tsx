import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";

import { routeTree } from "./routeTree.gen";
import type { WebRequestContext } from "./request-context";
import type { AdminDocumentData, WebRouterContext } from "./router-context";

export function getRouter() {
  const requestContext: WebRequestContext | undefined = getGlobalStartContext();
  const nonce = requestContext?.nonce;
  const context: WebRouterContext = {};

  const router = createRouter({
    routeTree,
    context,
    caseSensitive: true,
    defaultPreload: "intent",
    ssr: { nonce },
    dehydrate: (): { admin?: AdminDocumentData } => ({
      admin: router.state.matches.find((match) => match.routeId === "/admin")?.context.admin,
    }),
    hydrate: ({ admin: hydratedAdmin }: { admin?: AdminDocumentData }) => {
      context.admin = hydratedAdmin;
    },
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
