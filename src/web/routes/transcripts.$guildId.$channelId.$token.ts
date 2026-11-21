import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = /^\/transcripts\/[^/]+\/[^/]+\/[^/]+$/;

export const Route = createFileRoute("/transcripts/$guildId/$channelId/$token")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () => context.haf.transcript(request, params)),
      ANY: serviceNotFound,
    },
  },
});
