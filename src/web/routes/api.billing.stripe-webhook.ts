import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/billing/stripe-webhook")({
  server: {
    handlers: {
      POST: ({ context, request }) => context.haf.billingStripeWebhook(request),
      ANY: ({ context, request }) => context.haf.billingStripeWebhook(request),
    },
  },
});
