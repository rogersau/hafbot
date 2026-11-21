import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = /^\/evidence-vault\/images\/[^/]+\/[^/]+$/;

export const Route = createFileRoute("/evidence-vault/images/$recordId/$imageId")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () => context.haf.evidenceImage(request, params)),
      ANY: serviceNotFound,
    },
  },
});
