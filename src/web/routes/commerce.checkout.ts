import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/commerce/checkout";

export const Route = createFileRoute("/commerce/checkout")({
  server: {
    handlers: {
      POST: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceCheckout(request)),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceBuyerMethodNotAllowed()),
    },
  },
});
