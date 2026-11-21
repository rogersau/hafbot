import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/commerce/support/return";

export const Route = createFileRoute("/commerce/support/return")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportReturn(request)),
      HEAD: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportMethodNotAllowed()),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportMethodNotAllowed()),
    },
  },
});
