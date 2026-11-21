import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = "/install";

export const Route = createFileRoute("/install")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.install(request)),
      HEAD: serviceNotFound,
      ANY: serviceNotFound,
    },
  },
});
