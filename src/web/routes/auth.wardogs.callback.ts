import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/auth/wardogs/callback";

export const Route = createFileRoute("/auth/wardogs/callback")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.wardogsTrackerCallback(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
