import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/commerce/portal";

export const Route = createFileRoute("/commerce/portal")({
  server: {
    handlers: {
      POST: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commercePortal(request)),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceBuyerMethodNotAllowed()),
    },
  },
});
