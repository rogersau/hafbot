import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/auth/xbox/start";

export const Route = createFileRoute("/auth/xbox/start")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.xboxLinkStart(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
