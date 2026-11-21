import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, rawGuildId } from "../service-route-path";

const path = /^\/ban-appeals\/[^/]+$/;

export const Route = createFileRoute("/ban-appeals/$guildId")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.banAppealPage(request, rawGuildId(request, params.guildId)),
        ),
      HEAD: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.banAppealMethodNotAllowed(request, rawGuildId(request, params.guildId)),
        ),
      ANY: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.banAppealMethodNotAllowed(request, rawGuildId(request, params.guildId)),
        ),
    },
  },
});
