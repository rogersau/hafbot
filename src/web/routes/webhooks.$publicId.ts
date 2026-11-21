import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = /^\/webhooks\/[^/]+$/;

export const Route = createFileRoute("/webhooks/$publicId")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.webhookProbe("webhookProxy", 200)),
      POST: ({ context, params, request }) =>
        onServicePath(request, path, () => context.haf.webhookProxy(request, params.publicId)),
      OPTIONS: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.webhookProbe("webhookProxy", 204)),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.webhookProbe("webhookProxy", 405)),
    },
  },
});
