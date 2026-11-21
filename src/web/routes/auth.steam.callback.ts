import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/auth/steam/callback";

export const Route = createFileRoute("/auth/steam/callback")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.steamLinkCallback(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
