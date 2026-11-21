import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = /^\/commerce\/support\/\d{2,24}$/;

export const Route = createFileRoute("/commerce/support/$guildId")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.commerceSupportPage(request, params.guildId),
        ),
      HEAD: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportMethodNotAllowed()),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.commerceSupportMethodNotAllowed()),
    },
  },
});
