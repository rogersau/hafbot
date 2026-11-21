import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/commerce/support/checkout";

export const Route = createFileRoute("/commerce/support/checkout")({
  server: {
    handlers: {
      POST: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportCheckout(request)),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportMethodNotAllowed()),
    },
  },
});
