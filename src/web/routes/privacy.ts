import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/privacy";

export const Route = createFileRoute("/privacy")({
  server: {
    handlers: {
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.privacy(request)),
    },
  },
});
