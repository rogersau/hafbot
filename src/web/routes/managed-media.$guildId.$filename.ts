import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = /^\/managed-media\/[^/]+\/[^/]+$/;

export const Route = createFileRoute("/managed-media/$guildId/$filename")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () => context.haf.managedMedia(request, params)),
      ANY: serviceNotFound,
    },
  },
});
