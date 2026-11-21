import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = /^\/commerce\/stores\/[^/]+$/;

export const Route = createFileRoute("/commerce/stores/$guildId")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () => context.haf.commerceStore(params.guildId)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
