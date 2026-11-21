import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/terms";

export const Route = createFileRoute("/terms")({
  server: {
    handlers: {
      ANY: ({ context, request }) => onServicePath(request, path, () => context.haf.terms(request)),
    },
  },
});
