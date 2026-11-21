import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/webhook-proxy/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("webhookProxyConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
