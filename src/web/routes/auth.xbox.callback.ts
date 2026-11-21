import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/auth/xbox/callback";

export const Route = createFileRoute("/auth/xbox/callback")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.xboxLinkCallback(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
