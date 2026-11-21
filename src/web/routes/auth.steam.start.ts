import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/auth/steam/start";

export const Route = createFileRoute("/auth/steam/start")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.steamLinkStart(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
