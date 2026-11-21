import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/commerce/stripe-webhook")({
  server: {
    handlers: {
      POST: ({ context, request }) => context.haf.commerceStripeWebhook(request),
      ANY: ({ context, request }) => context.haf.commerceStripeWebhook(request),
    },
  },
});
