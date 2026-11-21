import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = /^\/commerce\/offers\/[^/]+$/;

export const Route = createFileRoute("/commerce/offers/$offeringId")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.commerceOffering(request, params.offeringId),
        ),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
