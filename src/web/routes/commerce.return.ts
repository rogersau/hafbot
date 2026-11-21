import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/commerce/return";

export const Route = createFileRoute("/commerce/return")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceReturn(request)),
      HEAD: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceBuyerMethodNotAllowed()),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceBuyerMethodNotAllowed()),
    },
  },
});
