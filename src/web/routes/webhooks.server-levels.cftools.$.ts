import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = /^\/webhooks\/server-levels\/cftools\//;

export const Route = createFileRoute("/webhooks/server-levels/cftools/$")({
  server: {
    handlers: {
      POST: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.serverLevelIngress(request)),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.serverLevelIngress(request)),
    },
  },
});
