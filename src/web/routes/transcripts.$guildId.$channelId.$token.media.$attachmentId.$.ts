import { createFileRoute } from "@tanstack/react-router";
import { onServicePath, serviceNotFound } from "../service-route-path";

const path = /^\/transcripts\/[^/]+\/[^/]+\/[^/]+\/media\/[^/]+\/.+$/;

export const Route = createFileRoute(
  "/transcripts/$guildId/$channelId/$token/media/$attachmentId/$",
)({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.transcriptMedia(request, { ...params, filename: params._splat ?? "" }),
        ),
      ANY: serviceNotFound,
    },
  },
});
