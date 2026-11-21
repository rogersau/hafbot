import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/interactions";

export const Route = createFileRoute("/interactions")({
  server: {
    handlers: {
      POST: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.interactions(request)),
      ANY: serviceNotFound,
    },
  },
});
