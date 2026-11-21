import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, rawGuildId } from "../service-route-path";

const path = /^\/api\/ban-appeals\/[^/]+$/;

export const Route = createFileRoute("/api/ban-appeals/$guildId")({
  server: {
    handlers: {
      POST: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.banAppealSubmission(request, rawGuildId(request, params.guildId)),
        ),
      ANY: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.banAppealMethodNotAllowed(request, rawGuildId(request, params.guildId)),
        ),
    },
  },
});
