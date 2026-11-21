import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/webhook-proxy/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("webhookProxyDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
