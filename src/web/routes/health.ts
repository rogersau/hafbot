import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/health";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      ANY: ({ context, request }) => onServicePath(request, path, () => context.haf.health()),
    },
  },
});
