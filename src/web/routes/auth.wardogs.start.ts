import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/auth/wardogs/start";

export const Route = createFileRoute("/auth/wardogs/start")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.wardogsTrackerStart(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
