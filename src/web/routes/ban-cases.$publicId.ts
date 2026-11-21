import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = /^\/ban-cases\/[^/]+$/;

export const Route = createFileRoute("/ban-cases/$publicId")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.webhookProbe("banCases", 200)),
      POST: ({ context, params, request }) =>
        onServicePath(request, path, () => context.haf.banCaseWebhook(request, params.publicId)),
      OPTIONS: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.webhookProbe("banCases", 204)),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.webhookProbe("banCases", 405)),
    },
  },
});
