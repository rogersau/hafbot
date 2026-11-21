import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth")({
  server: {
    handlers: {
      ANY: ({ context, request }) => context.haf.auth(request),
    },
  },
});
