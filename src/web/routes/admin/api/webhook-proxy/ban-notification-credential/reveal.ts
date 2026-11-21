import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/webhook-proxy/ban-notification-credential/reveal")(
  {
    server: {
      handlers: {
        POST: handleAdminOperation("webhookProxyBanCredentialReveal.post"),
        ANY: handleUnknownAdminApiRequest,
      },
    },
  },
);
